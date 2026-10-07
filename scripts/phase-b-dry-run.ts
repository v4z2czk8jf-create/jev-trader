/** Bounded dry/mock-only backend verification; never loads .env into child. */
import { readFile,writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
if(process.env.DRY_RUN!=="true"||process.env.MODEL!=="mock"||["PRIVATE_KEY","TYPESAFE_AI_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY"].some(k=>!!process.env[k]))throw Error("Require dry/mock and no credentials");
try{await fetch("http://127.0.0.1:3100");throw Error("Port occupied");}catch(e){if(e instanceof Error&&e.message==="Port occupied")throw e;}
const start=Date.now(),env:Record<string,string>={DRY_RUN:"true",MODEL:"mock",RPC_URL:"https://rpc.monad.xyz",READ_RPC_URL:"https://rpc.monad.xyz",WS_URL:"",PORT:"3100"};
for(const k of ["SystemRoot","USERPROFILE","TEMP","TMP","PATH"])if(process.env[k])env[k]=process.env[k]!;
const child=Bun.spawn([process.execPath,"--no-env-file","--no-install","run","src/index.ts"],{cwd:process.cwd(),env,stdout:"pipe",stderr:"pipe",windowsHide:true});
const abort=new AbortController(),lock="data/market-data/143-0x065c9d28e428a0db40191a54d33d5b7c71a9c394.jsonl.writer.lock";
let reason="timeout",unsafe=false,meta:any=null,blocks=0,simQuotes=0,fills:any[]=[],stderr="",totals:any=null;
const stop=(why:string)=>{reason=why;abort.abort();child.kill();};
const timer=setTimeout(()=>stop("45-second limit"),45000);
async function logs(stream:ReadableStream<Uint8Array>,isError:boolean){let tail="";for await(const chunk of stream){const s=new TextDecoder().decode(chunk);if(isError)stderr+=s;tail=(tail+s).slice(-8000);if(/signTransaction|sendRawTransaction|sendTransaction|approve|deposit|\bSENT\b|\bPLACED\b|\bREVERTED\b|\bLOST\b/i.test(tail)){unsafe=true;stop("unsafe output");}}}
const logging=[logs(child.stdout,false),logs(child.stderr,true)];
function quote(q:any){if(!q)return;if(q.status!=="sim"||q.txHash!==null||q.gasMon!==0){unsafe=true;stop("unsafe quote");throw Error("unsafe quote");}simQuotes++;}
try{
 let response:Response|undefined;
 while(!abort.signal.aborted){try{response=await fetch("http://127.0.0.1:3100/events",{signal:abort.signal});break;}catch{await Bun.sleep(100);}}
 if(!response?.body)throw Error("Backend not available");let pending="";
 for await(const chunk of response.body){pending+=new TextDecoder().decode(chunk);let pos:number;
  while((pos=pending.indexOf("\n\n"))>=0){const part=pending.slice(0,pos);pending=pending.slice(pos+2);const type=part.match(/^event: (.+)$/m)?.[1],raw=part.match(/^data: (.+)$/m)?.[1];if(!raw)continue;const d=JSON.parse(raw);
   if(type==="snapshot"){meta={dryRun:d.dryRun,wallet:d.wallet,model:d.model};if(d.dryRun!==true||d.wallet!==null||d.model!=="mock"){unsafe=true;stop("unsafe metadata");throw Error("unsafe metadata");}}
   if(type==="block"){blocks++;quote(d.quote);totals=d.totals;}
   if(type==="quote")quote(d.quote);
   if(type==="fill"){if(d.fill.simulated!==true||d.fill.txHash!==null){unsafe=true;stop("unsafe fill");throw Error("unsafe fill");}fills.push(d);}
   if(meta&&simQuotes>=20&&fills.length&&Date.now()-start>=25000&&!existsSync(lock)){await Bun.sleep(250);if(!existsSync(lock)){stop("verification complete");break;}}
  }if(abort.signal.aborted)break;
 }
}catch(e){if(!abort.signal.aborted)reason="error: "+(e instanceof Error?e.message:"unknown");}
finally{clearTimeout(timer);abort.abort();child.kill();await child.exited;await Promise.allSettled(logging);}
const records=(await readFile("data/4stage-signals.jsonl","utf8")).trim().split("\n").map(x=>JSON.parse(x)).filter(r=>r.decision.timestamp>=start);
const phaseB=records.filter(r=>r.marketData?.phaseB);
const result={reason,elapsedSeconds:(Date.now()-start)/1000,meta,blocks,simQuotes,fills,totals,unsafe,stderr,backendStopped:true,writerLockRemaining:existsSync(lock),signalRecords:records.length,phaseBRecords:phaseB.length,
 stages:[...new Set(records.map(r=>r.decision.stage))],allObservationOnly:phaseB.every(r=>r.mode==="observation-only"&&r.marketData.phaseB.mode==="observation-only-not-engine-evidence"),
 noPhaseBEngineEvidence:phaseB.every(r=>r.input.levels.status==="unavailable"&&r.input.bookStructure.status==="unavailable"),bookStatuses:phaseB.map(r=>r.marketData.phaseB.book.data.status),lastHistoryStatus:phaseB.at(-1)?.marketData.historyStatus};
await writeFile("data/phase-b-dry-run.json",JSON.stringify(result,null,2));console.log(JSON.stringify({...result,fills:result.fills.length},null,2));
if(unsafe||!meta||!simQuotes||!fills.length||!phaseB.length||!result.noPhaseBEngineEvidence||stderr||result.writerLockRemaining||reason!=="verification complete")process.exitCode=1;
