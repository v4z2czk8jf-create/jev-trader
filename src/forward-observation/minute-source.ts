import { open } from "node:fs/promises";
import type { History } from "../market-data/types";
import type { SavedSRChunk } from "../market-data/important-sr-replay";
import { MARKET, hash } from "./config";
import { scanRaw } from "./raw-storage";
import { STORAGE } from "./storage-policy";

/** Incremental reader for this campaign's own existing KuruHistorySource raw file.
 * Read after refresh, before observing. Acknowledge only after durable price records.
 * It reuses normalized trades; no alternate candle/indicator engine or RPC exists here.
 */
export class MinuteSource {
  private offset = 0;
  private pending = "";
  private previous: SavedSRChunk | null = null;
  private history: History | null = null;
  private retainedBytes=0;
  constructor(readonly path: string) {}
  checkpoint() { return structuredClone({ offset: this.offset, pending: this.pending, previous: this.previous, history: this.history }); }
  static restore(path: string, state: ReturnType<MinuteSource["checkpoint"]>) {
    if (!Number.isSafeInteger(state.offset) || state.offset < 0) throw Error("INVALID_MINUTE_CHECKPOINT");
    const s = new MinuteSource(path); Object.assign(s, structuredClone(state));
    s.retainedBytes=Buffer.byteLength(JSON.stringify(s.history?.trades??[]));
    if(s.retainedBytes>STORAGE.retainedTradeBytes||(s.history?.trades.length??0)>STORAGE.retainedPrints)throw Error("MINUTE_CHECKPOINT_MEMORY_BOUND");return s;
  }
  async read() {
    const start = this.offset;
    // Re-read any incomplete suffix, but never allocate the complete unread file.
    const scan=await scanRaw(this.path,line=>{
      const c = JSON.parse(line.toString("utf8")) as SavedSRChunk, p = this.previous;
      if (c.version !== 1 || c.market.toLowerCase() !== MARKET.contract.toLowerCase() || c.sizeDecimals !== 10 ||
        ![c.fromTimestamp, c.throughTimestamp, c.receivedTimestamp, c.fromBlock, c.throughBlock].every(Number.isSafeInteger) ||
        c.fromTimestamp > c.throughTimestamp || c.throughTimestamp > c.receivedTimestamp || c.throughBlock < c.fromBlock ||
        p && (c.fromTimestamp !== p.throughTimestamp || c.fromBlock !== p.throughBlock + 1 || c.receivedTimestamp < p.receivedTimestamp)) throw Error("RAW_IDENTITY_CLOCK_OR_GAP");
      const ids = new Set<string>();
      for (const t of c.trades) {
        if (ids.has(t.id) || ![t.timestamp, t.price, t.volume, t.block].every(Number.isFinite) ||
          t.timestamp < c.fromTimestamp || t.timestamp > c.throughTimestamp || t.block < c.fromBlock || t.block > c.throughBlock || t.price <= 0 || t.volume < 0) throw Error("INVALID_RAW_TRADE");
        ids.add(t.id);
      }
      this.history ??= { market: c.market, source: `monad:143:kuru:${c.market.toLowerCase()}:finalized-Trade`, fromTimestamp: c.fromTimestamp,
        throughTimestamp: c.fromTimestamp, receivedTimestamp: c.receivedTimestamp, trades: [], error: null };
      if(this.history.trades.length+c.trades.length>STORAGE.retainedPrints)throw Error("MINUTE_UNACKNOWLEDGED_PRINT_BOUND_DATA_PRESERVED");
      this.retainedBytes+=Buffer.byteLength(JSON.stringify(c.trades));if(this.retainedBytes>STORAGE.retainedTradeBytes)throw Error("MINUTE_MEMORY_CAPACITY_DATA_PRESERVED");
      this.history.trades.push(...c.trades); this.history.throughTimestamp = c.throughTimestamp;
      this.history.receivedTimestamp = c.receivedTimestamp; this.previous = {...c,trades:[]};
    },null,start-Buffer.byteLength(this.pending));
    this.offset=scan.bytes;this.pending=scan.pending.toString("utf8");
    return { history: structuredClone(this.history), sourceRecordId: `${this.path}:${start}-${this.offset}:${scan.sha256}`,
      bytesRead: scan.bytes-start, pendingBytes: scan.pending.length };
  }
  acknowledge(end: number) {
    if (!this.history || end % 60000 || end > this.history.throughTimestamp || end < (this.history.rawFromTimestamp ?? this.history.fromTimestamp)) throw Error("INVALID_MINUTE_ACK");
    this.history.trades = this.history.trades.filter(t => t.timestamp >= end);
    this.history.rawFromTimestamp = end;
    this.retainedBytes=Buffer.byteLength(JSON.stringify(this.history.trades));
  }
}
