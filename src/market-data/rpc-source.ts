import { appendFile, mkdir, readFile, stat, open, unlink } from "node:fs/promises";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { TRADE_TOPIC0 } from "../trades";
import type { History, Print } from "./types";
import { HistoryStore, compactHistory, RAW_LIMIT_BYTES, type Checkpoint } from "./history-store";

const READ_METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getLogs", "eth_call"]);
export type Rpc = (method: string, params: unknown[]) => Promise<any>;
export function publicRpc(url = "https://rpc.monad.xyz", transport: (url: string, init: RequestInit) => Promise<Response> = fetch): Rpc {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password || u.search) throw Error("Public HTTPS RPC without embedded credentials required");
  let next = 0, id = 0;
  return async (method, params) => {
    if (!READ_METHODS.has(method)) throw Error("RPC method is not read-only allowlisted");
    const wait = next - Date.now(); if (wait > 0) await Bun.sleep(wait);
    next = Date.now() + 150; // <= 6.7 extra calls/s, serial, no request burst
    const requestId = ++id;
    const response = await transport(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error(`Public RPC HTTP ${response.status}`);
    const body = await response.json() as any;
    if (body.id !== requestId || body.error || body.result == null) throw Error(`Invalid/failed read-only RPC ${method}`);
    return body.result;
  };
}
const hex = (n: number) => "0x" + n.toString(16);
const number = (s: unknown): number => {
  if (typeof s !== "string" || !/^0x[0-9a-f]+$/i.test(s)) throw Error("Invalid hex quantity");
  const n = Number(BigInt(s)); if (!Number.isSafeInteger(n) || n < 0) throw Error("Unsafe quantity"); return n;
};
interface Header { number: number; timestamp: number; hash: string }
export interface Chunk {
  version: 1; market: string; sizeDecimals: number;
  fromBlock: number; throughBlock: number; fromTimestamp: number; throughTimestamp: number;
  endHash: string; receivedTimestamp: number; trades: Print[];
}
/** Optional storage backend only; default Phase A/B/C semantics and caps stay unchanged. */
export interface HistoryStorageOptions {
  rawLimitBytes: number;
  maxChunkBytes: number;
  maxRetainedBytes: number;
  restore(path: string, checkpoint: Checkpoint | null): Promise<{ bytes: number; checkpoint: Checkpoint | null }>;
}
export function validateCachedChunk(c: Chunk, market: string, previous?: Chunk) {
  if (c.version !== 1 || c.market.toLowerCase() !== market.toLowerCase() || !Number.isInteger(c.sizeDecimals) || c.sizeDecimals < 0 || c.sizeDecimals > 30 ||
    !Number.isInteger(c.fromBlock) || c.fromBlock < 1 || !Number.isInteger(c.throughBlock) || c.throughBlock < c.fromBlock || c.throughBlock-c.fromBlock >= 100 ||
    !Number.isFinite(c.fromTimestamp) || !Number.isFinite(c.throughTimestamp) || c.throughTimestamp<c.fromTimestamp ||
    !Number.isFinite(c.receivedTimestamp) || !/^0x[0-9a-f]{64}$/i.test(c.endHash) || !Array.isArray(c.trades) ||
    previous && (c.fromBlock!==previous.throughBlock+1 || c.fromTimestamp!==previous.throughTimestamp || c.sizeDecimals!==previous.sizeDecimals)) throw Error("Invalid, gapped or mismatched history cache");
  const ids=new Set<string>();
  for(const t of c.trades){
    if(!Number.isFinite(t.price)||t.price<=0||!Number.isFinite(t.volume)||t.volume<0||t.block<c.fromBlock||t.block>c.throughBlock||
      !Number.isFinite(t.timestamp)||t.timestamp<c.fromTimestamp||t.timestamp>c.throughTimestamp||ids.has(t.id))throw Error("Invalid cached trade");
    ids.add(t.id);
  }
}
export function decodeLogs(raw: unknown, market: string, sizeDecimals: number, from: number, to: number, start: number, end: number): Print[] {
  if (!Array.isArray(raw)) throw Error("Invalid logs response");
  const ids = new Set<string>();
  return raw.map(log => {
    if (!log || log.removed || log.address?.toLowerCase() !== market.toLowerCase() || log.topics?.[0]?.toLowerCase() !== TRADE_TOPIC0 || !/^0x[0-9a-f]{512}$/i.test(log.data)) throw Error("Invalid market trade log");
    const block = number(log.blockNumber), index = number(log.logIndex), timestamp = number(log.blockTimestamp) * 1000;
    if (block < from || block > to || timestamp < start || timestamp > end) throw Error("Log outside verified coverage or timestamp missing");
    const word = (i: number) => BigInt("0x" + log.data.slice(2 + i * 64, 2 + (i + 1) * 64));
    const price = Number(ethers.utils.formatUnits(word(3).toString(), 18));
    const volume = Number(ethers.utils.formatUnits(word(7).toString(), sizeDecimals));
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(volume) || volume < 0 || word(2) > 1n) throw Error("Invalid price, volume or side");
    const id = `${block}:${index}`;
    if (ids.has(id)) throw Error("Duplicate log in RPC response"); ids.add(id);
    return { id, block, timestamp, price, volume };
  }).sort((a, b) => a.block - b.block || Number(a.id.split(":")[1]) - Number(b.id.split(":")[1]));
}

/** Persistent public Trade index. Never touches the trader's feed or draining queues. */
export class KuruHistorySource {
  private readonly path: string;
  private loaded = false;
  private sizeDecimals: number | null = null;
  private lastBlock = 0;
  private lastHash = "";
  private from = 0;
  private through = 0;
  private received = 0;
  private prints: Print[] = [];
  private closed: History["closed"];
  private rawFromTimestamp: number | undefined;
  private store: HistoryStore;
  private cacheBytes=0;
  private error: string | null = "History not loaded";
  private nextRefresh = 0;
  private pending: Promise<void> | null = null;
  readonly source: string;
  constructor(readonly market: string, private readonly rpc: Rpc = publicRpc(), private readonly directory = "data/market-data", private readonly storageOptions?: HistoryStorageOptions) {
    if (!/^0x[0-9a-f]{40}$/i.test(market)) throw Error("Market address required");
    this.path = `${directory}/143-${market.toLowerCase()}.jsonl`;
    this.store = new HistoryStore(directory,market);
    this.source = `monad:143:kuru:${market.toLowerCase()}:finalized-Trade`;
  }
  history(): History { return { market: this.market, source: this.source, fromTimestamp: this.from, throughTimestamp: this.through, receivedTimestamp: this.received, trades: [...this.prints], error: this.error, closed:this.closed, rawFromTimestamp:this.rawFromTimestamp }; }
  storage(){return {rawBytes:this.cacheBytes,rawLimitBytes:this.storageOptions?.rawLimitBytes??RAW_LIMIT_BYTES,retainedRawPrints:this.prints.length,ohlcvTargetDays:60};}
  async refresh(maxRanges = 8, progress?: (ranges: number, through: number) => void): Promise<void> {
    if (!Number.isInteger(maxRanges) || maxRanges < 1 || maxRanges > 1200) throw Error("Bounded range limit required");
    if (this.pending) return this.pending;
    if (Date.now() < this.nextRefresh) return;
    this.pending = this.lockedSync(maxRanges, progress).catch((e: unknown) => {
      // No stale-success fallback on acquisition failure.
      this.error = e instanceof Error ? e.message : "History acquisition failed";
    }).finally(() => { this.nextRefresh = Date.now() + 5000; this.pending = null; });
    return this.pending;
  }
  private async lockedSync(maxRanges:number,progress?: (ranges:number,through:number)=>void){
    await mkdir(this.directory,{recursive:true});
    const path=this.path+".writer.lock",handle=await open(path,"wx");
    try{await handle.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now()}));await this.sync(maxRanges,progress);}
    finally{await handle.close();await unlink(path);}
  }
  private async header(tag: string): Promise<Header> {
    const r = await this.rpc("eth_getBlockByNumber", [tag, false]);
    const h = { number: number(r.number), timestamp: number(r.timestamp) * 1000, hash: r.hash };
    if (!/^0x[0-9a-f]{64}$/i.test(h.hash) || h.timestamp > Date.now() + 1000) throw Error("Invalid block header");
    return h;
  }
  private async load() {
    if (this.loaded) return;
    if(this.storageOptions){
      const result=await this.storageOptions.restore(this.path,await this.store.load(this.market));
      this.cacheBytes=result.bytes;const c=result.checkpoint;
      if(c){this.lastBlock=c.block;this.lastHash=c.hash;this.sizeDecimals=c.sizeDecimals;
        const h=c.history;this.from=h.fromTimestamp;this.through=h.throughTimestamp;this.received=h.receivedTimestamp;
        this.prints=h.trades;this.closed=h.closed;this.rawFromTimestamp=h.rawFromTimestamp;}
      this.loaded=true;return;
    }
    let text = "";
    try { if ((await stat(this.path)).size > 64 * 1024 * 1024) throw Error("History cache exceeds v1 64MiB bound; archive required"); text = await readFile(this.path, "utf8"); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
    this.cacheBytes=Buffer.byteLength(text);
    const checkpoint=await this.store.load(this.market);
    if(checkpoint){
      const tail=text.trim().split("\n").at(-1);
      if(!tail||JSON.parse(tail).throughBlock!==checkpoint.block)throw Error("Raw/checkpoint boundary mismatch; recovery review required; data preserved");
      this.lastBlock=checkpoint.block;this.lastHash=checkpoint.hash;this.sizeDecimals=checkpoint.sizeDecimals;
      const h=checkpoint.history;this.from=h.fromTimestamp;this.through=h.throughTimestamp;this.received=h.receivedTimestamp;
      this.prints=h.trades;this.closed=h.closed;this.rawFromTimestamp=h.rawFromTimestamp;this.loaded=true;return;
    }
    const chunks: Chunk[] = text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    let previous: Chunk | undefined;
    const prints: Print[] = [];
    for (const c of chunks) {
      validateCachedChunk(c, this.market, previous);
      for(const t of c.trades)prints.push(t);
      previous = c;
    }
    if (previous) {
      this.lastBlock = previous.throughBlock; this.lastHash = previous.endHash;
      this.sizeDecimals = previous.sizeDecimals; this.from = chunks[0]!.fromTimestamp; this.through = previous.throughTimestamp;
      this.received = previous.receivedTimestamp; this.prints = prints;
    }
    this.loaded = true;
  }
  private async firstBlock(head: Header, target: number): Promise<Header> {
    let distance = 1000, low = await this.header(hex(Math.max(1, head.number - distance)));
    while (low.timestamp >= target && low.number > 1) { distance *= 2; low = await this.header(hex(Math.max(1, head.number - distance))); }
    let high = head;
    while (high.number - low.number > 1) {
      const mid = await this.header(hex(Math.floor((low.number + high.number) / 2)));
      if (mid.timestamp < target) low = mid; else high = mid;
    }
    return high;
  }
  private async sync(maxRanges: number, progress?: (ranges: number, through: number) => void) {
    if(this.loaded && (await stat(this.path)).size!==this.cacheBytes)throw Error("Raw cache changed by another writer; reload required");
    await this.load();
    if (number(await this.rpc("eth_chainId", [])) !== 143) throw Error("Wrong chain");
    const head = await this.header("finalized");
    if (Date.now() - head.timestamp > 60_000) throw Error("Finalized head is delayed");
    if (this.lastBlock) {
      if (head.number < this.lastBlock || (await this.header(hex(this.lastBlock))).hash !== this.lastHash) throw Error("Finalized checkpoint mismatch; manual review required");
    }
    const iface = new ethers.utils.Interface(OrderBookAbi.abi);
    const raw = await this.rpc("eth_call", [{ to: this.market, data: iface.encodeFunctionData("getMarketParams", []) }, hex(head.number)]);
    const precision = Number(iface.decodeFunctionResult("getMarketParams", raw)[1].toString());
    const decimals = Math.log10(precision);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30 || this.sizeDecimals !== null && this.sizeDecimals !== decimals) throw Error("Invalid or changed size precision");
    this.sizeDecimals = decimals;
    let fromBlock = this.lastBlock + 1;
    if (!this.lastBlock) {
      const fourHours = 14_400_000;
      const first = await this.firstBlock(head, Math.floor(head.timestamp / fourHours) * fourHours - fourHours);
      fromBlock = first.number; this.from = first.timestamp; this.through = first.timestamp;
    }
    for (let i = 0; i < maxRanges && fromBlock <= head.number; i++) {
      if (this.prints.length > 200_000) throw Error("History trade bound reached; archive required");
      const to = Math.min(fromBlock + 99, head.number), end = await this.header(hex(to));
      const logs = await this.rpc("eth_getLogs", [{ address: this.market, topics: [TRADE_TOPIC0], fromBlock: hex(fromBlock), toBlock: hex(to) }]);
      const trades = decodeLogs(logs, this.market, decimals, fromBlock, to, this.through, end.timestamp);
      if(this.storageOptions&&(this.prints.length+trades.length>200_000||
        Buffer.byteLength(JSON.stringify(this.prints))+Buffer.byteLength(JSON.stringify(trades))>this.storageOptions.maxRetainedBytes)){
        const bounded=compactHistory({...this.history(),error:null});this.prints=bounded.trades;this.closed=bounded.closed;this.rawFromTimestamp=bounded.rawFromTimestamp;
        if(this.prints.length+trades.length>200_000)throw Error("History active4h trade bound reached; data preserved");
        if(Buffer.byteLength(JSON.stringify(this.prints))+Buffer.byteLength(JSON.stringify(trades))>this.storageOptions.maxRetainedBytes)throw Error("History retained-byte memory capacity; data preserved");
      }
      const receivedTimestamp = Date.now();
      const c: Chunk = { version: 1, market: this.market, sizeDecimals: decimals, fromBlock, throughBlock: to, fromTimestamp: this.through,
        throughTimestamp: end.timestamp, endHash: end.hash, receivedTimestamp, trades };
      await mkdir(this.directory, { recursive: true });
      const line=JSON.stringify(c)+"\n",bytes=Buffer.byteLength(line);
      if(this.storageOptions&&bytes>this.storageOptions.maxChunkBytes)throw Error("Raw chunk memory capacity reached; data preserved");
      if(this.cacheBytes+bytes>(this.storageOptions?.rawLimitBytes??RAW_LIMIT_BYTES))throw Error("Raw cache capacity reached; data preserved; explicit archive required");
      await appendFile(this.path, line); this.cacheBytes+=bytes;
      this.prints.push(...trades); this.through = end.timestamp; this.received = receivedTimestamp; this.lastBlock = to; this.lastHash = end.hash;
      fromBlock = to + 1;
      if ((i + 1) % 25 === 0) progress?.(i + 1, this.through);
    }
    const compact=compactHistory({...this.history(),error:null});
    await this.store.save({version:1,market:this.market,block:this.lastBlock,hash:this.lastHash,sizeDecimals:decimals,history:compact});
    this.prints=compact.trades;this.closed=compact.closed;this.rawFromTimestamp=compact.rawFromTimestamp;
    this.error = null;
  }
}
