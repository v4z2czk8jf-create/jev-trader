import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { hash, PLAN } from "./config";

/** Separate campaign storage. No pruning, replacement, collector or resume side effects. */
export class ForwardArchive {
  private bytes = 0;
  private stopped = false;
  private busy = false;
  private seen = new Map<string, string>();
  private constructor(readonly directory: string, readonly limit: number) {}
  static async create(parent: string, campaignId: string, limit = PLAN.capacityBytes) {
    if (!/^[a-z0-9-]+$/.test(campaignId) || !Number.isSafeInteger(limit) || limit <= 0) throw Error("INVALID_ARCHIVE");
    await mkdir(parent, { recursive: true });
    const dir = join(parent, campaignId); await mkdir(dir); // EEXIST refuses overwrite/resume
    return new ForwardArchive(dir, limit);
  }
  status(externalBytes = 0) { return { bytes: this.bytes, externalBytes, totalBytes: this.bytes + externalBytes,
    warning80: this.bytes + externalBytes >= this.limit * PLAN.warningRatio, stopped: this.stopped, records: this.seen.size }; }
  async append(stream: string, id: string, record: unknown, externalBytes = 0) {
    if (this.stopped || this.busy) throw Error("ARCHIVE_STOPPED_OR_CONCURRENT_WRITE");
    if (!/^[a-z0-9-]+$/.test(stream) || !id || !Number.isSafeInteger(externalBytes) || externalBytes < 0) throw Error("INVALID_RECORD");
    const payload = JSON.stringify({ id, record }), digest = hash(payload), key = `${stream}:${id}`;
    if (this.seen.has(key)) {
      if (this.seen.get(key) !== digest) { this.stopped = true; throw Error("RECORD_CONFLICT"); }
      return { duplicate: true, ...this.status(externalBytes) };
    }
    const line = JSON.stringify({ sha256: digest, payload }) + "\n", bytes = Buffer.byteLength(line);
    if (this.bytes + externalBytes + bytes > this.limit) { this.stopped = true; throw Error("CAPACITY_STOP_DATA_PRESERVED"); }
    this.busy = true;
    try {
      const file = await open(join(this.directory, `${stream}.jsonl`), "a+");
      try {
        const offset = (await file.stat()).size;
        await file.writeFile(line); await file.sync();
        const check = Buffer.alloc(bytes); const read = await file.read(check, 0, bytes, offset);
        if (read.bytesRead !== bytes || check.toString("utf8") !== line) throw Error("CHECKSUM_FAILURE");
      } finally { await file.close(); }
      this.bytes += bytes; this.seen.set(key, digest);
      return { duplicate: false, ...this.status(externalBytes) };
    } catch (e) { this.stopped = true; throw e; }
    finally { this.busy = false; }
  }
}
