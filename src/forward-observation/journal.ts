import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, PLAN } from "./config";
import { encodeBatch, decodeBatch } from "./storage-codec";

export interface JournalRecord { stream: string; id: string; value: unknown }
export function checkBatchSize(logicalBytes:number,physicalBytes=0){
  if(logicalBytes>32*1024**2||physicalBytes>32*1024**2)throw Error("BATCH_MEMORY_CAP_DATA_PRESERVED");
}
export async function footprint(dir: string, excludeJournal=false): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if(excludeJournal&&e.name==="journal")continue;
    if (e.isSymbolicLink()) throw Error("SYMLINK_STORAGE_REFUSED");
    if (e.isDirectory()) { const s = await footprint(join(dir, e.name)); bytes += s.bytes; files += s.files; }
    else { bytes += (await stat(join(dir, e.name))).size; files++; }
  }
  return { bytes, files };
}
export async function exclusiveVerified(path: string, text: string) {
  const f = await open(path, "wx");
  try { await f.writeFile(text); await f.sync(); } finally { await f.close(); }
  if (hash(await readFile(path)) !== hash(text)) throw Error("CHECKSUM_FAILURE");
}

/** Immutable atomic batches: records and next controller/checkpoint are one commit.
 * Unpublished .pending files are preserved but never treated as committed observations.
 * Every restart rebuilds dedup IDs from the checksum-verified chain, not a mutable index.
 */
export class CampaignJournal<S> {
  private seq = 0;
  private head: string | null = null;
  private seen = new Map<string, string>();
  private latest: S | null = null;
  private busy = false;
  private stopped = false;
  // Immutable journal has a single locked writer. Rebuilt from disk at startup/resume;
  // normal commits verify only new bytes and update this count after atomic publication.
  private journalSize={bytes:0,files:0};
  readonly recoveredPending: string[] = [];
  private constructor(readonly directory: string, readonly limit: number) {}
  static async create<S>(parent: string, id: string, limit = PLAN.capacityBytes) {
    if (!/^[a-z0-9-]+$/.test(id) || !Number.isSafeInteger(limit) || limit <= 0) throw Error("INVALID_CAMPAIGN_ARCHIVE");
    await mkdir(parent, { recursive: true }); const directory = join(parent, id); await mkdir(directory);
    await mkdir(join(directory, "journal"));
    return new CampaignJournal<S>(directory, limit);
  }
  static async resume<S>(directory: string, limit = PLAN.capacityBytes) {
    const j = new CampaignJournal<S>(directory, limit);
    const names = (await readdir(join(directory, "journal"))).sort();
    j.recoveredPending.push(...names.filter(n => n.endsWith(".pending")));
    for (const name of names.filter(n => n.endsWith(".json"))) {
      const wrapped = decodeBatch(await readFile(join(directory, "journal", name), "utf8"));
      const b = wrapped.batch;
      if (b.version !== 1 || b.sequence !== j.seq + 1 || b.previousHash !== j.head || name !== `${String(b.sequence).padStart(8, "0")}.json`) throw Error("CHECKPOINT_CHAIN_FAILURE");
      for (const r of b.records as JournalRecord[]) {
        const k = `${r.stream}:${r.id}`; if (j.seen.has(k)) throw Error("DUPLICATE_COMMITTED_RECORD");
        j.seen.set(k, hash(JSON.stringify(r.value)));
      }
      j.seq = b.sequence; j.head = wrapped.sha256; j.latest = b.checkpoint;
    }
    j.journalSize=await footprint(join(directory,"journal"));
    return j;
  }
  checkpoint(): S | null { return structuredClone(this.latest); }
  async writeArtifact(name:string,text:string){
    if(this.busy||this.stopped)throw Error("JOURNAL_STOPPED_OR_BUSY");
    try{
      if(!/^[a-zA-Z0-9._-]+$/.test(name)||name==="."||name==="..")throw Error("INVALID_ARTIFACT_NAME");
      if((await this.status()).bytes+Buffer.byteLength(text)>this.limit)throw Error("CAPACITY_STOP_DATA_PRESERVED");
      await exclusiveVerified(join(this.directory,name),text);
    }catch(e){this.stopped=true;throw e;}
  }
  async status() { const external = await footprint(this.directory,true);
    const size={bytes:external.bytes+this.journalSize.bytes,files:external.files+this.journalSize.files};return { ...size, sequence: this.seq,
    recordCount: this.seen.size, headHash: this.head, warning80: size.bytes >= this.limit * PLAN.warningRatio, stopped: this.stopped }; }
  async commit(records: JournalRecord[], checkpoint: S) {
    if (this.busy || this.stopped) throw Error("JOURNAL_STOPPED_OR_BUSY"); this.busy = true;
    try {
      const additions: JournalRecord[] = [], pending = new Map<string, string>();
      for (const r of records) {
        if (!/^[a-z0-9-]+$/.test(r.stream) || !r.id) throw Error("INVALID_RECORD");
        const k = `${r.stream}:${r.id}`, h = hash(JSON.stringify(r.value)), previous = this.seen.get(k) ?? pending.get(k);
        if (previous && previous !== h) throw Error("RECORD_CONFLICT");
        if (!previous) { pending.set(k, h); additions.push(r); }
      }
      const {bytes,files}=await this.status(),before={bytes,files};
      const payload = JSON.stringify({ version: 1, sequence: this.seq + 1, previousHash: this.head, records: additions,
        checkpoint, storageBefore: before, identifiersAdded: [...pending.keys()] });
      checkBatchSize(Buffer.byteLength(payload));
      const digest = hash(payload), text = encodeBatch(payload);
      checkBatchSize(0,Buffer.byteLength(text));
      if (before.bytes + Buffer.byteLength(text) > this.limit) throw Error("CAPACITY_STOP_DATA_PRESERVED");
      const dest = join(this.directory, "journal", `${String(this.seq + 1).padStart(8, "0")}.json`);
      const tmp = join(this.directory, "journal", `${randomUUID()}.pending`);
      await exclusiveVerified(tmp, text);
      try { await stat(dest); throw Error("COMMIT_ALREADY_EXISTS"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      await rename(tmp, dest); // one atomic publication; never replace an existing committed file
      this.journalSize.bytes+=Buffer.byteLength(text);this.journalSize.files++;
      this.seq++; this.head = digest; this.latest = structuredClone(checkpoint);
      for (const [k, h] of pending) this.seen.set(k, h);
      return { added: additions.length, suppressed: records.length - additions.length, ...(await this.status()) };
    } catch (e) { this.stopped = true;
      // Failure-only reconciliation includes preserved unpublished files; never continue writing.
      try{this.journalSize=await footprint(join(this.directory,"journal"));}catch{}
      throw e;
    } finally { this.busy = false; }
  }
}

/** Read-only liveness check only for a lock belonging to this exact new campaign.
 * Never signal/terminate a process. Dead locks are renamed, not deleted.
 */
export async function campaignLock(directory: string) {
  const path = join(directory, "writer.lock"), token = randomUUID();
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw Error("INVALID_WRITER_LOCK");
    let alive = true;
    try { process.kill(previous.pid, 0); } catch (e: any) { if (e.code === "ESRCH") alive = false; else throw e; }
    if (alive) throw Error("CAMPAIGN_ALREADY_RUNNING_OR_PID_REUSED");
    await rename(path, join(directory, `dead-lock-${token}.json`));
  } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  const lockText=JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
  if((await footprint(directory)).bytes+Buffer.byteLength(lockText)>PLAN.capacityBytes)throw Error("CAPACITY_LOCK_STOP_DATA_PRESERVED");
  await exclusiveVerified(path, lockText);
  return async () => {
    const actual = JSON.parse(await readFile(path, "utf8")); if (actual.token !== token) throw Error("LOCK_CHANGED");
    await rename(path, join(directory, `closed-lock-${token}.json`));
  };
}
