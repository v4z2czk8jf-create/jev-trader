import { MARKET } from "../types";
import { REST,PATHS,type Response } from "../bybit-source";
import { numeric,timestamp } from "../quality";
import { MARKET_KEY,MINUTE,type PriceBar } from "./evaluation";
export type Channel="oi"|"funding"|"price";
export interface Window {from:number;to:number}
/** Bounded public history window: six hours fits OI 200, funding 200, kline 1000. */
export async function historyGet(channel:Channel,window:Window,fetcher:(url:URL,options:RequestInit)=>Promise<globalThis.Response>=fetch):Promise<Response> {
  if(!["oi","funding","price"].includes(channel)||!Number.isSafeInteger(window.from)||!Number.isSafeInteger(window.to)||window.from<1e12||window.to<window.from||window.to-window.from>6*3600000)throw Error("Invalid history window/channel");
  const url=new URL(channel==="price"?"/v5/market/kline":PATHS[channel],REST);
  url.searchParams.set("category","linear");url.searchParams.set("symbol",MARKET.symbol);
  url.searchParams.set(channel==="price"?"start":"startTime",String(window.from));
  url.searchParams.set(channel==="price"?"end":"endTime",String(window.to));
  url.searchParams.set("limit",channel==="price"?"1000":"200");
  if(channel==="oi")url.searchParams.set("intervalTime","5min");
  if(channel==="price")url.searchParams.set("interval","1");
  const requestedTimestamp=Date.now();
  const result=await fetcher(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!result.ok)throw Error(`Public history HTTP ${result.status}`);
  const raw=await result.json() as Response["raw"],receivedTimestamp=Date.now();
  if(raw.retCode!==0||!Array.isArray(raw.result?.list))throw Error("Invalid public history result");
  if(raw.result.category!==undefined&&raw.result.category!=="linear")throw Error("Wrong history category");
  if(channel!=="funding"&&raw.result.symbol!==MARKET.symbol)throw Error("Wrong history identity");
  if(raw.result.list.length>=(channel==="price"?1000:200))throw Error("History window possibly truncated; not claiming coverage");
  timestamp(raw.time);
  return {raw,source:url.toString(),requestedTimestamp,receivedTimestamp,latencyMs:receivedTimestamp-requestedTimestamp};
}
export function priceBars(response:Response):PriceBar[] {
  if(response.raw.result.symbol!==MARKET.symbol||response.raw.result.category!=="linear")throw Error("Wrong price market");
  return response.raw.result.list.flatMap(row=>{
    const start=timestamp(row[0]),end=start+MINUTE;
    if(start%MINUTE)throw Error("Unaligned candle timestamp");
    // Bybit close is still changing for an unclosed candle. Never archive it as final.
    if(end>Math.min(response.receivedTimestamp,response.raw.time))return [];
    const [open,high,low,close]=[1,2,3,4].map(i=>numeric(row[i])) as [number,number,number,number];
    if(low<=0||low>Math.min(open,close)||high<Math.max(open,close))throw Error("Invalid OHLC");
    return [{marketKey:MARKET_KEY,start,end,open,high,low,close,receivedTimestamp:response.receivedTimestamp,raw:row}];
  }).sort((a,b)=>a.start-b.start);
}
