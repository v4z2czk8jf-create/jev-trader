import { MARKET, type Kind, type Observation } from "./types";
import { numeric, timestamp, observation } from "./quality";

export const REST = "https://api.bybit.com";
export const WS = "wss://stream.bybit.com/v5/public/linear";
export const TOPIC = "allLiquidation.MONUSDT";
export const PATHS = {
  instrument: "/v5/market/instruments-info", oi: "/v5/market/open-interest",
  funding: "/v5/market/funding/history", ticker: "/v5/market/tickers",
} as const;
type Envelope = {retCode:number;time:number;result:{category?:string;symbol?:string;list:any[];nextPageCursor?:string}};
export interface Response { raw: Envelope; requestedTimestamp:number; receivedTimestamp:number; latencyMs:number; source:string }
export async function publicGet(endpoint: keyof typeof PATHS, fetcher: (url: URL, options: RequestInit) => Promise<globalThis.Response> = fetch): Promise<Response> {
  if (!Object.hasOwn(PATHS,endpoint)) throw Error("Public endpoint not allowlisted");
  const url = new URL(PATHS[endpoint],REST);
  url.searchParams.set("category","linear"); url.searchParams.set("symbol",MARKET.symbol);
  if(endpoint==="oi"){url.searchParams.set("intervalTime","5min");url.searchParams.set("limit","12");}
  if(endpoint==="funding")url.searchParams.set("limit","3");
  const requestedTimestamp=Date.now();
  const response=await fetcher(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error(`Public HTTP ${response.status}`);
  const raw=await response.json() as Envelope,receivedTimestamp=Date.now();
  if(raw.retCode!==0 || !Array.isArray(raw.result?.list))throw Error("Public API response invalid");
  timestamp(raw.time);
  return {raw,requestedTimestamp,receivedTimestamp,latencyMs:receivedTimestamp-requestedTimestamp,source:url.toString()};
}
export function instrument(response: Response) {
  const r=response.raw.result.list;
  if(r.length!==1)throw Error("Ambiguous instrument");
  const m=r[0];
  if(m.symbol!==MARKET.symbol || m.baseCoin!=="MON" || m.quoteCoin!=="USDT" || m.settleCoin!=="USDT" ||
    m.contractType!=="LinearPerpetual" || m.status!=="Trading" || m.isPreListing!==false)throw Error("Instrument identity/status mismatch");
  const fundingIntervalMs=numeric(m.fundingInterval)*60000;
  if(fundingIntervalMs<=0)throw Error("Invalid funding interval");
  return {fundingIntervalMs,raw:m};
}
export function normalize(response: Response, kind: Exclude<Kind,"liquidation">, fundingIntervalMs: number): Observation[] {
  const {raw,source,receivedTimestamp:r}=response;
  if(raw.result.category!==undefined && raw.result.category!=="linear")throw Error("Wrong category");
  if(raw.result.symbol!==undefined && raw.result.symbol!==MARKET.symbol)throw Error("Wrong symbol");
  if(!raw.result.list.length)throw Error("Empty dataset");
  return raw.result.list.map(row=>{
    if(kind!=="oi" && row.symbol!==MARKET.symbol)throw Error("Wrong row symbol");
    if(kind==="oi") {
      const n=numeric(row.openInterest); if(n<0)throw Error("Negative OI");
      return observation(kind,row,{openInterest:row.openInterest,unit:"MON",aggregation:"both-sides",intervalMs:300000,
        singleOpenInterest:row.singleOpenInterest??null,usdtValue:null},source,timestamp(row.timestamp),r,raw.time,420000,"bucket");
    }
    numeric(row.fundingRate);
    if(kind==="funding-settled")return observation(kind,row,{rate:row.fundingRate,rateUnit:"fraction",fundingIntervalMs,
      historical:true,freshnessRole:"latest-settlement; older rows remain valid history"},source,timestamp(row.fundingRateTimestamp),r,raw.time,fundingIntervalMs+600000,"settlement");
    return observation(kind,row,{rate:row.fundingRate,rateUnit:"fraction",nextFundingTimestamp:timestamp(row.nextFundingTime),
      fundingIntervalMs,markPrice:row.markPrice,indexPrice:row.indexPrice,priceUnit:"USDT",transportAvailable:true},source,null,r,raw.time,90000,"unknown");
  });
}
export function liquidations(message: any, received: number): Observation[] {
  if(message.topic!==TOPIC || !Array.isArray(message.data))throw Error("Wrong liquidation topic/data");
  return message.data.map((raw:any)=>{
    if(raw.s!==MARKET.symbol || !["Buy","Sell"].includes(raw.S))throw Error("Unknown liquidation symbol/side");
    if(numeric(raw.v)<=0 || numeric(raw.p)<=0)throw Error("Invalid liquidation size/price");
    return observation("liquidation",raw,{rawSide:raw.S,liquidatedPositionDirection:raw.S==="Buy"?"LONG":"SHORT",
      size:raw.v,sizeUnit:"MON",bankruptcyPrice:raw.p,priceUnit:"USDT",executionPrice:null},WS,
      timestamp(raw.T),received,timestamp(message.ts),5000,"event");
  });
}
/** No event count is inferred from transport health, and no reconnect backfill is claimed. */
export class LiquidationHealth {
  connectedAt:number|null=null; subscribedAt:number|null=null; lastPong:number|null=null;
  closedAt:number|null=null; errors=0; pongs=0;
  snapshot(now:number) {
    const healthy=this.subscribedAt!==null && this.closedAt===null && this.errors===0 && now-(this.lastPong??this.subscribedAt)<=45000;
    return {status:healthy?"available":"unavailable",connectedAt:this.connectedAt,subscribedAt:this.subscribedAt,
      lastPong:this.lastPong,pongs:this.pongs,closedAt:this.closedAt,errors:this.errors,
      coverage:"transport-only; no sequence IDs, event completeness cannot be proven",healthy};
  }
}
