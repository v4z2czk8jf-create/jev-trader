import type { BookObservation } from "./book-source";
import type { SRCandidate } from "./sr-candidates";
import { srCandidates } from "./sr-candidates";
import type { MarketDataSnapshot, Quality } from "./types";
import { missing } from "./adapter";
import { replaySR,type SRReplay } from "./sr-replay";
export interface PhaseBObservation {
  mode:"observation-only-not-engine-evidence";
  book:BookObservation;
  sr:Record<string,Quality<SRCandidate[]>>;
  srReplay:Record<string,SRReplay[]>;
  storage:{rawBytes:number;rawLimitBytes:number;retainedRawPrints:number;ohlcvTargetDays:number};
  storageError:string|null;
}
export function observeSRReplay(snapshot:MarketDataSnapshot,sr:PhaseBObservation["sr"]):PhaseBObservation["srReplay"]{
  return Object.fromEntries(Object.entries(sr).map(([tf,q])=>{
    const frame=snapshot.frames[tf as keyof typeof snapshot.frames].candles;
    return [tf,q.status==="available"&&"value" in q&&frame.status==="available"&&"value" in frame?q.value.map(c=>replaySR(c,frame.value,snapshot.asOf??0)):[]];
  }));
}
export function observeSR(snapshot:MarketDataSnapshot):Record<string,Quality<SRCandidate[]>>{
  return Object.fromEntries(Object.entries(snapshot.frames).map(([tf,f])=>{
    const q=f.candles;
    if(!("value" in q)||q.value.length<16)return [tf,missing<SRCandidate[]>(q.source,"Need >=16 contiguous closed bars for S/R validation",snapshot.timestamp,q.trace)];
    try{return [tf,{...q,value:srCandidates(q.value,snapshot.asOf??0),trace:{...q.trace,formula:"causal pivot-2+2 and ATR; observation only"}}];}
    catch{return [tf,missing<SRCandidate[]>(q.source,"S/R history invalid",snapshot.timestamp,q.trace)];}
  }));
}
