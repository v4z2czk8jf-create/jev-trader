import { DEFAULT_POLICY } from "../signals/engine";
import type { MarketInput, TechnicalKind, TechnicalSignal, Timeframe } from "../signals/types";
import { candles } from "./candles";
import { atr, ema, macd, mean, rsi, trueRanges } from "./indicators";
import { INTERVALS, type Enrichment, type Frame, type History, type Parameters, type Quality, type Trace } from "./types";

/** Shared defaults; callers can supply a versioned profile per market, not fitted per run. */
export const PARAMETERS: Readonly<Parameters> = Object.freeze({
  emaFast: 9, emaSlow: 21, rsi: 14, macdFast: 12, macdSlow: 26, macdSignal: 9,
  bollinger: 20, bollingerSigma: 2, vwap: 20, atr: 14, volumeBaseline: 20,
  recentLevels: 5, periodLevels: 20, rangeExpansionAtr: 1.5, largeMoveAtr: 3,
  priceAnomalyAtr: 1.5, historyMaxLagMs: 60_000, candleGraceMs: 30_000,
});
const value = <T>(q: Quality<T>): T | undefined => "value" in q ? q.value : undefined;
const finiteTree = (v: unknown): boolean => typeof v === "number" ? Number.isFinite(v) : v !== null && typeof v === "object" ? Object.values(v).every(finiteTree) : true;

export function missing<T>(source: string, reason: string, received: number, trace: Trace = {}): Quality<T> {
  return { status: "unavailable", source, reason, observedAt: null, sourceTimestamp: null, receivedTimestamp: received, ageMs: null, timeBasis: "closed_candle", trace };
}

export function frame(history: History, tf: Timeframe, now: number, asOf: number, p: Parameters): Frame {
  const interval = INTERVALS[tf];
  const { series: raw, latestVolume, latestEnd } = candles(history, interval, asOf);
  const cs = raw.slice(-200), closes = cs.map(c => c.close), last = cs.at(-1);
  function q<T>(v: T | null, required: number, formula: string, used = cs.length): Quality<T> {
    const trace = { timeframe: tf, barsUsed: Math.min(used, cs.length), requiredBars: required, windowStart: cs[Math.max(0, cs.length - used)]?.start, windowEnd: latestEnd ?? undefined, formula };
    if (history.error) return missing(history.source, history.error, history.receivedTimestamp, trace);
    if (!finiteTree(v)) return missing(history.source, "Nonfinite calculated value", history.receivedTimestamp, trace);
    if (v === null || cs.length < required || latestEnd === null) return missing(history.source, `Need ${required} contiguous closed candles; have ${cs.length}; no gap filling`, history.receivedTimestamp, trace);
    const age = now - latestEnd;
    const stale = now - history.throughTimestamp > p.historyMaxLagMs || age > interval + p.candleGraceMs;
    return { status: stale ? "stale" : "available", value: v, observedAt: latestEnd, maxAgeMs: interval + p.candleGraceMs, source: history.source,
      sourceTimestamp: latestEnd, receivedTimestamp: history.receivedTimestamp, ageMs: age, timeBasis: "closed_candle", trace,
      ...(stale ? { reason: "Source coverage or closed candle is overdue" } : {}) };
  }
  const fast = ema(closes, p.emaFast), slow = ema(closes, p.emaSlow);
  const a = atr(cs.slice(0, -1), p.atr); // prior ATR: latest shock cannot inflate its own baseline
  const bands = closes.slice(-p.bollinger), middle = bands.length ? mean(bands) : 0;
  const sd = Math.sqrt(mean(bands.map(c => (c - middle) ** 2)));
  const prev = cs.slice(-(p.volumeBaseline + 1), -1), prev2 = cs.slice(-(p.volumeBaseline + 2), -2);
  const baseline = prev.length ? mean(prev.map(c => c.volume)) : 0;
  const baseline2 = prev2.length ? mean(prev2.map(c => c.volume)) : 0;
  const vw = cs.slice(-p.vwap), vwVolume = vw.reduce((s, c) => s + c.volume, 0);
  const prior = cs.slice(-(p.periodLevels + 1), -1), recent = prior.slice(-p.recentLevels);
  const hi = prior.length ? Math.max(...prior.map(c => c.high)) : 0, lo = prior.length ? Math.min(...prior.map(c => c.low)) : 0;
  const volume = q(latestVolume, 0, "sum actual base-asset filledSize in last fully covered interval", 1);
  // A proved empty interval has real zero volume even though OHLC cannot be invented.
  const result: Frame = {
    timeframe: tf, candles: q(cs.length ? cs : null, 1, "actual trades, UTC alignment, contiguous suffix"),
    priceChangePct: q(last ? (last.close / last.open - 1) * 100 : null, 1, "100*(closed candle close/open-1)", 1), volume,
    ema: q(last && fast.at(-2) !== null && slow.at(-1) != null ? { fast: fast.at(-1)!, slow: slow.at(-1)!, previousFast: fast.at(-2)! } : null, Math.max(p.emaSlow, p.emaFast + 1), `SMA-seeded EMA(${p.emaFast},${p.emaSlow})`),
    rsi: q(rsi(closes, p.rsi), p.rsi + 1, `Wilder RSI(${p.rsi}); flat=50`),
    macd: q(macd(closes, p.macdFast, p.macdSlow, p.macdSignal), p.macdSlow + p.macdSignal, `SMA-seeded MACD(${p.macdFast},${p.macdSlow},${p.macdSignal})`),
    vwap: q(vwVolume > 0 ? vw.reduce((s, c) => s + c.quoteVolume, 0) / vwVolume : null, p.vwap, "rolling exact trade notional/base volume", p.vwap),
    bollinger: q(last ? { middle, upper: middle + p.bollingerSigma * sd, lower: middle - p.bollingerSigma * sd } : null, p.bollinger, `SMA(${p.bollinger}) +/- ${p.bollingerSigma} population SD`, p.bollinger),
    atr: q(a, p.atr + 2, `Wilder ATR(${p.atr}) excluding current candle`),
    volumeAnomaly: q(last && baseline > 0 && baseline2 > 0 ? { ratio: last.volume / baseline, baseline, previousRatio: cs.at(-2)!.volume / baseline2 } : null, p.volumeBaseline + 2, "last volume / mean preceding N volumes, excluding current", p.volumeBaseline + 2),
    volatility: q(last && a && a > 0 ? { rangeToAtr: trueRanges(cs).at(-1)! / a, moveToAtr: Math.abs(last.close - last.open) / a, atrPct: a / last.open * 100 } : null, p.atr + 2, "last true range and absolute move / prior ATR"),
    levels: q(last && recent.length ? { recentHigh: Math.max(...recent.map(c => c.high)), recentLow: Math.min(...recent.map(c => c.low)), periodHigh: hi, periodLow: lo,
      highDistancePct: (hi / last.close - 1) * 100, lowDistancePct: (lo / last.close - 1) * 100, candidateOnly: true } : null, p.periodLevels + 1, "prior rolling highs/lows; signed distance from same closed-candle price; NOT validated important S/R", p.periodLevels + 1),
  };
  result.atr.trace = { ...result.atr.trace, barsUsed: Math.max(0, cs.length - 1), windowEnd: cs.at(-2)?.end };
  if (latestEnd !== null) result.volume.trace = { ...result.volume.trace, barsUsed: 1, windowStart: latestEnd - interval };
  return result;
}

/** Preserve provenance when composing values. An unavailable/stale dependency wins. */
function derived<T>(deps: Quality<unknown>[], v: T, formula: string): Quality<T> {
  const unavailable = deps.find(d => d.status === "unavailable");
  if (unavailable) return { ...missing<T>(unavailable.source, unavailable.reason ?? "Missing dependency", unavailable.receivedTimestamp, unavailable.trace), trace: { ...unavailable.trace, formula } };
  const oldest = [...deps].sort((a, b) => a.sourceTimestamp! - b.sourceTimestamp!)[0]!;
  return { ...oldest, value: v, status: deps.some(d => d.status === "stale") ? "stale" : "available", trace: { ...oldest.trace,
    requiredBars: Math.max(...deps.map(d => d.trace.requiredBars ?? 0)), dependencies: deps.map(d => d.trace), formula } } as Quality<T>;
}

export function enrich(input: MarketInput, history: History, now: number, p: Parameters = PARAMETERS): Enrichment {
  if (Object.values(p).some(n => !Number.isFinite(n) || n <= 0) || p.emaFast >= p.emaSlow || p.macdFast >= p.macdSlow || p.recentLevels > p.periodLevels) throw Error("Invalid market data profile");
  for (const k of ["emaFast", "emaSlow", "rsi", "macdFast", "macdSlow", "macdSignal", "bollinger", "vwap", "atr", "volumeBaseline", "recentLevels", "periodLevels"] as const) if (!Number.isInteger(p[k])) throw Error("Indicator periods must be integers");
  if (history.market.toLowerCase() !== input.market.toLowerCase()) history = { ...history, error: "Market identity mismatch" };
  if (![history.fromTimestamp, history.throughTimestamp, history.receivedTimestamp].every(Number.isFinite) || history.fromTimestamp > history.throughTimestamp || history.throughTimestamp > now + 1000 || history.receivedTimestamp > now + 1000) history = { ...history, fromTimestamp: 0, throughTimestamp: 0, error: "Invalid/future history timestamps" };
  const asOf = Math.floor(Math.min(now, history.throughTimestamp) / INTERVALS["5m"]) * INTERVALS["5m"];
  const frames = Object.fromEntries(Object.keys(INTERVALS).map(tf => [tf, frame(history, tf as Timeframe, now, asOf, p)])) as Record<Timeframe, Frame>;
  const f = frames["5m"], cs = value(f.candles), c = cs?.at(-1), va = value(f.volumeAnomaly), vo = value(f.volatility), change = value(f.priceChangePct);
  const price = c ? derived([f.candles], c.close, "last closed 5m candle close") : missing<number>(history.source, "No closed 5m candle", history.receivedTimestamp);
  const technicals: TechnicalSignal[] = [];
  for (const tf of Object.keys(INTERVALS) as Timeframe[]) {
    const x = frames[tf], candle = value(x.candles)?.at(-1), before = value(x.candles)?.at(-2);
    const em = value(x.ema), rs = value(x.rsi), mc = value(x.macd), vw = value(x.vwap), bb = value(x.bollinger), at = value(x.atr);
    for (const direction of ["LONG", "SHORT"] as const) for (const mode of ["continuation", "reversal"] as const) {
      const long = direction === "LONG", reversal = mode === "reversal";
      const conditions: [TechnicalKind, Quality<unknown>[], boolean][] = [
        ["EMA", [x.candles, x.ema], !!candle && !!em && (reversal ? !!before && (long ? before.close <= em.previousFast && candle.close > em.fast : before.close >= em.previousFast && candle.close < em.fast) : long ? candle.close > em.fast && em.fast > em.slow : candle.close < em.fast && em.fast < em.slow)],
        ["RSI", [x.rsi], rs !== undefined && (reversal ? long ? rs <= 30 : rs >= 70 : long ? rs > 55 && rs < 70 : rs < 45 && rs > 30)],
        ["MACD", [x.candles, x.macd], !!mc && (reversal ? !!candle && !!before && (long ? candle.close < before.close && mc.histogram > mc.previousHistogram : candle.close > before.close && mc.histogram < mc.previousHistogram) : long ? mc.histogram > 0 && mc.line > 0 : mc.histogram < 0 && mc.line < 0)],
        ["VWAP", [x.candles, x.vwap, x.atr], !!candle && vw !== undefined && at !== undefined && at > 0 && (reversal ? long ? candle.close < vw - 2 * at : candle.close > vw + 2 * at : long ? candle.close > vw + 0.5 * at : candle.close < vw - 0.5 * at)],
        ["BOLLINGER", [x.candles, x.bollinger], !!candle && !!bb && (reversal ? long ? candle.close < bb.lower : candle.close > bb.upper : long ? candle.close > bb.middle && candle.close < bb.upper : candle.close < bb.middle && candle.close > bb.lower)],
      ];
      for (const [kind, deps, condition] of conditions) technicals.push({ timeframe: tf, kind, direction, mode, evidence: derived(deps, condition, `${kind}:${mode}:${direction}; profile market-data-v1`) });
    }
  }
  const actual = input.price;
  const liveQuote: Quality<{ mid: number; bid: number; ask: number; spreadBps: number }> = "value" in actual && "value" in input.topOfBook ? {
    ...actual, value: { mid: actual.value, ...input.topOfBook.value }, sourceTimestamp: null, receivedTimestamp: actual.observedAt,
    ageMs: now - actual.observedAt, timeBasis: "live_quote", trace: { formula: "separate local-emission snapshot; chain quote timestamp unknown" },
    status: actual.status === "stale" || now - actual.observedAt > actual.maxAgeMs ? "stale" : "available",
  } : { ...missing(history.source, "No live quote", now), timeBasis: "live_quote" };
  const output: MarketInput = {
    ...input, timestamp: now, price, priceBasis: "closed_candle_close",
    topOfBook: missing(history.source, "Live quote kept separate from closed-candle signal clock", now),
    priceAction: derived([f.priceChangePct, f.volatility], { changePct: change ?? 0, rangeExpansion: !!vo && vo.rangeToAtr >= p.rangeExpansionAtr, largeMove: !!vo && vo.moveToAtr >= p.largeMoveAtr }, "5m return with prior ATR relative range/large-move classification"),
    volume: derived([f.volumeAnomaly], { ratio: va?.ratio ?? 0, reaccelerating: !!va && va.ratio >= 2 && va.ratio >= va.previousRatio * 1.25, decelerating: !!va && va.ratio < 0.5 }, "volume / prior 20 closed candles; reacceleration >=2x and >=1.25x previous ratio"),
    // Candidates are logged for later validation; never promote them to important S/R.
    levels: missing(history.source, "Rolling high/low candidates require independent important-S/R validation", now),
    technicals: derived([f.candles], technicals, "closed-candle per-indicator/per-timeframe evidence; individual freshness required"),
  };
  return { input: output,
    policy: { ...DEFAULT_POLICY, priceAnomalyPct: Math.max(DEFAULT_POLICY.priceAnomalyPct, (vo?.atrPct ?? 0) * p.priceAnomalyAtr) },
    marketData: { version: "market-data-v1", market: input.market, timestamp: now, asOf: asOf || null, source: history.source,
      historyStatus: history.error ? "unavailable" : now - history.throughTimestamp > p.historyMaxLagMs ? "stale" : "available", historyReason: history.error,
      frames, liveQuote, parameters: { ...p } },
  };
}
