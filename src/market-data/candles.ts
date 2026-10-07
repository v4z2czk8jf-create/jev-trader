import { INTERVALS, type Candle, type History, type ClosedInterval } from "./types";

/** Complete intervals, including proved empty ones. Never invent OHLC. */
export function closedIntervals(history: History, interval: number, asOf: number): ClosedInterval[] {
  const start = Math.ceil((history.rawFromTimestamp ?? history.fromTimestamp) / interval) * interval;
  const end = Math.floor(Math.min(history.throughTimestamp, asOf) / interval) * interval;
  const buckets = new Map<number, Candle>();
  const ids = new Map<string, string>();
  for (const t of [...history.trades].sort((a,b) => a.timestamp-b.timestamp || a.block-b.block || Number(a.id.split(":").at(-1))-Number(b.id.split(":").at(-1)))) {
    const fingerprint = JSON.stringify(t);
    if (ids.has(t.id)) { if (ids.get(t.id) !== fingerprint) throw Error("Conflicting duplicate trade"); continue; }
    ids.set(t.id, fingerprint);
    if (![t.price,t.volume,t.timestamp].every(Number.isFinite) || t.price <= 0 || t.volume < 0) throw Error("Invalid trade");
    if (t.timestamp < start || t.timestamp >= end || t.volume === 0) continue;
    const k = Math.floor(t.timestamp / interval) * interval, c = buckets.get(k);
    if(c) { c.high=Math.max(c.high,t.price); c.low=Math.min(c.low,t.price); c.close=t.price; c.volume+=t.volume; c.quoteVolume+=t.price*t.volume; c.trades++; }
    else buckets.set(k,{start:k,end:k+interval,open:t.price,high:t.price,low:t.price,close:t.price,volume:t.volume,quoteVolume:t.price*t.volume,trades:1});
  }
  const out: ClosedInterval[]=[];
  for(let k=start;k<end;k+=interval) out.push({start:k,end:k+interval,candle:buckets.get(k)??null});
  return out;
}

/** UTC-aligned CLOSED candles, with proven continuous block coverage.
 * Empty intervals have no OHLC and break indicator continuity; no forward filling.
 */
export function candles(history: History, interval: number, asOf: number): { series: Candle[]; latestVolume: number | null; latestEnd: number | null } {
  const start = Math.ceil(history.fromTimestamp / interval) * interval;
  const end = Math.floor(Math.min(history.throughTimestamp, asOf) / interval) * interval;
  if (end <= start) return { series: [], latestVolume: null, latestEnd: null };
  if (history.closed) {
    const tf = (Object.keys(INTERVALS) as (keyof typeof INTERVALS)[]).find(k=>INTERVALS[k]===interval);
    const entries = new Map((tf ? history.closed[tf] ?? [] : []).filter(c=>c.end<=end).map(c=>[c.start,c]));
    for(const c of closedIntervals(history,interval,asOf)) entries.set(c.start,c);
    const series: Candle[]=[];
    for(let k=end-interval;k>=start;k-=interval) { const c=entries.get(k)?.candle; if(!c)break; series.unshift(c); }
    const latest=entries.get(end-interval);
    return {series,latestVolume:latest ? latest.candle?.volume ?? 0 : null,latestEnd:latest ? end : null};
  }
  const buckets = new Map<number, Candle>();
  const ids = new Map<string, string>();
  const sorted = [...history.trades].sort((a, b) => a.timestamp - b.timestamp || a.block - b.block || Number(a.id.split(":").at(-1)) - Number(b.id.split(":").at(-1)));
  for (const t of sorted) {
    const fingerprint = JSON.stringify(t);
    if (ids.has(t.id)) { if (ids.get(t.id) !== fingerprint) throw Error("Conflicting duplicate trade"); continue; }
    ids.set(t.id, fingerprint);
    if (![t.price, t.volume, t.timestamp].every(Number.isFinite) || t.price <= 0 || t.volume < 0) throw Error("Invalid trade");
    if (t.timestamp < start || t.timestamp >= end || t.volume === 0) continue;
    const k = Math.floor(t.timestamp / interval) * interval;
    const c = buckets.get(k);
    if (c) { c.high = Math.max(c.high, t.price); c.low = Math.min(c.low, t.price); c.close = t.price; c.volume += t.volume; c.quoteVolume += t.price * t.volume; c.trades++; }
    else buckets.set(k, { start: k, end: k + interval, open: t.price, high: t.price, low: t.price, close: t.price, volume: t.volume, quoteVolume: t.price * t.volume, trades: 1 });
  }
  // Only the contiguous suffix ending at the expected latest closed interval is valid.
  const series: Candle[] = [];
  for (let k = end - interval; k >= start; k -= interval) { const c = buckets.get(k); if (!c) break; series.unshift(c); }
  return { series, latestVolume: buckets.get(end - interval)?.volume ?? 0, latestEnd: end };
}
