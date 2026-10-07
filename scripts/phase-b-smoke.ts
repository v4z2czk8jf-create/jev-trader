/** Explicitly bounded public-read benchmark. No wallet, backend or order imports. */
import { appendFile,writeFile,mkdir,stat } from "node:fs/promises";
import { KuruHistorySource,publicRpc } from "../src/market-data/rpc-source";
import { BookSource } from "../src/market-data/book-source";
import { observeSR,observeSRReplay } from "../src/market-data/phase-b";
import { enrich } from "../src/market-data/adapter";
import { adaptObservation,unavailable } from "../src/signals/adapter";
import { evaluate } from "../src/signals/engine";

if(process.env.DRY_RUN!=="true"||process.env.MODEL!=="mock"||["PRIVATE_KEY","TYPESAFE_AI_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY"].some(k=>!!process.env[k]))throw Error("Require dry/mock and no credentials");
const market="0x065C9d28E428A0db40191a54d33d5b7c71a9C394",samples=Number(process.argv[2]??12),ranges=Number(process.argv[3]??128);
if(!Number.isInteger(samples)||samples<1||samples>72||!Number.isInteger(ranges)||ranges<1||ranges>1200)throw Error("Bounded samples/ranges required");
const rpc=publicRpc();let historyCalls=0,historyRpcMs=0,historyErrors=0;
const history=new KuruHistorySource(market,async(m,p)=>{const t=Date.now();historyCalls++;try{return await rpc(m,p);}catch(e){historyErrors++;throw e;}finally{historyRpcMs+=Date.now()-t;}});
const book=new BookSource(market),start=Date.now();await mkdir("data",{recursive:true});
const historyRun=history.refresh(ranges,(n,t)=>console.log(JSON.stringify({historyRanges:n,through:new Date(t).toISOString()})));
const rows=[];
for(let i=0;i<samples;i++){
  await book.refresh();const row=book.snapshot();rows.push(row);
  const path="data/phase-b-book.jsonl",line=JSON.stringify({runStartedAt:start,mode:"observation-only",dryRun:true,model:"mock",...row})+"\n";
  let size=0;try{size=(await stat(path)).size;}catch(e:any){if(e.code!=="ENOENT")throw e;}
  if(size+Buffer.byteLength(line)>32*1024*1024)throw Error("Benchmark JSONL full; preserved");
  await appendFile(path,line);
  console.log(JSON.stringify({sample:i+1,status:row.data.status,ageMs:row.data.ageMs,acquisitionMs:row.acquisitionMs,rpcCalls:row.metrics.rpcCalls,...(row.data.status==="unavailable"?{reason:row.data.reason}:{})}));
  if(i+1<samples)await Bun.sleep(Math.max(0,(row.requestedTimestamp??Date.now())+5010-Date.now()));
}
await historyRun;
// Catch up after the bounded benchmark; do not present the initial head as current.
await history.refresh(ranges);
const now=Date.now(),raw=adaptObservation({block:0,ts:now,mid:NaN,bestBid:NaN,bestAsk:NaN,spreadBps:NaN,cached:true},market,now);
raw.price=unavailable("phase-b-smoke","No live quote substituted");raw.topOfBook=unavailable("phase-b-smoke","Separate finalized book");
const result=enrich(raw,history.history(),now),sr=observeSR(result.marketData),evaluation=evaluate(result.input,undefined,result.policy);
result.marketData.phaseB={mode:"observation-only-not-engine-evidence",book:book.snapshot(),sr,srReplay:observeSRReplay(result.marketData,sr),storage:history.storage(),storageError:history.history().error};
await appendFile("data/phase-b-signals.jsonl",JSON.stringify({...result,...evaluation})+"\n");
const metrics=book.snapshot().metrics;
const report={start,completedAt:now,elapsedSeconds:(now-start)/1000,history:{error:history.history().error,through:history.history().throughTimestamp,status:result.marketData.historyStatus,rpcCalls:historyCalls,rpcErrors:historyErrors,rpcTotalMs:historyRpcMs},
  book:{samples:rows.length,available:rows.filter(r=>r.data.status==="available").length,stale:rows.filter(r=>r.data.status==="stale").length,unavailable:rows.filter(r=>r.data.status==="unavailable").length,metrics,sourceAgeMs:rows.map(r=>r.data.ageMs),acquisitionMs:rows.map(r=>r.acquisitionMs),sample:rows.at(-1)},
  storage:{...history.storage(),checkpointBytes:(await stat(`data/market-data/143-${market.toLowerCase()}.checkpoint.json`).catch(()=>({size:0}))).size},
  frames:Object.fromEntries(Object.entries(result.marketData.frames).map(([tf,f])=>[tf,{status:f.candles.status,bars:"value" in f.candles?f.candles.value.length:0}])),
  sr,engine:{stage:evaluation.decision.stage,evidenceCount:evaluation.decision.evidenceCount,levels:result.input.levels.status,bookStructure:result.input.bookStructure.status},
  extraRpcPerSecond:(metrics.rpcCalls+historyCalls)/((now-start)/1000)};
await writeFile("data/phase-b-verification.json",JSON.stringify(report,null,2));
console.log(JSON.stringify({elapsedSeconds:report.elapsedSeconds,history:report.history,storage:report.storage,book:{samples:rows.length,available:report.book.available,stale:report.book.stale,unavailable:report.book.unavailable,metrics},engine:report.engine,extraRpcPerSecond:report.extraRpcPerSecond},null,2));
if(history.history().error||!report.book.available)process.exitCode=1;
