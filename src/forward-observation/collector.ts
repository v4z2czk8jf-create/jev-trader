import { mkdir, readFile, open, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { KuruHistorySource, publicRpc, type Rpc } from "../market-data/rpc-source";
import { BookSource } from "../market-data/book-source";
import { SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS } from "../book";
import { TRADE_TOPIC0 } from "../trades";
import { MARKET, hash, initialCostLedger } from "./config";
import { gasContext } from "./execution";
import { exclusiveVerified, type JournalRecord } from "./journal";
import { HistoryStore } from "../market-data/history-store";
import { scanRaw, hashRange, forwardStorage, type RawProof } from "./raw-storage";
import { STORAGE } from "./storage-policy";
export { rawProof, type RawProof } from "./raw-storage";

const iface = new ethers.utils.Interface(OrderBookAbi.abi);
export const PARAMS_SELECTOR = iface.encodeFunctionData("getMarketParams", []);
const selectors = new Set([PARAMS_SELECTOR, SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS].map(x => x.toLowerCase()));
export function validateRead(method: string, params: any[]) {
  const tag = (x: unknown) => typeof x === "string" && (x === "finalized" || /^0x[0-9a-f]+$/i.test(x));
  const market = (x: unknown) => typeof x === "string" && x.toLowerCase() === MARKET.contract.toLowerCase();
  if (method === "eth_chainId" && params.length === 0) return;
  if (method === "eth_getBlockByNumber" && params.length === 2 && tag(params[0]) && params[1] === false) return;
  if (method === "eth_call" && params.length === 2 && market(params[0]?.to) &&
    Object.keys(params[0]).every(k => ["to", "data"].includes(k)) && selectors.has(params[0].data?.toLowerCase()) && tag(params[1])) return;
  if (method === "eth_getLogs" && params.length === 1 && market(params[0]?.address) &&
    JSON.stringify(params[0]?.topics) === JSON.stringify([TRADE_TOPIC0]) && tag(params[0].fromBlock) && tag(params[0].toBlock) &&
    BigInt(params[0].toBlock) >= BigInt(params[0].fromBlock) && BigInt(params[0].toBlock) - BigInt(params[0].fromBlock) < 100n) return;
  throw Error("FORWARD_READ_ALLOWLIST_REJECTED");
}
export interface RpcMetric { method: string; startedAt: number; receivedTimestamp: number; latencyMs: number; success: boolean; error: string | null }
export function feeMetadata(raw: string, block: string, sourceTimestamp: number | null, receivedTimestamp: number) {
  const p = iface.decodeFunctionResult("getMarketParams", raw), fields = Array.from(p).map(x => x.toString());
  if (fields.length !== 11) throw Error("UNKNOWN_MARKET_PARAMS_SCHEMA");
  // Field names/positions are from the installed SDK src/market/marketParams.ts, not guessed.
  return { market: MARKET, raw, block, sourceTimestamp, receivedTimestamp, availableAt: receivedTimestamp,
    ageMs: sourceTimestamp === null ? null : receivedTimestamp - sourceTimestamp, fields,
    takerFeeBpsParameter: fields[9], makerFeeBpsParameter: fields[10], parameterClass: "POINT_IN_TIME",
    interpretation: "installed @kuru-labs/kuru-sdk/src/market/marketParams.ts indices 9/10",
    deploymentFeeSemantics: "UNVERIFIED_CURRENCY_SIGN_REBATE_ROUTING", actualPaidFee: null,
    executionCostLedger: initialCostLedger(), spreadAlreadyIncludedInVirtualVWAP: true };
}

/** Decorate, do not replace, the existing RPC throttle, timeout and collector implementations. */
export class ForwardCollector {
  readonly history: KuruHistorySource;
  readonly book: BookSource;
  readonly rawPath: string;
  readonly metrics: RpcMetric[] = [];
  private rows: JournalRecord[] = [];
  private headers = new Map<string, any>();
  readonly rpc: Rpc;
  constructor(readonly cacheDirectory: string, private guard: () => void, base: Rpc = publicRpc()) {
    this.rawPath = join(cacheDirectory, `143-${MARKET.contract.toLowerCase()}.jsonl`);
    this.rpc = async (method, params) => {
      validateRead(method, params); this.guard();
      const startedAt = Date.now(), mono = performance.now(); let success = false, error: string | null = null;
      try {
        const value = await base(method, params), receivedTimestamp = Date.now();
        if (method === "eth_getBlockByNumber") {
          this.headers.set(value.number, value);
          // Only the finalized head is a current gas sample; historical bootstrap headers are not.
          if (params[0] === "finalized") this.rows.push({ stream: "gas", id: `gas:${value.hash}:${receivedTimestamp}`,
            value: gasContext(value, receivedTimestamp) });
        }
        if (method === "eth_call" && (params[0] as any).data === PARAMS_SELECTOR) {
          const h = this.headers.get(params[1] as string), sourceTimestamp = h ? Number(BigInt(h.timestamp)) * 1000 : null;
          this.rows.push({ stream: "fee", id: `fee:${params[1]}:${receivedTimestamp}`,
            value: feeMetadata(value, params[1] as string, sourceTimestamp, receivedTimestamp) });
        }
        success = true; return value;
      } catch (e) { error = e instanceof Error ? e.message : "RPC_FAILURE"; throw e; }
      finally {
        this.metrics.push({ method, startedAt, receivedTimestamp: Date.now(), latencyMs: performance.now() - mono, success, error });
        if (this.headers.size > 32) this.headers.delete(this.headers.keys().next().value!);
      }
    };
    this.history = new KuruHistorySource(MARKET.contract, this.rpc, cacheDirectory, forwardStorage(MARKET.contract));
    this.book = new BookSource(MARKET.contract, this.rpc);
  }
  drain(): JournalRecord[] { const rows = this.rows; this.rows = []; return rows; }
  async syncFiles() {
    for (const name of await readdir(this.cacheDirectory)) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".checkpoint.json")) continue;
      const f = await open(join(this.cacheDirectory, name), "r+"); try { await f.sync(); } finally { await f.close(); }
    }
  }
}

/** A fresh cache generation on explicit resume avoids stale collector locks/checkpoints.
 * Complete extra chunks survive crashes. A partial trailing chunk is preserved in the old
 * generation and excluded from the new one. Corrupt complete chunks stop recovery.
 */
export async function recoverRaw(oldPath: string, newDirectory: string, proof: RawProof | null, copyBudget=STORAGE.rawBytes) {
  let result;
  try{result=await scanRaw(oldPath,line=>{JSON.parse(line.toString("utf8"));},proof);}
  catch(e:any){if(e.code!=="ENOENT"||proof!==null)throw e;result={bytes:0,completeBytes:0,pending:Buffer.alloc(0),sha256:""};}
  const end=result.completeBytes;
  if(proof&&end<proof.bytes)throw Error("COMMITTED_RAW_INCOMPLETE");
  const free=await statfs(join(newDirectory,".."));
  if(end>copyBudget||end+96*1024**2>STORAGE.reserveBytes||Number(free.bavail)*Number(free.bsize)<end+96*1024**2)throw Error("RECOVERY_RESERVE_INSUFFICIENT_DATA_PRESERVED");
  await mkdir(newDirectory);
  if(end){const path=join(newDirectory,`143-${MARKET.contract.toLowerCase()}.jsonl`),f=await open(path,"wx");
    let digest;try{digest=await hashRange(oldPath,0,end,undefined,async b=>{await f.writeFile(b);});await f.sync();}finally{await f.close();}
    if(digest!.digest("hex")!==(await hashRange(path,0,end)).digest("hex"))throw Error("RECOVERY_CHECKSUM_FAILURE");}
  return { copiedBytes: end, incompleteTrailingBytesPreserved: result.bytes - end, recoveredUncommittedBytes: end - (proof?.bytes ?? 0),
    historicalTradesRecoverable: true, missedSignalAndExecutionBooksRecoverable: false };
}

/** Fast path only when source checkpoint and raw match the durable observation checkpoint.
 * No file is copied, truncated, replaced or deleted; abnormal cases use the prior preservation path.
 */
export async function reusableRaw(directory: string, proof: RawProof | null) {
  if (!proof) return false;
  const path = join(directory, `143-${MARKET.contract.toLowerCase()}.jsonl`);
  try { await readFile(path + ".writer.lock"); return false; } catch (e: any) { if (e.code !== "ENOENT") throw e; }
  let last:any=null;const result=await scanRaw(path,line=>{last=JSON.parse(line.toString("utf8"));},proof);
  if(result.bytes!==proof.bytes||result.pending.length||!last)return false;
  const cp = await new HistoryStore(directory, MARKET.contract).load(MARKET.contract);
  return !!cp && cp.block === last.throughBlock && cp.hash === last.endHash;
}
