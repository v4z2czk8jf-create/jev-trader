export interface Gap {start:number;end:number|null;reason:string;series:string;recoverable:boolean}
/** Persist conservative transport gaps; heartbeat is not proof of event completeness. */
export class ConnectionState {
  gap:Gap; lastPong:number|null=null; subscribed=false; openedAt:number|null=null;
  attempts=0; nextConnect=0; lastTick:number;
  constructor(now:number,previousHeartbeat?:number){this.lastTick=now;this.gap={start:previousHeartbeat??now,end:null,reason:previousHeartbeat?"restart-or-unobserved-stop":"initial-connection",series:"liquidation",recoverable:false};}
  disconnected(now:number,reason:string):Gap {
    this.subscribed=false;this.openedAt=null;
    if(this.gap.end!==null)this.gap={start:this.lastPong??now,end:null,reason,series:"liquidation",recoverable:false};
    else this.gap={...this.gap,reason};
    const wait=Math.min(60000,1000*2**Math.min(this.attempts++,6));this.nextConnect=now+wait;
    return {...this.gap};
  }
  subscription(now:number):Gap {this.subscribed=true;this.lastPong=now;this.attempts=0;this.gap.end=now;return {...this.gap};}
  tick(now:number):Gap|null {
    const jump=now-this.lastTick;this.lastTick=now;
    if(jump>15000||jump<0)return this.disconnected(now,jump<0?"clock-reversal":"sleep-or-event-loop-gap");
    if(this.subscribed&&now-(this.lastPong??0)>45000)return this.disconnected(now,"heartbeat-expired");
    if(!this.subscribed&&this.openedAt!==null&&now-this.openedAt>15000)return this.disconnected(now,"subscription-timeout");
    return null;
  }
}
export interface OITrackerState {firstSeen:Record<string,number>;previousPoll:number|null;previousLatest:number|null}
export class OITracker {
  state:OITrackerState;
  constructor(state?:OITrackerState){this.state=state??{firstSeen:{},previousPoll:null,previousLatest:null};}
  observe(times:number[],received:number,backfilled:boolean) {
    const out=[...new Set(times)].filter(t=>t<=received&&!Object.hasOwn(this.state.firstSeen,String(t))).sort((a,b)=>a-b).map(t=>{
      this.state.firstSeen[t]=received;
      return {sourceTimestamp:t,firstObservedTimestamp:received,firstObservationDelayMs:received-t,backfilled,
        lastSuccessfulPollWithoutBucket:!backfilled&&this.state.previousLatest!==null&&t>this.state.previousLatest?this.state.previousPoll:null,
        publicationTimeExact:false};
    });
    if(!backfilled&&times.length){this.state.previousPoll=received;this.state.previousLatest=Math.max(...times);}
    return out;
  }
}
export function expectedMissing(from:number,to:number,step:number,present:number[]) {
  const set=new Set(present);let expected=0,missing=0;
  for(let t=Math.ceil(from/step)*step;t<=to;t+=step){expected++;if(!set.has(t))missing++;}
  return {from,to,expected,missing,missingRate:expected?missing/expected:null};
}
