import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeBatch, batchBytes } from "./storage-codec";
import { CampaignJournal, footprint, exclusiveVerified } from "./journal";

/** Include intervening book/health-only batches; freeze the FIRST completed rate window.
 * A later resume with incomplete backfill must not erase an already measured window. */
export function rateWindow(batches: any[]) {
  let consecutive: any[] = [], found: any[] = [];
  for (const x of batches) {
    if (!x.history) continue;
    if (x.history.purpose === "CURRENT_INCREMENT") consecutive.push(x); else consecutive = [];
    if (consecutive.length === 4) { found = consecutive; break; }
  }
  const base = found[0], last = found.at(-1);
  return { window: found, base, last, measured: base ? batches.filter(x =>
    x.b.sequence > base.b.sequence && x.b.sequence <= last.b.sequence) : [] };
}

/** Offline only. No transport, interpolation or revised signal calculation. */
export async function capacityReport(directory: string) {
  const batches: any[] = [], summaries: any[] = [];
  for (const name of (await readdir(join(directory,"journal"))).filter(x=>x.endsWith(".json")).sort()) {
    const text=await readFile(join(directory,"journal",name),"utf8"),decoded=decodeBatch(text),b=decoded.batch;
    const rows=b.records.map((r:any)=>({...r,data:r.value.data??r.value}));
    const history=rows.find((r:any)=>r.stream==="quality"&&r.data.rawStorage)?.data;
    const health=rows.find((r:any)=>r.stream==="health"&&r.id.startsWith("cycle:"))?.data;
    batches.push({name,b,rows,history,health,bytes:batchBytes(text)});
  }
  for (const name of (await readdir(directory)).filter(n=>n.startsWith("session-summary-"))) summaries.push(JSON.parse(await readFile(join(directory,name),"utf8")));
  summaries.sort((a,b)=>a.began-b.began);
  const historyBatches=batches.filter(x=>x.history);
  // First caught-up sample establishes the baseline; subsequent three full increments form the rate window.
  const {window,base,last,measured}=rateWindow(batches);
  const minutes=base?(last.b.checkpoint.lastCommittedAt-base.b.checkpoint.lastCommittedAt)/60000:0;
  const physical:Record<string,number>={},logical:Record<string,number>={};let raw=0,sourceCheckpointGrowth=0,sourceCheckpointWritten=0,rpc=0;
  for(const x of measured){
    for(const [k,v] of Object.entries(x.bytes.physical))physical[k]=(physical[k]??0)+(v as number);
    for(const [k,v] of Object.entries(x.bytes.logical))logical[k]=(logical[k]??0)+(v as number);
    if(x.history){
      raw+=x.history.rawStorage.rawBytes-x.history.rawBytesBefore;
      sourceCheckpointGrowth+=x.history.checkpointBytesAfter-x.history.checkpointBytesBefore;
      sourceCheckpointWritten+=x.history.checkpointBytesAfter;
    }
    rpc+=x.health?.metrics.length??0;
  }
  const category={raw,normalized:(physical.input??0)+(physical.price??0)+(physical.sr??0),decision:physical.signal??0,
    book:physical.book??0,execution:physical.execution??0,feeGas:(physical.fee??0)+(physical.gas??0),quality:physical.quality??0,
    checkpointHealth:(physical.checkpoint??0)+(physical.health??0)+(physical.shared??0)+sourceCheckpointGrowth};
  const rates=Object.fromEntries(Object.entries(category).map(([k,v])=>[k,minutes?v/minutes:null]));
  const verifyStart=performance.now(),journal=await CampaignJournal.resume(directory),resumeScanMs=performance.now()-verifyStart;
  const fpStart=performance.now(),storage=await footprint(directory),footprintScanMs=performance.now()-fpStart;
  const rows=batches.flatMap(b=>b.rows),ids=rows.map(r=>r.stream+":"+r.id);
  const warmup=base?{through:base.b.checkpoint.lastCommittedAt,bytes:base.b.storageBefore.bytes+base.bytes.total,
    rawBytes:base.history.rawStorage.rawBytes,sourceCheckpointBytes:base.history.checkpointBytesAfter,
    firstSource:base.history.from,lastSource:base.history.through,
    firstCurrentBaselineSequence:base.b.sequence}:null;
  return {directory,storage,checksumsVerified:true,duplicateIds:ids.length-new Set(ids).size,resumeScanMs,footprintScanMs,
    warmup,steady:base?{start:base.b.checkpoint.lastCommittedAt,end:last.b.checkpoint.lastCommittedAt,minutes,
      acquisitions:measured.filter(x=>x.history).length,journalFiles:measured.length,rawGrowth:raw,sourceCheckpointGrowth,sourceCheckpointWritten,physical,logical,
      categoryBytes:category,bytesPerMinute:rates,totalBytesPerMinute:Object.values(category).reduce((a,b)=>a+b,0)/minutes,
      filesPerMinute:measured.length/minutes,rpc,rpcPerMinute:rpc/minutes,
      cpuMs:(last.health.cpu.user+last.health.cpu.system-base.health.cpu.user-base.health.cpu.system)/1000,
      rssSamples:window.map(x=>x.health.memory.rss),allContextsFullyWarm:null,
      readinessBasis:"current finalized trade coverage and complete1m boundary; higher-frame quality remains unchanged"}:null,
    signalStages:rows.filter(r=>r.stream==="signal").map(r=>({at:r.data.decisionTimestamp,stage:r.data.decision.stage,evidenceCount:r.data.decision.evidenceCount,quality:r.data.quality})),
    snapshotCount:rows.filter(r=>r.stream==="execution").length,
    acquisitions:historyBatches.map(x=>({sequence:x.b.sequence,...x.history,journalBytes:x.bytes.total})),
    summaries:summaries.map(s=>({began:s.began,endedAt:s.endedAt,reason:s.reason,durationMs:s.durationMs,rpcCount:s.rpcCount,
      responseBytes:s.responseBytes,cpuMs:s.cpuMs,peakRss:s.peakRss,recovery:s.recovery,failures:s.rpc.filter((r:any)=>!r.success)})),
    checkpoint:await journal.status()};
}
if(import.meta.main){const path=resolve(process.argv[2]??"");if(!path.startsWith(resolve("data/kuru-forward")+"\\")&&!path.startsWith(resolve("data/kuru-forward")+"/"))throw Error("OWN_CAMPAIGN_REQUIRED");
  const report=await capacityReport(path);await exclusiveVerified(join(path,"capacity-report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));}
