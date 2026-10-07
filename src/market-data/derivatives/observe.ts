import { join } from "node:path";
import { assertSafe, MARKET, type Observation } from "./types";
import { publicGet,instrument,normalize,liquidations,LiquidationHealth,WS,TOPIC } from "./bybit-source";
import { historyGaps } from "./quality";
import { ObservationStore } from "./store";

/** Bounded standalone process. No trader, wallet, model, engine, or RPC imports. */
export async function runObservation(seconds=95) {
  assertSafe(process.env);
  if(!Number.isInteger(seconds)||seconds<25||seconds>180)throw Error("Duration must be 25..180 seconds");
  const start=Date.now(), deadline=start+seconds*1000, runId=new Date(start).toISOString().replace(/[:]/g,"-");
  const directory=join("data","derivatives","bybit","linear-perpetual","MONUSDT");
  const store=new ObservationStore(directory,`${runId}.jsonl`);await store.init();
  const health=new LiquidationHealth();
  const channels=Object.fromEntries(["oi","funding-settled","funding-current","liquidation"].map(k=>[k,{
    attempts:0,success:0,failures:0,latencyMs:[] as number[],receivedRecords:0,available:0,stale:0,unavailable:0,
    repeatObservations:0,possibleDuplicateEvents:0,sourceAgeMs:[] as number[],bytes:0,sample:null as Observation|null,
    gaps:[] as unknown[],
  }]));
  const seen=new Set<string>();let eventMessages=0,malformedMessages=0,wsAttempts=0,storageFailed=false;
  const save=async(row:unknown)=>{try{await store.append(row);}catch{storageFailed=true;}};
  function record(row:Observation) {
    const c=channels[row.kind]!;c.receivedRecords++;c[row.status]++;
    if(row.ageMs!==null)c.sourceAgeMs.push(row.ageMs);
    const id=JSON.stringify([row.kind,row.sourceTimestamp,row.raw]);
    if(seen.has(id)){if(row.kind==="liquidation")c.possibleDuplicateEvents++;else c.repeatObservations++;}
    // Preserve identical events: source supplies no unique liquidation ID.
    seen.add(id);
    if(!c.sample || (row.sourceTimestamp??row.receivedTimestamp)>=(c.sample.sourceTimestamp??c.sample.receivedTimestamp))c.sample=row;
    const entry={runId,...row};c.bytes+=Buffer.byteLength(JSON.stringify(entry)+"\n");void save(entry);
  }
  let interval:number;
  try {
    const meta=await publicGet("instrument");interval=instrument(meta).fundingIntervalMs;
    await save({runId,kind:"instrument",market:MARKET,...meta});
  } catch {
    await save({runId,kind:"instrument",status:"unavailable",reason:"Instrument lookup/identity check failed",receivedTimestamp:Date.now()});
    throw Error("Instrument lookup/identity check failed; observations not started");
  }
  const socket=new WebSocket(WS);wsAttempts++;
  socket.addEventListener("open",()=>{health.connectedAt=Date.now();socket.send(JSON.stringify({op:"subscribe",args:[TOPIC]}));});
  socket.addEventListener("error",()=>{health.errors++;});
  socket.addEventListener("close",()=>{health.closedAt=Date.now();});
  socket.addEventListener("message",event=>{
    const received=Date.now();
    if(++eventMessages>10000){health.errors++;socket.close();return;}
    try {
      const message=JSON.parse(String(event.data));
      if(message.op==="subscribe") {
        if(message.success===true)health.subscribedAt=received;else health.errors++;
        void save({runId,kind:"subscription",receivedTimestamp:received,raw:message});return;
      }
      if(message.op==="pong" || message.op==="ping" && message.ret_msg==="pong") {
        health.lastPong=received;health.pongs++;void save({runId,kind:"heartbeat",receivedTimestamp:received,raw:message});return;
      }
      if(message.topic===TOPIC){
        // Save the full envelope even if normalization fails.
        void save({runId,kind:"liquidation-envelope",receivedTimestamp:received,raw:message});
        for(const row of liquidations(message,received))record(row);
      }
    } catch {malformedMessages++;health.errors++;}
  });
  const ping=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({op:"ping"}));},20000);
  const healthSamples:ReturnType<LiquidationHealth["snapshot"]>[]=[];
  const healthTimer=setInterval(()=>{
    const snapshot=health.snapshot(Date.now());healthSamples.push(snapshot);
    void save({runId,kind:"transport-health",observedTimestamp:Date.now(),...snapshot});
  },5000);
  const next={oi:0,"funding-settled":0,"funding-current":0};
  try {
    while(Date.now()<deadline&&!storageFailed){
      for(const kind of ["oi","funding-settled","funding-current"] as const){
        if(Date.now()<next[kind]||Date.now()>=deadline)continue;
        const c=channels[kind]!,t=Date.now();c.attempts++;
        next[kind]=t+(kind==="oi"?60000:kind==="funding-settled"?300000:30000);
        try {
          const response=await publicGet(kind==="oi"?"oi":kind==="funding-settled"?"funding":"ticker");
          const rows=normalize(response,kind,interval);c.success++;c.latencyMs.push(response.latencyMs);
          c.gaps=kind==="funding-current"?[]:historyGaps(rows,kind==="oi"?300000:interval);
          await save({runId,kind:"rest-envelope",channel:kind,...response});
          for(const row of rows)record(row);
        } catch {
          c.failures++;await save({runId,kind,status:"unavailable",receivedTimestamp:Date.now(),reason:"Public fetch/validation failed"});
        }
      }
      await Bun.sleep(Math.min(250,Math.max(0,deadline-Date.now())));
    }
  } finally {clearInterval(ping);clearInterval(healthTimer);}
  const finalHealth=health.snapshot(Date.now());socket.close();
  const report={runId,startedAt:start,completedAt:Date.now(),dryRun:true,model:"mock",mode:"observation-only",market:MARKET,
    channels,liquidation:{connectionAttempts:wsAttempts,subscriptionSucceeded:health.subscribedAt!==null,
      finalHealth,healthSamples:healthSamples.length,healthySamples:healthSamples.filter(x=>x.healthy).length,
      malformedMessages,eventObservation:channels.liquidation!.receivedRecords?"events-observed":"events-not-observed",
      missingEvents:null,duplicateCertainty:"unknown: no source event IDs",reconnects:0,
      coverageNote:"No historical backfill; transport health does not prove event completeness"},
    storage:{directory,file:store.filename,capacityBytes:store.capacity,bytesBeforeSummary:store.writtenBytes,totalBeforeSummary:store.bytes,error:store.error},
    limitation:"Bounded sample; no engine or order integration; no USDT/USDC conversion"};
  await save({kind:"run-summary",...report});
  console.log(JSON.stringify({...report,storage:{...report.storage,finalWrittenBytes:store.writtenBytes,finalTotalBytes:store.bytes}},null,2));
  if(storageFailed||Object.values(channels).some(c=>c.failures)||!finalHealth.healthy)process.exitCode=1;
  return report;
}
