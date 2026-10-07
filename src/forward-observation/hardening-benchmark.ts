/** OFFLINE synthetic disk benchmark. No transport or observation runner is constructed. */
import {mkdir,open,readFile,writeFile,stat} from "node:fs/promises";
import {join} from "node:path";
import {CampaignJournal,exclusiveVerified,footprint} from "./journal";
import {encodeBatch} from "./storage-codec";
import {hash,MARKET} from "./config";
import {rawProof,restoreHistory,RawHasher} from "./raw-storage";
import {recoverRaw} from "./collector";
import {MinuteSource} from "./minute-source";

async function measure<T>(work:()=>Promise<T>){
 const start=performance.now(),cpu=process.cpuUsage(),rssStart=process.memoryUsage().rss;let peak=rssStart;
 const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10);
 try{const value=await work(),used=process.cpuUsage(cpu);return {value,ms:performance.now()-start,cpuMs:(used.user+used.system)/1000,rssStart,rssEnd:process.memoryUsage().rss,peakRss:Math.max(peak,process.memoryUsage().rss)};}
 finally{clearInterval(timer);}
}
export async function benchmark(){
 const root=join("data/kuru-hardening",`offline-${Date.now()}`);await mkdir(root,{recursive:true});
 await exclusiveVerified(join(root,"manifest.json"),JSON.stringify({synthetic:true,publicRequests:0,notObservation:true,purpose:"Capacity/recovery only",createdAt:Date.now()}));
 const rawDir=join(root,"raw");await mkdir(rawDir);const path=join(rawDir,`143-${MARKET.contract.toLowerCase()}.jsonl`),f=await open(path,"wx");
 const start=Date.UTC(2030,0,1);let bytes=0,lastOffset=0,count=0;
 try{for(let i=0;i<5000;i++){
   const c={version:1,market:MARKET.contract,sizeDecimals:10,fromBlock:i+1,throughBlock:i+1,fromTimestamp:start+i*60000,
     throughTimestamp:start+(i+1)*60000,receivedTimestamp:start+(i+1)*60000+1,endHash:"0x"+"a".repeat(64),
     trades:Array.from({length:100},(_,j)=>({id:`${i+1}:${j}:synthetic-${"p".repeat(64)}`,block:i+1,timestamp:start+i*60000+1000+j,price:1+(j%3)*.001,volume:2}))};
   const line=JSON.stringify(c)+"\n";lastOffset=bytes;bytes+=Buffer.byteLength(line);count+=c.trades.length;await f.writeFile(line);
 }await f.sync();}finally{await f.close();}
 if(bytes<=64*1024**2)throw Error("BENCHMARK_TOO_SMALL");
 const proof=await measure(()=>rawProof(path));
 const rebuilt=await measure(()=>restoreHistory(path,MARKET.contract,null));
 if(!rebuilt.value.checkpoint||rebuilt.value.checkpoint.history.trades.length>200000)throw Error("UNBOUNDED_RECONSTRUCTION");
 const checkpoint=rebuilt.value.checkpoint;
 const withCheckpoint=await measure(()=>restoreHistory(path,MARKET.contract,checkpoint));
 const copied=await measure(()=>recoverRaw(path,join(root,"recovered"),proof.value));
 const minute=new MinuteSource(path);const state=minute.checkpoint();state.offset=lastOffset;
 const cursor=MinuteSource.restore(path,state);const incremental=await measure(()=>cursor.read());
 if(incremental.value.history?.trades.length!==100)throw Error("MINUTE_CURSOR_LOST");
 const hasher=new RawHasher(path);await hasher.proof();const noChangeProof=await measure(()=>hasher.proof());
 const summarize=(m:any)=>({...m,value:undefined});
 const raw={bytes,records:count,retainedPrints:checkpoint.history.trades.length,proof:summarize(proof),
   checkpointless:summarize(rebuilt),withCheckpoint:summarize(withCheckpoint),preservationCopy:{...summarize(copied),...copied.value},
   minuteCursor:summarize(incremental),unchangedIncrementalProof:summarize(noChangeProof),sha256:proof.value!.sha256,
   theoretical512MiBScale:512*1024**2/bytes,actual512MiBTest:false};
 await exclusiveVerified(join(root,"raw-report.json"),JSON.stringify(raw,null,2));
 console.log(JSON.stringify({stage:"RAW_COMPLETE",root,raw}));
 const j=await CampaignJournal.create<any>(root,"files",1024**3);let previous:string|null=null,total=0,index=0;
 // Stable synthetic representative state; no archived real campaign is modified.
 const cp={synthetic:true,unknownFees:null,pendingExits:[],state:Array.from({length:120},(_,i)=>({id:hash(`fixture:${i}`),availableAt:start+i,quality:"unavailable"}))};
 const results:any[]=[];
 for(const target of [20000,50000]){
   let pending:Promise<void>[]=[];
   while(index<target){index++;const r={stream:"health",id:`synthetic:${index}`,value:{synthetic:true,index}};
     const payload=JSON.stringify({version:1,sequence:index,previousHash:previous,records:[r],checkpoint:cp,storageBefore:{bytes:total,files:index-1},identifiersAdded:[`health:${r.id}`]});
     const text=encodeBatch(payload);previous=hash(payload);total+=Buffer.byteLength(text);
     if(total>512*1024**2)throw Error("FIXTURE_LIMIT");
     // Bulk fixture preparation, not a measurement of the production atomic commit path.
     pending.push(writeFile(join(j.directory,"journal",`${String(index).padStart(8,"0")}.json`),text,{flag:"wx"}));
     if(pending.length===32){await Promise.all(pending);pending=[];}
   }await Promise.all(pending);
   const audit=await measure(()=>CampaignJournal.resume<any>(j.directory,1024**3));
   const save=await measure(()=>audit.value.commit([{stream:"health",id:`new:${target}`,value:{synthetic:true}}],cp));
   index++;previous=save.value.headHash;total=save.value.bytes;
   const actual=await footprint(j.directory);if(actual.bytes!==save.value.bytes||actual.files!==save.value.files)throw Error("ACCOUNTING_MISMATCH");
   const normal=await measure(()=>audit.value.status());
   results.push({target,bytesBefore:total,fullAudit:summarize(audit),incrementalSave:summarize(save),normalStatus:summarize(normal),countAgreement:true});
   console.log(JSON.stringify({stage:"FILES_COMPLETE",target,result:results.at(-1)}));
 }
 const report={root,syntheticOnly:true,publicRequests:0,raw,files:results,storage:await footprint(root),finishedAt:Date.now()};
 await exclusiveVerified(join(root,"report.json"),JSON.stringify(report,null,2));return report;
}
if(import.meta.main){if(process.env.DRY_RUN!=="true"||process.env.MODEL!=="mock"||!process.execArgv.includes("--no-env-file"))throw Error("SAFETY_REQUIRED");console.log(JSON.stringify(await benchmark()));}
