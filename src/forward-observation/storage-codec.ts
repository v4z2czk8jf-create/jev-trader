import { gzipSync, gunzipSync } from "node:zlib";
import { hash } from "./config";

const pack = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value)), { level: 6 }).toString("base64");
const unpack = (value: string) => JSON.parse(gunzipSync(Buffer.from(value, "base64"), { maxOutputLength: 64 * 1024 ** 2 }).toString("utf8"));
/** Lossless storage encoding only; the original logical payload and its SHA256 do not change.
 * Individual records retain order, IDs, timestamps and provenance, including re-observations.
 */
export function encodeBatch(payload: string) {
  const b = JSON.parse(payload);
  return JSON.stringify({ encoding: "gzip-records-v1", sha256: hash(payload),
    metadata: pack({ ...b, records: null, checkpoint: null }), checkpoint: pack(b.checkpoint),
    records: b.records.map((r: any) => ({ stream: r.stream, data: pack(r) })) });
}
export function decodeBatch(text: string) {
  const w = JSON.parse(text); let payload: string;
  if (w.encoding === undefined) payload = w.payload;
  else {
    if (w.encoding !== "gzip-records-v1") throw Error("UNSUPPORTED_STORAGE_CODEC");
    const b = unpack(w.metadata); b.checkpoint = unpack(w.checkpoint);
    b.records = w.records.map((r: any) => { const value = unpack(r.data); if (value.stream !== r.stream) throw Error("STREAM_MISMATCH"); return value; });
    payload = JSON.stringify(b);
  }
  if (typeof payload !== "string" || hash(payload) !== w.sha256) throw Error("CHECKSUM_FAILURE");
  return { payload, sha256: w.sha256, batch: JSON.parse(payload) };
}
/** Exact physical JSON fragments per stream; remaining wrapper punctuation belongs to shared.
 * Logical bytes are reported separately; compression is not confused with fewer observations.
 */
export function batchBytes(text: string) {
  const w = JSON.parse(text), { batch } = decodeBatch(text), physical: Record<string, number> = {}, logical: Record<string, number> = {};
  for (const r of batch.records) logical[r.stream] = (logical[r.stream] ?? 0) + Buffer.byteLength(JSON.stringify(r));
  if (w.encoding === "gzip-records-v1") {
    for (const r of w.records) physical[r.stream] = (physical[r.stream] ?? 0) + Buffer.byteLength(JSON.stringify(r));
    physical.checkpoint = Buffer.byteLength(JSON.stringify(w.checkpoint));
  }
  const total = Buffer.byteLength(text); physical.shared = total - Object.values(physical).reduce((a,b)=>a+b,0);
  return { total, physical, logical, checkpointLogical: Buffer.byteLength(JSON.stringify(batch.checkpoint)) };
}
