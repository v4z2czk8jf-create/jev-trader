import { readFile, writeFile, rename, stat, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { closedIntervals } from "./candles";
import { INTERVALS, type History } from "./types";

export const OHLCV_TARGET_DAYS=60;
export const RAW_LIMIT_BYTES=64*1024*1024; // retain existing guard; no raw retention/deletion policy
export interface Checkpoint { version: 1; market: string; block: number; hash: string; sizeDecimals: number; history: History }
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");

/** Persist all closed timeframes; keep only the unfinished 4h span of raw prints in RAM.
 * No disk raw logs are removed. A 60-day target is not a fabricated 60-day dataset.
 */
export function compactHistory(h:History):History {
  if(h.error)throw Error("Cannot checkpoint failed history");
  const closed:NonNullable<History["closed"]>={};
  for(const tf of Object.keys(INTERVALS) as (keyof typeof INTERVALS)[]) {
    const m=new Map((h.closed?.[tf]??[]).map(c=>[c.start,c]));
    for(const c of closedIntervals(h,INTERVALS[tf],h.throughTimestamp)) {
      const old=m.get(c.start);
      if(old && JSON.stringify(old)!==JSON.stringify(c))throw Error("Closed candle changed; checkpoint rejected");
      m.set(c.start,c);
    }
    closed[tf]=[...m.values()].sort((a,b)=>a.start-b.start);
    // Stop with all historical data retained; never prune silently after the target.
    if(closed[tf]!.length > Math.ceil(OHLCV_TARGET_DAYS*86400000/INTERVALS[tf]))throw Error("OHLCV 60-day capacity reached; explicit archive required");
  }
  const rawFromTimestamp=Math.max(h.fromTimestamp,Math.floor(h.throughTimestamp/INTERVALS["4h"])*INTERVALS["4h"]);
  return {...h,closed,rawFromTimestamp,trades:h.trades.filter(t=>t.timestamp>=rawFromTimestamp)};
}
export class HistoryStore {
  readonly path:string;
  constructor(directory:string,market:string,readonly limitBytes=32*1024*1024){this.path=`${directory}/143-${market.toLowerCase()}.checkpoint.json`;}
  async load(market:string):Promise<Checkpoint|null>{
    let text:string;
    try { if((await stat(this.path)).size>this.limitBytes)throw Error("Checkpoint size cap");text=await readFile(this.path,"utf8"); }
    catch(e:any){if(e.code==="ENOENT")return null;throw e;}
    const wrapper=JSON.parse(text); if(hash(wrapper.payload)!==wrapper.sha256)throw Error("Checkpoint checksum mismatch");
    const c=JSON.parse(wrapper.payload) as Checkpoint;
    if(c.version!==1||c.market.toLowerCase()!==market.toLowerCase()||c.history.market.toLowerCase()!==market.toLowerCase()||!Number.isSafeInteger(c.block)||c.block<1||!/^0x[0-9a-f]{64}$/i.test(c.hash)||!Number.isInteger(c.sizeDecimals)||c.sizeDecimals<0||c.sizeDecimals>30)throw Error("Checkpoint identity invalid");
    const h=c.history;
    if(h.error||![h.fromTimestamp,h.throughTimestamp,h.receivedTimestamp,h.rawFromTimestamp].every(Number.isFinite)||h.fromTimestamp>h.throughTimestamp||h.rawFromTimestamp!<h.fromTimestamp||h.rawFromTimestamp!>h.throughTimestamp||!Array.isArray(h.trades)||!h.closed)throw Error("Checkpoint coverage invalid");
    for(const tf of Object.keys(INTERVALS) as (keyof typeof INTERVALS)[]) {
      const rows=h.closed[tf]; if(!Array.isArray(rows))throw Error("Checkpoint timeframe missing");
      let last:number|undefined;
      for(const r of rows) {
        if(!Number.isFinite(r.start)||r.start%INTERVALS[tf]||r.end!==r.start+INTERVALS[tf]||r.end>h.throughTimestamp||last!==undefined&&r.start!==last)throw Error("Checkpoint interval gap");
        last=r.end; const x=r.candle;
        if(x&&(!Object.values(x).every(Number.isFinite)||x.start!==r.start||x.end!==r.end||x.low<=0||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close)||x.volume<=0||x.quoteVolume<=0||!Number.isInteger(x.trades)||x.trades<1))throw Error("Checkpoint candle invalid");
      }
    }
    // Validate retained raw trades using the same deterministic aggregator.
    closedIntervals(h,INTERVALS["5m"],h.throughTimestamp);
    return c;
  }
  async save(c:Checkpoint){
    const payload=JSON.stringify(c),text=JSON.stringify({sha256:hash(payload),payload});
    if(Buffer.byteLength(text)>this.limitBytes)throw Error("Checkpoint capacity reached; original preserved");
    await mkdir(this.path.slice(0,this.path.lastIndexOf("/")),{recursive:true});
    const temp=this.path+".pending";
    await writeFile(temp,text); const check=JSON.parse(await readFile(temp,"utf8"));
    if(hash(check.payload)!==check.sha256)throw Error("Checkpoint write verification failed");
    await rename(temp,this.path);
  }
}
