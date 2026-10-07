import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { abiBytesPayload, decodeL2Book, decodeVaultParams, formatLevels, ammLevels, vaultActive, log10, SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS, type Level, type BookParams } from "../book";
import { publicRpc, type Rpc } from "./rpc-source";
import type { Quality } from "./types";
import { missing } from "./adapter";
const bookMissing=<T>(source:string,reason:string,now:number):Quality<T>=>({...missing<T>(source,reason,now),timeBasis:"chain_snapshot"});

export interface Depth { bidBase:number; askBase:number; bidQuote:number; askQuote:number; imbalance:number|null; coverage:"complete"|"incomplete"; status:"available"|"unavailable"; imbalanceStatus:"available"|"unavailable" }
export interface BookMetrics { bid:number; ask:number; mid:number; spread:number; spreadBps:number; levels:{bids:Level[];asks:Level[]}; depth:Record<string,Depth>; vaultActive:boolean; thinness:Quality<Record<string,{bidRatio:number;askRatio:number;bidThin:boolean;askThin:boolean}>> }
export interface BookObservation { data:Quality<BookMetrics>; block:number|null; blockHash:string|null; finality:"finalized"; requestedTimestamp:number|null; completedTimestamp:number|null; acquisitionMs:number|null; intervalMs:5000; metrics:{attempts:number;successes:number;failures:number;rpcCalls:number;rpcFailures:number;rpcTotalMs:number;acquisitionTotalMs:number;maxAcquisitionMs:number;missingRate:number;elapsedMs:number;rpcPerSecond:number}; }
export function bookMetrics(bids:Level[],asks:Level[]):Omit<BookMetrics,"thinness"|"vaultActive"> {
  if(!bids.length||!asks.length||[...bids,...asks].some(([p,s])=>!Number.isFinite(p)||!Number.isFinite(s)||p<=0||s<0))throw Error("Invalid or empty book side");
  bids=[...bids].sort((a,b)=>b[0]-a[0]); asks=[...asks].sort((a,b)=>a[0]-b[0]);
  const bid=bids[0]![0],ask=asks[0]![0],mid=(bid+ask)/2;
  if(bid>=ask)throw Error("Crossed or locked book");
  const depth:Record<string,Depth>={};
  for(const band of [10,25,50,100]){
    const sum=(side:Level[])=>side.filter(([p])=>Math.abs(p-mid)/mid*10000<=band).reduce((a,[p,s])=>[a[0]!+s,a[1]!+p*s],[0,0]);
    const b=sum(bids),a=sum(asks),total=b[0]!+a[0]!;
    depth[band]={bidBase:b[0]!,askBase:a[0]!,bidQuote:b[1]!,askQuote:a[1]!,imbalance:total ? (b[0]!-a[0]!)/total : null,coverage:"complete",status:"available",imbalanceStatus:total?"available":"unavailable"};
  }
  return {bid,ask,mid,spread:ask-bid,spreadBps:(ask-bid)/mid*10000,depth,levels:{bids:bids.slice(0,5),asks:asks.slice(0,5)}};
}
/** Full getL2Book: block, bid pairs, zero separator, ask pairs to ABI-declared end.
 * Kuru's contract has no trailing ask terminator. Validate declared length first.
 */
export function validateL2(raw:string){
  if(!/^0x[0-9a-f]+$/i.test(raw))throw Error("Invalid L2 encoding");
  if(BigInt("0x"+raw.slice(2,66))!==32n)throw Error("Invalid L2 ABI offset");
  const declared=Number(BigInt("0x"+raw.slice(66,130)));
  if(!Number.isSafeInteger(declared)||declared<64||declared%32||raw.length!==130+declared*2)throw Error("Truncated L2 ABI length");
  const data=abiBytesPayload(raw); if((data.length-2)%64)throw Error("Truncated L2 words");
  let i=66;
  for(let side=0;side<2;side++){
    let ended=false;
    while(i<data.length){const price=BigInt("0x"+data.slice(i,i+64));i+=64;if(price===0n){ended=true;break;}if(i+64>data.length)throw Error("Missing size");i+=64;}
    if(!ended&&side===0)throw Error("Missing bid/ask separator");
  }
  if(i!==data.length)throw Error("Unexpected L2 tail");
}
const median=(a:number[])=>{const s=[...a].sort((x,y)=>x-y);return (s[Math.floor((s.length-1)/2)]!+s[Math.floor(s.length/2)]!)/2;};
export function thinness(current:BookMetrics["depth"],baseline:BookMetrics["depth"][]):Record<string,{bidRatio:number;askRatio:number;bidThin:boolean;askThin:boolean}>|null {
  if(baseline.length<60)return null;
  const out:Record<string,{bidRatio:number;askRatio:number;bidThin:boolean;askThin:boolean}>={};
  for(const [k,d] of Object.entries(current)){
    if(d.coverage!=="complete"||baseline.some(x=>!x[k]||x[k]!.coverage!=="complete"))return null;
    const b=median(baseline.map(x=>x[k]!.bidQuote)),a=median(baseline.map(x=>x[k]!.askQuote));
    if(b<=0||a<=0)return null;
    out[k]={bidRatio:d.bidQuote/b,askRatio:d.askQuote/a,bidThin:d.bidQuote/b<0.25,askThin:d.askQuote/a<0.25};
  }return out;
}
export class BookSource {
  private params:BookParams|undefined;private next=0;private pending:Promise<void>|null=null;
  private latest:BookObservation|undefined;private error="Book not acquired";private baseline:{at:number;depth:BookMetrics["depth"]}[]=[];
  private attemptStart:number|null=null;private attemptEnd:number|null=null;
  private started=Date.now();private counts={attempts:0,successes:0,failures:0,rpcCalls:0,rpcFailures:0,rpcTotalMs:0,acquisitionTotalMs:0,maxAcquisitionMs:0};
  readonly source:string;
  constructor(readonly market:string,private rpc:Rpc=publicRpc()){if(!/^0x[0-9a-f]{40}$/i.test(market))throw Error("Invalid market");this.source=`monad:143:kuru:${market.toLowerCase()}:finalized-book`;}
  private async call(method:string,params:unknown[]){const start=Date.now();this.counts.rpcCalls++;try{return await this.rpc(method,params);}catch(e){this.counts.rpcFailures++;throw e;}finally{this.counts.rpcTotalMs+=Date.now()-start;}}
  snapshot(now=Date.now()):BookObservation{
    const elapsedMs=Math.max(1,now-this.started), metrics={...this.counts,missingRate:this.counts.attempts?this.counts.failures/this.counts.attempts:0,elapsedMs,rpcPerSecond:this.counts.rpcCalls/elapsedMs*1000};
    let data:Quality<BookMetrics>=bookMissing(this.source,this.error,now);
    if(!this.error&&this.latest){const q=this.latest.data;const age=now-q.sourceTimestamp!;data={...q,ageMs:age,status:age>5000?"stale":"available",...(age>5000?{reason:"Finalized book older than 5s"}:{})} as Quality<BookMetrics>;
      if("value" in data&&"value" in data.value.thinness)data={...data,value:{...data.value,thinness:{...data.value.thinness,ageMs:age,status:age>5000?"stale":"available"}}};
    }
    return {...(this.latest??{block:null,blockHash:null}),...(this.error?{block:null,blockHash:null}:{}),requestedTimestamp:this.attemptStart,completedTimestamp:this.attemptEnd,acquisitionMs:this.attemptStart!==null&&this.attemptEnd!==null?this.attemptEnd-this.attemptStart:null,data,finality:"finalized",intervalMs:5000,metrics};
  }
  async refresh(){if(this.pending)return this.pending;if(Date.now()<this.next)return;
    const start=Date.now();this.attemptStart=start;this.attemptEnd=null;this.counts.attempts++;
    this.pending=this.acquire(start).catch((e:unknown)=>{this.error=e instanceof Error?e.message:"Book read failed";this.counts.failures++;}).finally(()=>{
      this.attemptEnd=Date.now();const ms=this.attemptEnd-start;this.counts.acquisitionTotalMs+=ms;this.counts.maxAcquisitionMs=Math.max(this.counts.maxAcquisitionMs,ms);
      this.next=Math.max(start+5000,Date.now()+(this.error?5000:0));this.pending=null;
    });return this.pending;
  }
  private async acquire(start:number){
    if(!this.params&&Number(BigInt(await this.call("eth_chainId",[])))!==143)throw Error("Wrong chain");
    const head=await this.call("eth_getBlockByNumber",["finalized",false]);
    const block=Number(BigInt(head.number)),timestamp=Number(BigInt(head.timestamp))*1000;
    if(!Number.isSafeInteger(block)||!Number.isFinite(timestamp)||timestamp>Date.now()||!/^0x[0-9a-f]{64}$/i.test(head.hash))throw Error("Invalid book header");
    if(!this.params){const iface=new ethers.utils.Interface(OrderBookAbi.abi);const raw=await this.call("eth_call",[{to:this.market,data:iface.encodeFunctionData("getMarketParams",[])},head.number]);
      const p=iface.decodeFunctionResult("getMarketParams",raw),params={pricePrecision:p[0],sizePrecision:p[1],tickSize:p[6]};
      for(const x of Object.values(params))if(!/^10*$/.test(x.toString()))throw Error("Unsupported precision or tick; refuse rounding guess");
      this.params=params;
    }
    const raw=await this.call("eth_call",[{to:this.market,data:SEL_GET_L2_BOOK},head.number]);validateL2(raw);
    const l2=decodeL2Book(raw,log10(this.params.pricePrecision),log10(this.params.sizePrecision));if(l2.block!==block)throw Error("Book/header block mismatch");
    const vaultRaw=await this.call("eth_call",[{to:this.market,data:SEL_GET_VAULT_PARAMS},head.number]);if(!/^0x[0-9a-f]{512}$/i.test(vaultRaw))throw Error("Invalid vault payload");
    const vault=decodeVaultParams(vaultRaw),active=vaultActive(vault),levels=formatLevels(l2,this.params,vault),base=bookMetrics(levels.bids,levels.asks);
    if(active){const ladder=ammLevels(vault,log10(this.params.sizePrecision));for(const [band,d] of Object.entries(base.depth)){
      if(!ladder.bids.length||!ladder.asks.length||ladder.bids.at(-1)![0]>base.mid*(1-Number(band)/10000)||ladder.asks.at(-1)![0]<base.mid*(1+Number(band)/10000)){d.coverage="incomplete";d.imbalance=null;d.status="unavailable";d.imbalanceStatus="unavailable";}
    }}
    const now=Date.now(),age=now-timestamp;
    this.baseline=this.baseline.filter(x=>timestamp-x.at<=600000&&timestamp-x.at>=0);
    const prior=this.baseline.filter(x=>x.at<timestamp);
    const ratios=prior.length>=60&&timestamp-prior[0]!.at>=300000?thinness(base.depth,prior.map(x=>x.depth)):null;
    const q=<T>(value:T):Quality<T>=>({status:age>5000?"stale":"available",source:this.source,value,observedAt:timestamp,maxAgeMs:5000,sourceTimestamp:timestamp,receivedTimestamp:now,ageMs:age,timeBasis:"chain_snapshot",trace:{formula:"same finalized block; book+vault"}});
    const data=q({...base,vaultActive:active,thinness:ratios?{...q(ratios),trace:{formula:"current quote depth / median of prior same-side same-band quote depth; thin <0.25; current excluded",samplesUsed:prior.length,windowStart:prior[0]?.at,windowEnd:prior.at(-1)?.at}}:bookMissing<Record<string,{bidRatio:number;askRatio:number;bidThin:boolean;askThin:boolean}>>(this.source,"Need 60 prior complete samples spanning >=5 minutes within 10 minutes and positive median depth",now)});
    if(age<=5000&&!this.baseline.some(x=>x.at===timestamp))this.baseline.push({at:timestamp,depth:base.depth});
    this.latest={data,block,blockHash:head.hash,finality:"finalized",requestedTimestamp:start,completedTimestamp:now,acquisitionMs:now-start,intervalMs:5000,metrics:this.snapshot(now).metrics};this.error="";this.counts.successes++;
  }
}
