import type { SRCandidate } from "./sr-candidates";
import type { Candle } from "./types";
export interface SRReplay {
  id:string; recognizedAt:number; validatedAt:number|null;
  events:{type:"BREAK"|"FAILURE"|"RETEST";timestamp:number;price:number}[];
  horizons:Record<string,{status:"available"|"unavailable";reason?:string;mfePct?:number;maePct?:number;anchorTimestamp:number|null;anchorPrice:number|null}>;
}
/** Retrospective outcomes are separate from recognition and never influence candidates.
 * Evaluation uses only fully closed, contiguous candles available at asOf.
 */
export function replaySR(candidate:SRCandidate,history:Candle[],asOf:number):SRReplay {
  const cs=history.filter(c=>c.end<=asOf),events:SRReplay["events"]=[];
  const start=candidate.validatedAt,anchor=start===null?undefined:cs.find(c=>c.end===start);
  const sign=candidate.kind==="resistance"?1:-1,buffer=(candidate.touches.find(t=>t.confirmedAt===start)?.atr??0)*0.25;
  let broken=false,retested=false,previous=anchor;
  if(anchor)for(const c of cs.filter(x=>x.start>=anchor.end)){
    if(!previous||previous.end!==c.start)break;
    const beyond=(c.close-candidate.price)*sign>buffer,wasBeyond=(previous.close-candidate.price)*sign>buffer;
    if(!broken&&beyond&&!wasBeyond){events.push({type:"BREAK",timestamp:c.end,price:c.close});broken=true;retested=false;}
    else if(broken&&(c.close-candidate.price)*sign< -buffer){events.push({type:"FAILURE",timestamp:c.end,price:c.close});broken=false;}
    else if(broken&&!retested&&c.low<=candidate.price+buffer&&c.high>=candidate.price-buffer){events.push({type:"RETEST",timestamp:c.end,price:c.close});retested=true;}
    previous=c;
  }
  const horizons:SRReplay["horizons"]={};
  for(const minutes of [30,60,240,1440]){
    const output:SRReplay["horizons"][string]={status:"unavailable",anchorTimestamp:anchor?.end??null,anchorPrice:anchor?.close??null,reason:"Recognition outcome not yet fully observed at candle resolution"};
    if(anchor){const end=anchor.end+minutes*60000,window=cs.filter(c=>c.start>=anchor.end&&c.end<=end);
      if(end<=asOf&&window.length&&window[0]!.start===anchor.end&&window.at(-1)!.end===end&&window.every((c,i)=>i===0||window[i-1]!.end===c.start)){
        const returns=window.flatMap(c=>[(c.high/anchor.close-1)*100*sign,(c.low/anchor.close-1)*100*sign]);
        output.status="available";delete output.reason;output.mfePct=Math.max(0,...returns);output.maePct=Math.min(0,...returns);
      }
    }horizons[minutes]=output;
  }
  return {id:candidate.id,recognizedAt:candidate.recognizedAt,validatedAt:start,events,horizons};
}
