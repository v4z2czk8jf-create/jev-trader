import { test,expect,spyOn } from "bun:test";
import { mkdtemp,readFile,writeFile,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { compactHistory,HistoryStore,type Checkpoint } from "./history-store";
import { candles } from "./candles";
import { BookSource,bookMetrics,thinness,validateL2 } from "./book-source";
import { srCandidates } from "./sr-candidates";
import { observeSR } from "./phase-b";
import { enrich } from "./adapter";
import { adaptObservation } from "../signals/adapter";
import type { History,Candle } from "./types";
import { SEL_GET_L2_BOOK,SEL_GET_VAULT_PARAMS } from "../book";
import { replaySR } from "./sr-replay";
import { KuruHistorySource } from "./rpc-source";
const MARKET="0x1111111111111111111111111111111111111111",T=Date.UTC(2026,8,19,8),DT=300000;
function history(n=100):History{return {market:MARKET,source:"test:synthetic-only",fromTimestamp:T-n*DT,throughTimestamp:T,receivedTimestamp:T,trades:Array.from({length:n},(_,i)=>({id:`${i+1}:0`,block:i+1,timestamp:T-n*DT+i*DT+1000,price:100+Math.sin(i),volume:10})),error:null};}
const cp=(h:History):Checkpoint=>({version:1,market:MARKET,block:100,hash:"0x"+"a".repeat(64),sizeDecimals:10,history:compactHistory(h)});
test("Phase B compaction preserves OHLCV, exact notional and all timeframes",()=>{
 const h=history(1000),compact=compactHistory(h);
 for(const dt of [DT,3*DT,12*DT,48*DT])expect(candles(compact,dt,T)).toEqual(candles(h,dt,T));
 expect(compact.trades.length).toBe(0);expect(h.trades.length).toBe(1000);
});
test("Phase B compaction retains incomplete 4h prints and is idempotent",()=>{
 const h=history(100);h.throughTimestamp+=10000;h.trades.push({id:"101:0",block:101,timestamp:T+1000,price:101,volume:3});
 const first=compactHistory(h);expect(first.trades.length).toBe(1);expect(compactHistory(first)).toEqual(first);
});
test("Phase B empty intervals remain explicit and break continuity after resume",()=>{
 const h=history(100);h.trades=h.trades.filter(t=>t.timestamp<T-DT);const c=compactHistory(h);
 expect(c.closed?.["5m"]?.at(-1)?.candle).toBeNull();expect(candles(c,DT,T).series).toHaveLength(0);expect(candles(c,DT,T).latestVolume).toBe(0);
});
test("Phase B 60-day OHLCV capacity stops without pruning input",()=>{
 const h=history(60*24*12);expect(compactHistory(h).closed?.["5m"]?.length).toBe(17280);
 const over=history(17281);expect(()=>compactHistory(over)).toThrow("60-day");expect(over.trades.length).toBe(17281);
});
test("Phase B checkpoint reload preserves source/provenance and resumes aggregation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"jev-phaseb-")),store=new HistoryStore(dir,MARKET),first=cp(history());await store.save(first);
 const loaded=await store.load(MARKET);expect(loaded).toEqual(first);
 const h=loaded!.history;h.throughTimestamp=T+DT;h.receivedTimestamp=T+DT;h.trades.push({id:"101:0",block:101,timestamp:T+1000,price:110,volume:3});
 const c=compactHistory(h);expect(candles(c,DT,T+DT).series.at(-1)?.close).toBe(110);
});
test("Phase B capacity failure preserves previous checkpoint bytes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"jev-phaseb-")),store=new HistoryStore(dir,MARKET);await store.save(cp(history()));const old=await readFile(store.path,"utf8");
 await expect(new HistoryStore(dir,MARKET,1).save(cp(history(101)))).rejects.toThrow("capacity");expect(await readFile(store.path,"utf8")).toBe(old);
});
test("Phase B corrupt checksum and wrong market fail closed",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"jev-phaseb-")),store=new HistoryStore(dir,MARKET);await store.save(cp(history()));
 await expect(store.load("0x2222222222222222222222222222222222222222")).rejects.toThrow("identity");
 const w=JSON.parse(await readFile(store.path,"utf8"));w.payload+=" ";await writeFile(store.path,JSON.stringify(w));await expect(store.load(MARKET)).rejects.toThrow("checksum");
});
test("Phase B uncommitted temp checkpoint does not replace committed version",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"jev-phaseb-")),store=new HistoryStore(dir,MARKET);const c=cp(history());await store.save(c);await writeFile(store.path+".pending","incomplete");expect(await store.load(MARKET)).toEqual(c);
});
test("Phase B book spread, base/quote depth and imbalance have known values",()=>{
 const b=bookMetrics([[99.99,30],[99,999]],[[100.01,10],[101,999]]);expect(b.spreadBps).toBeCloseTo(2);expect(b.depth[10]!.bidBase).toBe(30);expect(b.depth[10]!.askQuote).toBeCloseTo(1000.1);expect(b.depth[10]!.imbalance).toBe(0.5);
});
test("Phase B empty/crossed books rejected and zero denominator is unavailable",()=>{
 expect(()=>bookMetrics([],[[100,10]])).toThrow();expect(()=>bookMetrics([[101,1]],[[100,1]])).toThrow();
 const b=bookMetrics([[99,1]],[[101,1]]);expect(b.depth[10]!.imbalance).toBeNull();expect(b.depth[10]!.imbalanceStatus).toBe("unavailable");
});
test("Phase B thinness requires independent prior history, no spread proxy",()=>{
 const normal=bookMetrics([[99.99,100]],[[100.01,100]]).depth,small=bookMetrics([[99.99,10]],[[100.01,100]]).depth;
 expect(thinness(small,Array(59).fill(normal))).toBeNull();const x=thinness(small,Array(60).fill(normal))!;expect(x[10]!.bidRatio).toBeCloseTo(0.1);expect(x[10]!.bidThin).toBe(true);expect(x[10]!.askThin).toBe(false);
 normal[10]!.coverage="incomplete";expect(thinness(small,Array(60).fill(normal))).toBeNull();
});
const word=(n:bigint|number)=>BigInt(n).toString(16).padStart(64,"0");
const l2=(block=42)=>ethers.utils.defaultAbiCoder.encode(["bytes"],["0x"+[block,9999000000n,300000000000n,0,10001000000n,100000000000n].map(word).join("")]);
function fakeRpc(now:()=>number,bad?:string){const calls:{method:string;params:unknown[]}[]=[];const iface=new ethers.utils.Interface(OrderBookAbi.abi);
 return {calls,rpc:async(method:string,params:unknown[])=>{calls.push({method,params});if(bad==="network")throw Error("RPC offline");if(method==="eth_chainId")return "0x8f";
 if(method==="eth_getBlockByNumber")return {number:"0x2a",timestamp:"0x"+Math.floor(now()/1000).toString(16),hash:"0x"+"a".repeat(64)};
 if(method==="eth_call"){const data=(params[0] as any).data;if(data===SEL_GET_L2_BOOK)return l2(bad==="block"?43:42);if(data===SEL_GET_VAULT_PARAMS)return "0x"+"0".repeat(512);
 return iface.encodeFunctionResult("getMarketParams",[100000000,10000000000,"0x"+"0".repeat(40),18,"0x"+"0".repeat(40),6,100,1,1000000000,0,0]);}throw Error("Unexpected RPC");}};
}
test("Phase B truncated book payload is rejected",()=>{expect(()=>validateL2(l2())).not.toThrow();expect(()=>validateL2(ethers.utils.defaultAbiCoder.encode(["bytes"],["0x"+word(42)+word(100)]))).toThrow();});
test("Phase B read-only book pins every view to same block and waits 5s",async()=>{
 const f=fakeRpc(()=>Date.now()),b=new BookSource(MARKET,f.rpc);await b.refresh();const first=f.calls.length;await b.refresh();expect(f.calls.length).toBe(first);expect(first).toBe(5);
 expect(f.calls.filter(c=>c.method==="eth_call").every(c=>c.params[1]==="0x2a")).toBe(true);expect(b.snapshot().data.status).toBe("available");
 expect(b.snapshot(Date.now()+6000).data.status).toBe("stale");
});
test("Phase B book failures become unavailable and cannot throw to trader",async()=>{
 for(const reason of ["network","block"]){const f=fakeRpc(()=>Date.now(),reason),b=new BookSource(MARKET,f.rpc);await expect(b.refresh()).resolves.toBeUndefined();expect(b.snapshot().data.status).toBe("unavailable");expect(b.snapshot().metrics.missingRate).toBe(1);}
});
function srBars():Candle[]{return Array.from({length:60},(_,i)=>{const pivot=i===20||i===30;return {start:T+i*DT,end:T+(i+1)*DT,open:100,close:100,high:101,low:pivot?95:99,volume:10,quoteVolume:1000,trades:1};});}
test("Phase B S/R pivot requires right bars; second separated touch validates causally",()=>{
 const cs=srBars();expect(srCandidates(cs,cs[21]!.end).filter(x=>x.kind==="support")).toHaveLength(0);
 const first=srCandidates(cs,cs[22]!.end).find(x=>x.kind==="support")!;expect(first.recognizedAt).toBe(cs[22]!.end);expect(first.validatedAt).toBeNull();
 const second=srCandidates(cs,cs[32]!.end).find(x=>x.id===first.id)!;expect(second.validatedAt).toBe(cs[32]!.end);expect(second.price).toBe(first.price);expect(second.candidateOnly).toBe(true);
});
test("Phase B adding or changing future candles never changes past S/R replay",()=>{
 const cs=srBars(),asOf=cs[32]!.end,a=srCandidates(cs,asOf);const b=cs.map(c=>c.end>asOf?{...c,high:10000,low:1}:c);expect(srCandidates(b,asOf)).toEqual(a);expect(srCandidates(cs.slice(0,33),asOf)).toEqual(a);
});
test("Phase B S/R refuses gaps and observations do not change engine inputs",()=>{
 const cs=srBars();cs.splice(15,1);expect(()=>srCandidates(cs,T+100*DT)).toThrow("contiguous");
 const input=adaptObservation({block:1,ts:T,mid:100,bestBid:99,bestAsk:101,spreadBps:200,cached:false},MARKET,T);
 const result=enrich(input,history(),T),before=JSON.stringify(result.input);observeSR(result.marketData);expect(JSON.stringify(result.input)).toBe(before);expect(result.input.levels.status).toBe("unavailable");expect(result.input.bookStructure.status).toBe("unavailable");
});
test("Phase B S/R outcome replay records break/failure without rewriting recognition",()=>{
 const cs=srBars(),candidate=srCandidates(cs,cs[32]!.end).find(c=>c.kind==="support")!,before=JSON.stringify(candidate);
 cs[33]={...cs[33]!,open:96,close:94,low:93,high:97};cs[34]={...cs[34]!,open:94,close:100,low:94,high:101};
 const r=replaySR(candidate,cs,cs[34]!.end);expect(r.events.map(e=>e.type)).toEqual(["BREAK","FAILURE"]);expect(r.horizons[30]!.status).toBe("unavailable");expect(JSON.stringify(candidate)).toBe(before);
 const full=replaySR(candidate,cs,cs.at(-1)!.end);expect(full.horizons[30]!.status).toBe("available");expect(full.horizons[30]!.mfePct).toBeGreaterThan(0);expect(full.horizons[240]!.status).toBe("unavailable");
 const changed=cs.map(c=>c.end>cs[34]!.end?{...c,high:10000}:c);expect(replaySR(candidate,changed,cs[34]!.end)).toEqual(r);
});
test("Phase B history writer lock isolates failure and never removes another lock",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"jev-phaseb-")),path=`${dir}/143-${MARKET}.jsonl.writer.lock`;await writeFile(path,"test-owner");let calls=0;
 const source=new KuruHistorySource(MARKET,async()=>{calls++;throw Error("Should not be called");},dir);await source.refresh();expect(source.history().error).not.toBeNull();expect(calls).toBe(0);expect(await readFile(path,"utf8")).toBe("test-owner");
});
test("Phase B malformed raw history becomes unavailable without overwriting data",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"jev-phaseb-")),path=`${dir}/143-${MARKET}.jsonl`;await writeFile(path,"{incomplete");
 const source=new KuruHistorySource(MARKET,async()=>{throw Error("No network expected");},dir);await source.refresh();expect(source.history().error).not.toBeNull();expect(await readFile(path,"utf8")).toBe("{incomplete");
});
test("Phase B book success followed by failure does not reuse successful values",async()=>{
 let now=T,fail=false;const f=fakeRpc(()=>now),clock=spyOn(Date,"now").mockImplementation(()=>now);
 try{const b=new BookSource(MARKET,async(m,p)=>{if(fail)throw Error("offline");return f.rpc(m,p);});await b.refresh();expect(b.snapshot().data.status).toBe("available");now+=6000;fail=true;await b.refresh();const snap=b.snapshot();expect(snap.data.status).toBe("unavailable");expect(snap.requestedTimestamp).toBe(now);expect(snap.metrics.missingRate).toBe(0.5);expect(snap.block).toBeNull();}finally{clock.mockRestore();}
});
test("Phase B thinness warmup provenance and stale propagation",async()=>{
 let now=T;const f=fakeRpc(()=>now),clock=spyOn(Date,"now").mockImplementation(()=>now);
 try{const b=new BookSource(MARKET,f.rpc);for(let i=0;i<=60;i++){now=T+i*5000;await b.refresh();}
 const q=b.snapshot().data;if(!("value" in q))throw Error("Expected synthetic book");expect(q.value.thinness.status).toBe("available");expect(q.value.thinness.trace.samplesUsed).toBe(60);expect(q.value.thinness.trace.windowEnd).toBe(now-5000);
 const stale=b.snapshot(now+6000).data;if(!("value" in stale))throw Error("Expected stale value");expect(stale.status).toBe("stale");expect(stale.value.thinness.status).toBe("stale");
 }finally{clock.mockRestore();}
});
