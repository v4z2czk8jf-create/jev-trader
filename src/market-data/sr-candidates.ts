import type { Candle } from "./types";
import { atr } from "./indicators";
export interface SRCandidate {
  id:string; kind:"support"|"resistance";price:number;firstPivotTimestamp:number;recognizedAt:number;
  touches:{pivotTimestamp:number;confirmedAt:number;atr:number;reactionAtr:number}[];
  validatedAt:number|null;candidateOnly:true;distancePct:number;validationRule:"pivot-2+2; two touches >=5 bars apart; reaction>=1ATR; cluster<=0.5ATR";
}
/** Prefix replay: a pivot is only visible after its two RIGHT bars close.
 * Cluster anchor never moves and confirmedAt is never backdated to the pivot.
 */
export function srCandidates(input:Candle[],asOf:number):SRCandidate[]{
  const cs=input.filter(c=>c.end<=asOf);
  for(let i=0;i<cs.length;i++){const c=cs[i]!;if(!Object.values(c).every(Number.isFinite)||c.low<=0||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)||i>0&&cs[i-1]!.end!==c.start)throw Error("S/R requires valid contiguous closed candles");}
  const result:SRCandidate[]=[];
  for(let right=4;right<cs.length;right++){
    const i=right-2,c=cs[i]!,a=atr(cs.slice(0,right+1),14);if(a===null||a<=0)continue;
    const neighbours=[cs[i-2]!,cs[i-1]!,cs[i+1]!,cs[i+2]!];
    for(const kind of ["support","resistance"] as const){
      const pivot=kind==="support"?neighbours.every(x=>x.low>c.low):neighbours.every(x=>x.high<c.high);if(!pivot)continue;
      const price=kind==="support"?c.low:c.high;
      const reaction=kind==="support"?Math.max(cs[i+1]!.close,cs[i+2]!.close)-price:price-Math.min(cs[i+1]!.close,cs[i+2]!.close);
      if(reaction/a<1)continue;
      let existing=result.find(x=>x.kind===kind&&Math.abs(x.price-price)<=0.5*a);
      const confirmedAt=cs[right]!.end;
      if(!existing){existing={id:`${kind}:${c.start}`,kind,price,firstPivotTimestamp:c.start,recognizedAt:confirmedAt,touches:[],validatedAt:null,candidateOnly:true,distancePct:0,validationRule:"pivot-2+2; two touches >=5 bars apart; reaction>=1ATR; cluster<=0.5ATR"};result.push(existing);}
      if(existing.touches.length&&c.start-existing.touches.at(-1)!.pivotTimestamp<5*(c.end-c.start))continue;
      existing.touches.push({pivotTimestamp:c.start,confirmedAt,atr:a,reactionAtr:reaction/a});
      if(existing.touches.length>=2&&existing.validatedAt===null)existing.validatedAt=confirmedAt;
    }
  }
  const close=cs.at(-1)?.close;
  return result.map(c=>({...c,distancePct:close?(c.price/close-1)*100:0}));
}
