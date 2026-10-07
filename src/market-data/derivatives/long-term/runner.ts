import { assertSafe,type Observation } from "../types";
import { publicGet,instrument,normalize,liquidations,WS,TOPIC,type Response } from "../bybit-source";
import { Archive,exclusive,DEFAULT_DIRECTORY } from "./archive";
import { historyGet,priceBars,type Channel,type Window } from "./source";
import { ConnectionState,OITracker,expectedMissing } from "./lifecycle";
import { makeAnchor,alignChanges,MINUTE,type PriceBar } from "./evaluation";

export interface SocketLike {readyState:number;send(data:string):void;close():void;addEventListener(type:string,cb:(event:any)=>void):void}
export interface Dependencies {
  now:()=>number;sleep:(ms:number)=>Promise<void>;
  get:typeof publicGet;history:(channel:Channel,window:Window)=>Promise<Response>;
  connect:()=>SocketLike;
}
const defaults:Dependencies={now:Date.now,sleep:Bun.sleep,get:publicGet,history:historyGet,connect:()=>new WebSocket(WS)};
export interface RunOptions {seconds:number;tailSeconds?:number;directory?:string;port?:number;signal?:AbortSignal;env?:Record<string,string|undefined>}
type Checkpoint={startedAt:number;observationEndAt:number;endAt:number;heartbeat:number;cursors:Record<Channel,number>;clean:boolean};

/** Explicit invocation only. No automatic start, scheduler, trading imports or write RPC. */
export async function runLong(options:RunOptions,overrides:Partial<Dependencies>={}) {
  assertSafe(options.env??process.env);
  if(!Number.isInteger(options.seconds)||options.seconds<1||options.seconds>7*86400||
    !Number.isInteger(options.tailSeconds??0)||(options.tailSeconds??0)<0||(options.tailSeconds??0)>86400)throw Error("Explicit duration 1..604800s, optional tail 0..86400s required");
  const d={...defaults,...overrides},lock=await exclusive(options.port??31987);
  const archive=new Archive(options.directory??DEFAULT_DIRECTORY),oi=new OITracker();
  let restored:Checkpoint|undefined,checkpointSequence=-1;
  let bars:PriceBar[]=[],lastOI:{time:number;oi:number}|null=null;
  const recoveryTails:unknown[]=[];
  const metadataCache={fundingIntervalMs:28800000,validUntil:0};
  let socket:SocketLike|null=null,stopping=false;
  const activeSocket=():SocketLike|null=>socket;
  let connection:ConnectionState;
  const metrics={restAttempts:0,restSuccess:0,restFailed:0,restLatencyMs:0,connectionAttempts:0,reconnections:0,
    liquidations:0,malformedMessages:0,checkpoints:0};
  const save=(kind:string,data:unknown)=>archive.append(kind,data);
  // Callback writes are serialized and bounded by Archive; failures stop the outer loop.
  const emit=(kind:string,data:unknown)=>{void save(kind,data).catch(()=>{});};
  try {
    await archive.init(row=>{
      if(row.kind==="checkpoint"&&row.sequence>checkpointSequence){restored=row.data;checkpointSequence=row.sequence;}
      if(row.kind==="oi-first-seen")oi.state.firstSeen[row.data.sourceTimestamp]=row.data.firstObservedTimestamp;
      if(row.kind==="price-bar"){bars.push(row.data);if(bars.length>1500)bars=bars.slice(-1500);}
      if(row.kind==="observation"&&row.data.kind==="oi"&&row.data.sourceTimestamp!==null&&row.data.status!=="unavailable"){
        const point={time:row.data.sourceTimestamp,oi:Number(row.data.value.openInterest)};
        if(!lastOI||point.time>lastOI.time)lastOI=point;
      }
      if(row.kind==="recovery-tail")recoveryTails.push(row.data);
    });
    const now=d.now();
    if(restored&&(!Number.isFinite(restored.heartbeat)||!Number.isFinite(restored.endAt)||!restored.cursors))throw Error("Invalid recovery checkpoint");
    const state:Checkpoint=restored??{startedAt:now,observationEndAt:now+options.seconds*1000,
      endAt:now+(options.seconds+(options.tailSeconds??0))*1000,heartbeat:now,
      cursors:{oi:now-3600000,funding:now-3600000,price:now-3600000},clean:false};
    if(restored?.clean&&restored.heartbeat>=restored.endAt)throw Error("Campaign already complete; use a new directory for a new campaign");
    connection=new ConnectionState(now,restored?.heartbeat);
    await save("session-start",{now,previousCheckpoint:restored??null,recoveryTails,dryRun:true,model:"mock",mode:"observation-only"});
    await save("gap",connection.gap);
    if(restored)await save("gap",{start:restored.heartbeat,end:now,reason:"process-restart",series:"rest-and-price",recoverable:true});
    const checkpoint=async(clean=false)=>{state.heartbeat=d.now();state.clean=clean;await save("checkpoint",{...state,cursors:{...state.cursors}});metrics.checkpoints++;};
    await checkpoint();
    const trimBars=()=>{const cutoff=d.now()-30*3600000;bars=bars.filter(b=>b.end>=cutoff).sort((a,b)=>a.start-b.start).slice(-2000);};
    const archivePrices=async(response:Response)=>{
      for(const b of priceBars(response)){
        const existing=bars.find(p=>p.start===b.start);
        if(existing&&["open","high","low","close"].every(k=>existing[k as "open"]===b[k as "open"]))continue;
        await save("price-bar",b);bars.push(b);
      }trimBars();
    };
    const record=async(row:Observation,backfilled:boolean)=>{
      await save("observation",{...row,backfilled});
      if(!backfilled&&row.status==="available"&&row.receivedTimestamp<=state.observationEndAt){
        const anchorId=`${row.kind}:${row.sourceTimestamp}:${row.receivedTimestamp}`;
        // One anchor per new OI bucket; settled funding repeats remain identifiable.
        await save("anchor",makeAnchor(anchorId,row.receivedTimestamp,bars,{kind:row.kind,sourceTimestamp:row.sourceTimestamp}));
      }
    };
    const oiRecords=async(response:Response,backfilled:boolean)=>{
      const rows=response.raw.result.list.length?normalize(response,"oi",metadataCache.fundingIntervalMs):[];
      const times=rows.filter(r=>r.status!=="unavailable").map(r=>r.sourceTimestamp!);
      const first=oi.observe(times,response.receivedTimestamp,backfilled);
      const newTimes=new Set(first.map(r=>r.sourceTimestamp));
      for(const item of first)await save("oi-first-seen",item);
      let priorInResponse:{time:number;oi:number}|null=null;
      for(const row of rows.sort((a,b)=>a.sourceTimestamp!-b.sourceTimestamp!)){
        await save("observation",{...row,backfilled});
        const point={time:row.sourceTimestamp!,oi:Number(row.value.openInterest)};
        const previous=priorInResponse??(lastOI&&lastOI.time<point.time?lastOI:null);
        if(previous)await save("oi-price-change",{...alignChanges(previous,point,bars,response.receivedTimestamp),backfilled});
        if(row.status!=="unavailable")priorInResponse=point;
        if(!backfilled&&newTimes.has(row.sourceTimestamp!)&&row.status==="available"){
          await save("anchor",makeAnchor(`oi:${row.sourceTimestamp}`,row.receivedTimestamp,bars,{kind:"oi",sourceTimestamp:row.sourceTimestamp}));
        }
        if(row.status!=="unavailable"&&(!lastOI||point.time>lastOI.time))lastOI=point;
      }
      await save("oi-coverage",{...expectedMissing(state.startedAt,response.receivedTimestamp,300000,Object.keys(oi.state.firstSeen).map(Number)),
        basis:"cumulative first observations including backfill; latest boundary may still await publication",observedTimestamp:response.receivedTimestamp,backfilled});
    };
    const request=async(channel:string,job:()=>Promise<Response>,consume:(r:Response)=>Promise<void>)=>{
      metrics.restAttempts++;
      try{const r=await job();await save("rest-response",{channel,...r});await consume(r);metrics.restSuccess++;metrics.restLatencyMs+=r.latencyMs;return true;}
      catch(e){if(archive.failure)throw e;metrics.restFailed++;await save("unavailable",{channel,observedTimestamp:d.now(),reason:"Public fetch or validation failed"});return false;}
    };
    const disconnect=(reason:string)=>{
      emit("gap",connection.disconnected(d.now(),reason));const old=socket;socket=null;old?.close();
    };
    const connect=()=>{
      if(metrics.connectionAttempts>0)metrics.reconnections++;
      metrics.connectionAttempts++;connection.openedAt=d.now();
      try{
        const s=d.connect();socket=s;
        s.addEventListener("open",()=>{if(socket===s&&!stopping)s.send(JSON.stringify({op:"subscribe",args:[TOPIC]}));});
        s.addEventListener("close",()=>{if(socket===s&&!stopping)disconnect("websocket-close");});
        s.addEventListener("error",()=>{if(socket===s&&!stopping)disconnect("websocket-error");});
        s.addEventListener("message",event=>{
          if(socket!==s||stopping)return;
          const received=d.now();
          try{
            if(Buffer.byteLength(String(event.data))>2*1024**2)throw Error("Oversized public frame");
            const message=JSON.parse(String(event.data));
            if(message.op==="subscribe"){
              if(message.success!==true){disconnect("subscription-rejected");return;}
              emit("gap",connection.subscription(received));emit("subscription",{receivedTimestamp:received,raw:message});
            }else if(message.op==="pong"||message.op==="ping"&&message.ret_msg==="pong"){
              connection.lastPong=received;emit("heartbeat",{receivedTimestamp:received,raw:message});
            }else if(message.topic===TOPIC){
              emit("liquidation-envelope",{receivedTimestamp:received,raw:message});
              for(const row of liquidations(message,received)){
                metrics.liquidations++;emit("observation",{...row,backfilled:false});
                if(row.status==="available")emit("anchor",makeAnchor(`liq:${received}:${metrics.liquidations}`,received,bars,{kind:"liquidation",raw:row.raw}));
              }
            }
          }catch{metrics.malformedMessages++;disconnect("malformed-message");}
        });
      }catch{disconnect("websocket-connect-failed");}
    };
    const next={metadata:0,oi:0,funding:0,current:0,price:0,backfill:0,ping:0,health:0};
    let backfillChannel=0;
    while(d.now()<state.endAt&&!options.signal?.aborted&&!archive.failure){
      const t=d.now(),tail=t>=state.observationEndAt;
      const gap=connection.tick(t);
      if(gap){await save("gap",gap);await save("gap",{...gap,series:"rest-and-price",recoverable:true});const old=activeSocket();socket=null;old?.close();}
      if(t>=next.metadata){
        next.metadata=t+3600000;
        metadataCache.validUntil=0;
        const ok=await request("instrument",()=>d.get("instrument"),async r=>{
          const m=instrument(r);metadataCache.fundingIntervalMs=m.fundingIntervalMs;metadataCache.validUntil=d.now()+3600000;
          await save("instrument",{receivedTimestamp:r.receivedTimestamp,...m});
        });
        if(!ok){next.metadata=t+60000;if(socket)disconnect("instrument-unavailable");}
      }
      const valid=d.now()<metadataCache.validUntil;
      if(valid&&!tail&&!socket&&d.now()>=connection.nextConnect)connect();
      if(tail&&socket)disconnect("observation-period-complete-price-tail-only");
      const pingSocket=activeSocket();
      if(pingSocket&&pingSocket.readyState===1&&d.now()>=next.ping){next.ping=d.now()+20000;try{pingSocket.send(JSON.stringify({op:"ping"}));}catch{disconnect("ping-send-failed");}}
      if(valid&&d.now()>=next.price){
        next.price=t+60000;const closed=Math.floor(d.now()/MINUTE)*MINUTE;
        await request("price",()=>d.history("price",{from:closed-15*MINUTE,to:closed-1}),archivePrices);
      }
      if(valid&&!tail&&d.now()>=next.oi){next.oi=t+60000;await request("oi",()=>d.get("oi"),r=>oiRecords(r,false));}
      if(valid&&!tail&&d.now()>=next.funding){next.funding=t+300000;await request("funding",()=>d.get("funding"),async r=>{
        const rows=normalize(r,"funding-settled",metadataCache.fundingIntervalMs);
        for(const row of rows)await record(row,false);
        await save("funding-coverage",{observedTimestamp:r.receivedTimestamp,intervalMs:metadataCache.fundingIntervalMs,
          ...expectedMissing(Math.min(...rows.map(r=>r.sourceTimestamp!)),Math.max(...rows.map(r=>r.sourceTimestamp!)),metadataCache.fundingIntervalMs,rows.map(r=>r.sourceTimestamp!))});
      });}
      if(valid&&!tail&&d.now()>=next.current){next.current=t+30000;await request("current-funding",()=>d.get("ticker"),async r=>{
        for(const row of normalize(r,"funding-current",metadataCache.fundingIntervalMs))await record(row,false);
      });}
      // One bounded catch-up page per minute; never silently jump cursor past a failed page.
      if(valid&&d.now()>=next.backfill){
        next.backfill=t+60000;const channel=tail?"price":(["oi","funding","price"] as const)[backfillChannel++%3]!;
        const to=Math.min(state.cursors[channel]+6*3600000,d.now()-60000),from=state.cursors[channel];
        if(to>from){
          const ok=await request(`backfill-${channel}`,()=>d.history(channel,{from,to}),async r=>{
            if(channel==="price")await archivePrices(r);
            else if(channel==="oi")await oiRecords(r,true);
            else if(r.raw.result.list.length)for(const row of normalize(r,"funding-settled",metadataCache.fundingIntervalMs))await record(row,true);
            await save("backfill-window",{channel,from,to,receivedTimestamp:r.receivedTimestamp,returned:r.raw.result.list.length,
              sourceComplete:false,reason:"Successful request is not proof of no missing source rows"});
          });
          if(ok)state.cursors[channel]=to; // overlap endpoint on next page
        }
      }
      if(d.now()>=next.health){next.health=d.now()+5000;await save("health",{observedTimestamp:d.now(),subscribed:connection.subscribed,lastPong:connection.lastPong,
        gap:connection.gap,metrics,storage:archive.stats(),eventCompleteness:"unknown",tail});await checkpoint();}
      await d.sleep(250);
    }
    stopping=true;activeSocket()?.close();socket=null;
    await save("gap",{start:d.now(),end:null,reason:"observer-stopped",series:"liquidation",recoverable:false});
    await checkpoint(true);await archive.flush();
    return {status:options.signal?.aborted?"stopped":"completed",metrics,storage:archive.stats(),endAt:state.endAt};
  } finally {stopping=true;activeSocket()?.close();await archive.flush().catch(()=>{});await lock.close();}
}
