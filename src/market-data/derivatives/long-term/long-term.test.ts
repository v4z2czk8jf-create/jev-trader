import { test,expect } from "bun:test";
import { mkdtemp,readFile,writeFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Archive,readArchive,exclusive } from "./archive";
import { MINUTE,HORIZONS,MARKET_KEY,evaluateOutcome,makeAnchor,alignChanges,type PriceBar } from "./evaluation";
import { ConnectionState,OITracker,expectedMissing } from "./lifecycle";
import { historyGet,priceBars } from "./source";
import { runLong,type SocketLike,type Dependencies } from "./runner";
import type { Response } from "../bybit-source";

const T=Date.UTC(2026,8,19,12),env={DRY_RUN:"true",MODEL:"mock"};
const bar=(start:number,extra:Partial<PriceBar>={}):PriceBar=>({marketKey:MARKET_KEY,start,end:start+MINUTE,
 receivedTimestamp:start+MINUTE+100,open:100,high:110,low:90,close:105,raw:"synthetic-fixture",...extra});
const anchor=(t=T)=>makeAnchor("synthetic-anchor",t,[bar(T-MINUTE,{receivedTimestamp:T,close:100})],{fixture:true});
const response=(list:any[],at=T):Response=>({raw:{retCode:0,time:at,result:{category:"linear",symbol:"MONUSDT",list}},requestedTimestamp:at-10,receivedTimestamp:at,latencyMs:10,source:"test:synthetic-only"});
const temporary=()=>mkdtemp(join(tmpdir(),"jev-long-"));

for(const horizon of HORIZONS){
 test(`Long MFE ${horizon/MINUTE}m excludes anchor/target crossing bars and future receipts`,()=>{
  const a=anchor(T+30000),start=T+MINUTE,end=T+horizon;
  const safe=Array.from({length:horizon/MINUTE-1},(_,i)=>bar(start+i*MINUTE));
  const poison=[bar(T,{high:99999,low:.01}),bar(end,{high:99999,low:.01}),bar(end+MINUTE,{high:99999,low:.01})];
  const r=evaluateOutcome(a,[...poison,...safe],horizon,end+2*MINUTE);
  expect(r.status).toBe("complete");expect(r.evaluationStartTimestamp).toBe(start);expect(r.evaluationStartDelayMs).toBe(30000);
  expect(r.anchorTimestamp).toBe(T+30000);expect(r.targetTimestamp).toBe(T+30000+horizon);
  expect(r.priceDataRange.start).toBe(start);expect(r.priceDataRange.end).toBe(end);expect(r.endpointLagMs).toBe(30000);
  expect(r.long!.mfePct).toBeCloseTo(10);expect(r.long!.maePct).toBeCloseTo(10);
  expect(r.short!.mfePct).toBeCloseTo(10);expect(r.short!.maePct).toBeCloseTo(10);
  expect(r).toEqual(evaluateOutcome(a,safe,horizon,end+2*MINUTE));
  safe[0]={...safe[0]!,receivedTimestamp:end+3*MINUTE};
  const missing=evaluateOutcome(a,safe,horizon,end+2*MINUTE);expect(missing.status).toBe("incomplete");expect(missing.long).toBeNull();
 });
}
test("Long exact-minute anchor includes that complete minute, never the preceding minute",()=>{
 const r=evaluateOutcome(anchor(),Array.from({length:30},(_,i)=>bar(T+i*MINUTE)),HORIZONS[0],T+31*MINUTE);
 expect(r.status).toBe("complete");expect(r.evaluationStartDelayMs).toBe(0);expect(r.priceDataRange.start).toBe(T);expect(r.priceDataRange.end).toBe(T+30*MINUTE);
});
test("Long sub-millisecond-free anchor records up to 59999ms start delay",()=>{
 const r=evaluateOutcome(anchor(T+1),[],HORIZONS[0],T+31*MINUTE);expect(r.evaluationStartDelayMs).toBe(59999);expect(r.status).toBe("incomplete");
});
test("Long outcome remains pending before target and refuses unknown reference",()=>{
 const bars=Array.from({length:30},(_,i)=>bar(T+i*MINUTE));
 expect(evaluateOutcome(anchor(),bars,HORIZONS[0],T+29*MINUTE).status).toBe("pending");
 expect(evaluateOutcome({...anchor(),referencePrice:null},bars,HORIZONS[0],T+31*MINUTE).status).toBe("unavailable");
});
test("Long replay reference cannot use future received price or another market",()=>{
 expect(makeAnchor("a",T,[bar(T-MINUTE,{receivedTimestamp:T+1})],{}).referencePrice).toBeNull();
 expect(makeAnchor("a",T,[bar(T-MINUTE,{marketKey:"kuru:MON-USDC",receivedTimestamp:T})],{}).referencePrice).toBeNull();
});
test("Long conflicting closed candle revisions are unavailable, exact duplicates harmless",()=>{
 const bs=Array.from({length:30},(_,i)=>bar(T+i*MINUTE));
 expect(evaluateOutcome(anchor(),[...bs,bs[0]!],HORIZONS[0],T+31*MINUTE).status).toBe("complete");
 expect(evaluateOutcome(anchor(),[...bs,{...bs[0]!,high:500}],HORIZONS[0],T+31*MINUTE).status).toBe("unavailable");
});
test("Long aligned OI change requires exact 5min endpoints and receipt cutoff",()=>{
 const p={time:T,oi:100},c={time:T+5*MINUTE,oi:110},bs=[bar(T-MINUTE,{receivedTimestamp:T,close:100}),bar(T+4*MINUTE,{close:105})];
 const r=alignChanges(p,c,bs,T+6*MINUTE);expect(r.status).toBe("available");expect(r.oiChangePct).toBeCloseTo(10);expect(r.priceChangePct).toBeCloseTo(5);
 expect(alignChanges(p,c,bs,T+5*MINUTE).status).toBe("unavailable");expect(alignChanges(p,{...c,time:T+6*MINUTE},bs,T+7*MINUTE).status).toBe("unavailable");
});
test("Long OI publication bound measures first observation without refreshing history time",()=>{
 const o=new OITracker();o.observe([T],T+10000,false);const first=o.observe([T,T+300000],T+360000,false)[0]!;
 expect(first.firstObservationDelayMs).toBe(60000);expect(first.lastSuccessfulPollWithoutBucket).toBe(T+10000);
 expect(o.observe([T+300000],T+420000,false)).toHaveLength(0);
 expect(o.observe([T+600000,T+600000],T+620000,false)).toHaveLength(1);
 const back=o.observe([T-300000],T+500000,true)[0]!;expect(back.backfilled).toBe(true);expect(back.lastSuccessfulPollWithoutBucket).toBeNull();
});
test("Long missing rate includes expected boundary, not request-success denominator",()=>{
 expect(expectedMissing(T,T+600000,300000,[T,T+600000])).toEqual({from:T,to:T+600000,expected:3,missing:1,missingRate:1/3});
});
test("Long lifecycle persists disconnect gap and reconnect closes gap without restoring events",()=>{
 const c=new ConnectionState(T);c.subscription(T+100);c.lastPong=T+1000;
 const g=c.disconnected(T+2000,"network");expect(g.start).toBe(T+1000);expect(g.recoverable).toBe(false);expect(c.nextConnect).toBe(T+3000);
 const closed=c.subscription(T+5000);expect(closed.end).toBe(T+5000);expect(closed.recoverable).toBe(false);
});
test("Long sleep, reverse clock, heartbeat expiry and subscription timeout are gaps",()=>{
 const c=new ConnectionState(T);c.subscription(T);expect(c.tick(T+20000)?.reason).toBe("sleep-or-event-loop-gap");
 const reverse=new ConnectionState(T);expect(reverse.tick(T-1)?.reason).toBe("clock-reversal");
 const h=new ConnectionState(T);h.subscription(T);for(let i=1;i<=9;i++)h.tick(T+i*5000);expect(h.tick(T+46000)?.reason).toBe("heartbeat-expired");
 const s=new ConnectionState(T);s.openedAt=T;s.tick(T+10000);expect(s.tick(T+16000)?.reason).toBe("subscription-timeout");
});
test("Long archive reopens without modifying torn tail; complete checksummed records restored",async()=>{
 const dir=await temporary(),a=new Archive(dir);await a.init();await a.append("checkpoint",{heartbeat:T});
 const name=(await readdir(dir))[0]!,old=await readFile(join(dir,name),"utf8");await writeFile(join(dir,name),old+'{"torn":');
 const recovered:any[]=[],b=new Archive(dir);await b.init(row=>recovered.push(row));expect(recovered.map(r=>r.kind)).toEqual(["checkpoint","recovery-tail"]);
 await b.append("recovered",{ok:true});expect(await readFile(join(dir,name),"utf8")).toBe(old+'{"torn":');
});
test("Long archive refuses checksum corruption without erasing original",async()=>{
 const dir=await temporary(),a=new Archive(dir);await a.init();await a.append("sample",{price:100});
 const path=join(dir,(await readdir(dir))[0]!),bad=(await readFile(path,"utf8")).replace('"price":100','"price":101');await writeFile(path,bad);
 await expect(new Archive(dir).init()).rejects.toThrow();expect(await readFile(path,"utf8")).toBe(bad);
});
test("Long archive total capacity and queue overflow stop without deleting prior files",async()=>{
 const dir=await temporary(),a=new Archive(dir,600);await a.init();await a.append("sample",{ok:true});const names=await readdir(dir),before=await readFile(join(dir,names[0]!));
 await expect(a.append("sample",{large:"x".repeat(1000)})).rejects.toThrow();expect(await readFile(join(dir,names[0]!))).toEqual(before);
 const q=new Archive(await temporary(),10000,10);await q.init();await expect(q.append("sample",{})).rejects.toThrow("queue");
});
test("Long archive low disk space refuses write and reports failure",async()=>{
 const a=new Archive(await temporary(),10000,10000,async()=>0,100);await a.init();await expect(a.append("sample",{})).rejects.toThrow("disk");expect(a.stats().failure).not.toBeNull();
});
test("Long single-writer mutex refuses second process-equivalent holder and releases",async()=>{
 const a=await exclusive(0);await expect(exclusive(a.port)).rejects.toThrow();await a.close();const b=await exclusive(a.port);await b.close();
});
test("Long kline source rejects partial candles, wrong market and invalid OHLC",()=>{
 const r=response([[String(T-MINUTE),"100","110","90","105","1","100"],[String(T),"100","110","90","105","1","100"]],T+100);
 expect(priceBars(r)).toHaveLength(1);r.raw.result.symbol="BTCUSDT";expect(()=>priceBars(r)).toThrow();
});
test("Long public backfill is bounded GET, no redirect/auth, and detects truncated window",async()=>{
 let url="";const f=async(u:URL,o:RequestInit)=>{url=String(u);expect(o.method).toBe("GET");expect(o.headers).toBeUndefined();expect(o.redirect).toBe("error");return new Response(JSON.stringify(response([]).raw));};
 await historyGet("price",{from:T-3600000,to:T},f);expect(url).toContain("interval=1");
 await expect(historyGet("price",{from:T-7*3600000,to:T},f)).rejects.toThrow();
 const truncated=async()=>new Response(JSON.stringify(response(Array(200).fill({})).raw));
 await expect(historyGet("oi",{from:T-3600000,to:T},truncated)).rejects.toThrow("truncated");
});

class FakeSocket implements SocketLike {
 readyState=1;handlers:Record<string,((event:any)=>void)[]>={};
 addEventListener(t:string,cb:(e:any)=>void){(this.handlers[t]??=[]).push(cb);}
 event(t:string,e:any={}){for(const cb of this.handlers[t]??[])cb(e);}
 send(s:string){const m=JSON.parse(s);if(m.op==="subscribe")this.event("message",{data:JSON.stringify({op:"subscribe",success:true})});else if(m.op==="ping")this.event("message",{data:JSON.stringify({op:"pong"})});else throw Error("Not public subscription/ping");}
 close(){this.readyState=3;this.event("close");}
}
function fakeDependencies(clock:{now:number},abort:AbortController,stopAt:number) {
 const sockets:FakeSocket[]=[],requests:string[]=[];
 const deps:Dependencies={now:()=>clock.now,sleep:async ms=>{clock.now+=ms;if(clock.now>=stopAt)abort.abort();},
  connect:()=>{const s=new FakeSocket();sockets.push(s);queueMicrotask(()=>s.event("open"));return s;},
  get:async kind=>{
   requests.push(kind);
   if(kind==="instrument")return response([{symbol:"MONUSDT",baseCoin:"MON",quoteCoin:"USDT",settleCoin:"USDT",contractType:"LinearPerpetual",status:"Trading",isPreListing:false,fundingInterval:480}],clock.now);
   if(kind==="oi")return response([{timestamp:String(Math.floor(clock.now/300000)*300000),openInterest:"100"}],clock.now);
   if(kind==="funding")return response([{symbol:"MONUSDT",fundingRate:"0.0001",fundingRateTimestamp:String(Math.floor(clock.now/28800000)*28800000)}],clock.now);
   return response([{symbol:"MONUSDT",fundingRate:"0.0001",nextFundingTime:clock.now+28800000}],clock.now);
  },history:async(channel,w)=>{
   requests.push(`history-${channel}`);
   if(channel!=="price")return response([],clock.now);
   const end=Math.floor(clock.now/MINUTE)*MINUTE;
   return response(Array.from({length:15},(_,i)=>[String(end-(i+1)*MINUTE),"100","110","90","100","1","100"]),clock.now);
  }};
 return {deps,sockets,requests};
}
test("Long bounded synthetic recovery/storage integration resumes checkpoint, separates current funding, closes sockets",async()=>{
 const directory=await temporary(),a=new Archive(directory);await a.init();await a.append("checkpoint",{
  startedAt:T-600000,observationEndAt:T+600000,endAt:T+600000,heartbeat:T-300000,cursors:{oi:T-600000,funding:T-600000,price:T-600000},clean:false});
 const controller=new AbortController(),clock={now:T},f=fakeDependencies(clock,controller,T+70000);
 const result=await runLong({seconds:600,directory,port:0,signal:controller.signal,env},f.deps);
 expect(result.status).toBe("stopped");expect(f.sockets.every(s=>s.readyState===3)).toBe(true);
 const rows:any[]=[];for await(const r of readArchive(directory))rows.push(r);
 expect(rows.some(r=>r.kind==="gap"&&r.data.reason==="process-restart"&&r.data.start===T-300000)).toBe(true);
 const current=rows.filter(r=>r.kind==="observation"&&r.data.kind==="funding-current");expect(current.length).toBeGreaterThan(1);expect(current.every(r=>r.data.sourceTimestamp===null&&r.data.ageMs===null)).toBe(true);
 expect(rows.some(r=>r.kind==="price-bar")).toBe(true);expect(rows.some(r=>r.kind==="anchor")).toBe(true);
 expect(rows.some(r=>r.kind==="backfill-window"&&r.data.sourceComplete===false)).toBe(true);
 expect(rows.at(-1).kind).toBe("checkpoint");expect(rows.at(-1).data.clean).toBe(true);
});
test("Long simulated sleep and network close produce permanent liquidation gaps and reconnection",async()=>{
 const directory=await temporary(),controller=new AbortController(),clock={now:T},f=fakeDependencies(clock,controller,T+90000);
 let jumped=false,closed=false;
 const sleep=f.deps.sleep;f.deps.sleep=async ms=>{
   if(!closed&&clock.now>=T+5000){closed=true;f.sockets.at(-1)?.close();}
   if(!jumped&&clock.now>=T+20000){jumped=true;clock.now+=30000;}
   await sleep(ms);
 };
 await runLong({seconds:180,directory,port:0,signal:controller.signal,env},f.deps);
 const gaps:any[]=[];for await(const r of readArchive(directory))if(r.kind==="gap")gaps.push(r.data);
 expect(gaps.some(g=>g.reason==="websocket-close"&&g.recoverable===false)).toBe(true);
 expect(gaps.some(g=>g.reason==="sleep-or-event-loop-gap"&&g.recoverable===false)).toBe(true);
 expect(f.sockets.length).toBeGreaterThan(1);
});
test("Long failed catch-up leaves cursor unchanged and records unavailable",async()=>{
 const directory=await temporary(),controller=new AbortController(),clock={now:T},f=fakeDependencies(clock,controller,T+1000);
 const history=f.deps.history;f.deps.history=async(channel,w)=>{if(channel==="oi")throw Error("synthetic network loss");return history(channel,w);};
 const r=await runLong({seconds:60,directory,port:0,signal:controller.signal,env},f.deps);
 const rows:any[]=[];for await(const row of readArchive(directory))rows.push(row);
 expect(r.metrics.restFailed).toBe(1);expect(rows.some(x=>x.kind==="unavailable"&&x.data.channel==="backfill-oi")).toBe(true);
 expect(rows.at(-1).data.cursors.oi).toBe(T-3600000);
});
test("Long completed campaign cannot silently restart or extend its deadline",async()=>{
 const directory=await temporary(),a=new Archive(directory);await a.init();await a.append("checkpoint",{
  startedAt:T-60000,observationEndAt:T,endAt:T,heartbeat:T,cursors:{oi:T,funding:T,price:T},clean:true});
 const controller=new AbortController(),clock={now:T+10000},f=fakeDependencies(clock,controller,T+11000);
 await expect(runLong({seconds:604800,directory,port:0,signal:controller.signal,env},f.deps)).rejects.toThrow("already complete");
 expect(f.requests).toHaveLength(0);
});
test("Long price-only tail never subscribes liquidation or fetches OI/funding",async()=>{
 const directory=await temporary(),a=new Archive(directory);await a.init();await a.append("checkpoint",{
  startedAt:T-60000,observationEndAt:T-1,endAt:T+60000,heartbeat:T-1000,cursors:{oi:T-10000,funding:T-10000,price:T-10000},clean:false});
 const controller=new AbortController(),clock={now:T},f=fakeDependencies(clock,controller,T+1000);
 await runLong({seconds:60,directory,port:0,signal:controller.signal,env},f.deps);
 expect(f.requests.every(r=>r==="instrument"||r==="history-price")).toBe(true);expect(f.sockets).toHaveLength(0);
});
