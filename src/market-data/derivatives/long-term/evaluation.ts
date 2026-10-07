import { MARKET } from "../types";

export const MINUTE = 60_000;
export const HORIZONS = [30 * MINUTE, 60 * MINUTE, 240 * MINUTE, 1440 * MINUTE] as const;
export interface PriceBar {
  marketKey: string; start: number; end: number; receivedTimestamp: number;
  open: number; high: number; low: number; close: number; raw: unknown;
}
export const MARKET_KEY = `${MARKET.exchange}:${MARKET.marketType}:${MARKET.symbol}`;
export interface Anchor {
  id: string; marketKey: string; anchorTimestamp: number;
  referencePrice: number | null; referenceTimestamp: number | null;
  referenceReceivedTimestamp: number | null; referenceKind: "last-closed-1m-close";
  sourceObservation: unknown;
}
export function makeAnchor(id: string, at: number, bars: PriceBar[], sourceObservation: unknown): Anchor {
  const b = bars.filter(b => b.marketKey === MARKET_KEY && b.end <= at && b.receivedTimestamp <= at && at - b.end <= 120_000)
    .sort((a,b) => b.end - a.end)[0];
  return { id, marketKey: MARKET_KEY, anchorTimestamp: at, referencePrice: b?.close ?? null,
    referenceTimestamp: b?.end ?? null, referenceReceivedTimestamp: b?.receivedTimestamp ?? null,
    referenceKind: "last-closed-1m-close", sourceObservation };
}

/** Offline outcome labels, never online evidence. Both boundary-crossing bars excluded. */
export function evaluateOutcome(anchor: Anchor, bars: PriceBar[], horizon: number, evaluatedAt: number) {
  if (!(HORIZONS as readonly number[]).includes(horizon)) throw Error("Unsupported horizon");
  const start = Math.ceil(anchor.anchorTimestamp / MINUTE) * MINUTE;
  const target = anchor.anchorTimestamp + horizon;
  const end = Math.floor(target / MINUTE) * MINUTE;
  const candidates = bars.filter(b => b.marketKey === anchor.marketKey && b.start >= start && b.end <= end &&
    b.end <= evaluatedAt && b.receivedTimestamp <= evaluatedAt);
  const selected = new Map<number, PriceBar>(); let conflict = false;
  for (const b of candidates) {
    if (b.start % MINUTE || b.end !== b.start + MINUTE || b.receivedTimestamp < b.end ||
      ![b.open,b.high,b.low,b.close].every(n=>Number.isFinite(n)&&n>0) || b.low > Math.min(b.open,b.close) || b.high < Math.max(b.open,b.close)) { conflict = true; continue; }
    const prior=selected.get(b.start);
    if(prior && ["open","high","low","close"].some(k=>prior[k as "open"]!==b[k as "open"]))conflict=true;
    if(!prior || b.receivedTimestamp<prior.receivedTimestamp)selected.set(b.start,b);
  }
  const used=[...selected.values()].sort((a,b)=>a.start-b.start);
  const missing:number[]=[];for(let t=start;t<end;t+=MINUTE)if(!selected.has(t))missing.push(t);
  const validReference=anchor.marketKey===MARKET_KEY && anchor.referencePrice!==null && Number.isFinite(anchor.referencePrice) && anchor.referencePrice>0 &&
    anchor.referenceTimestamp!==null && anchor.referenceTimestamp<=anchor.anchorTimestamp &&
    anchor.referenceReceivedTimestamp!==null && anchor.referenceReceivedTimestamp<=anchor.anchorTimestamp;
  const status=evaluatedAt<target?"pending":!validReference||conflict?"unavailable":missing.length||!used.length?"incomplete":"complete";
  const complete=status==="complete",ref=anchor.referencePrice??NaN;
  const high=complete?Math.max(...used.map(b=>b.high)):NaN,low=complete?Math.min(...used.map(b=>b.low)):NaN;
  return {schemaVersion:1,mode:"offline-outcome-only",anchorId:anchor.id,marketKey:anchor.marketKey,
    anchorTimestamp:anchor.anchorTimestamp,evaluationStartTimestamp:start,evaluationStartDelayMs:start-anchor.anchorTimestamp,
    targetTimestamp:target,evaluatedAt,horizonMs:horizon,status,conflict,missingBarStarts:missing,
    priceDataRange:{start:used[0]?.start??null,end:used.at(-1)?.end??null,barCount:used.length,
      barStarts:used.map(b=>b.start),maxReceivedTimestamp:used.length?Math.max(...used.map(b=>b.receivedTimestamp)):null},
    referencePrice:anchor.referencePrice,referenceTimestamp:anchor.referenceTimestamp,
    referenceReceivedTimestamp:anchor.referenceReceivedTimestamp,referenceKind:anchor.referenceKind,
    endpointTimestamp:complete?end:null,endpointLagMs:target-end,
    priceChangePct:complete?(used.at(-1)!.close/ref-1)*100:null,
    long:complete?{mfePct:Math.max(0,high/ref-1)*100,maePct:Math.max(0,1-low/ref)*100}:null,
    short:complete?{mfePct:Math.max(0,1-low/ref)*100,maePct:Math.max(0,high/ref-1)*100}:null};
}

/** Exact OI timestamps join to the close of a price bar ending at that timestamp. */
export function alignChanges(previous:{time:number;oi:number},current:{time:number;oi:number},bars:PriceBar[],at:number) {
  const price=(t:number)=>bars.filter(b=>b.marketKey===MARKET_KEY&&b.end===t&&b.receivedTimestamp<=at).sort((a,b)=>a.receivedTimestamp-b.receivedTimestamp)[0];
  const p=price(previous.time),c=price(current.time);
  const available=previous.oi>0&&current.oi>=0&&Number.isFinite(current.oi)&&current.time-previous.time===300000&&!!p&&!!c&&current.time<=at;
  return {marketKey:MARKET_KEY,fromTimestamp:previous.time,toTimestamp:current.time,receivedTimestamp:at,
    status:available?"available":"unavailable",reason:available?null:"Missing exact 5m OI/price endpoints",
    oiUnit:"MON",oiChangePct:available?(current.oi/previous.oi-1)*100:null,
    priceChangePct:available?(c!.close/p!.close-1)*100:null,
    priceEndpoints:available?[{end:p!.end,close:p!.close,receivedTimestamp:p!.receivedTimestamp},{end:c!.end,close:c!.close,receivedTimestamp:c!.receivedTimestamp}]:[]};
}
