import type { Datum, MarketInput, Timeframe } from "../signals/types";
import type { Policy } from "../signals/engine";

export const INTERVALS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 } as const;
export interface Trace {
  timeframe?: Timeframe;
  barsUsed?: number;
  requiredBars?: number;
  windowStart?: number;
  windowEnd?: number;
  formula?: string;
  dependencies?: Trace[];
  samplesUsed?: number;
}
export type Quality<T> = Datum<T> & {
  sourceTimestamp: number | null;
  receivedTimestamp: number;
  ageMs: number | null;
  timeBasis: "closed_candle" | "chain_trade" | "live_quote" | "chain_snapshot";
  trace: Trace;
};
export interface Print { id: string; block: number; timestamp: number; price: number; volume: number }
export interface History {
  rawFromTimestamp?: number;
  closed?: Partial<Record<Timeframe, ClosedInterval[]>>;
  market: string;
  source: string;
  fromTimestamp: number;
  throughTimestamp: number;
  receivedTimestamp: number;
  trades: Print[];
  error: string | null;
}
export interface ClosedInterval { start: number; end: number; candle: Candle | null }
export interface Candle {
  start: number; end: number;
  open: number; high: number; low: number; close: number;
  volume: number; quoteVolume: number; trades: number;
}
export interface Frame {
  timeframe: Timeframe;
  candles: Quality<Candle[]>;
  priceChangePct: Quality<number>;
  volume: Quality<number>;
  ema: Quality<{ fast: number; slow: number; previousFast: number }>;
  rsi: Quality<number>;
  macd: Quality<{ line: number; signal: number; histogram: number; previousHistogram: number }>;
  vwap: Quality<number>;
  bollinger: Quality<{ middle: number; upper: number; lower: number }>;
  atr: Quality<number>;
  volumeAnomaly: Quality<{ ratio: number; baseline: number; previousRatio: number }>;
  volatility: Quality<{ rangeToAtr: number; moveToAtr: number; atrPct: number }>;
  levels: Quality<{ recentHigh: number; recentLow: number; periodHigh: number; periodLow: number; highDistancePct: number; lowDistancePct: number; candidateOnly: true }>;
}
export interface MarketDataSnapshot {
  importantSR?: import("./important-sr").ImportantSRObservation;
  phaseB?: import("./phase-b").PhaseBObservation;
  version: "market-data-v1";
  market: string;
  timestamp: number;
  asOf: number | null;
  source: string;
  historyStatus: "available" | "unavailable" | "stale";
  historyReason: string | null;
  frames: Record<Timeframe, Frame>;
  liveQuote: Quality<{ mid: number; bid: number; ask: number; spreadBps: number }>;
  parameters: Parameters;
}
export interface Parameters {
  emaFast: number; emaSlow: number; rsi: number;
  macdFast: number; macdSlow: number; macdSignal: number;
  bollinger: number; bollingerSigma: number; vwap: number; atr: number;
  volumeBaseline: number; recentLevels: number; periodLevels: number;
  rangeExpansionAtr: number; largeMoveAtr: number; priceAnomalyAtr: number;
  historyMaxLagMs: number; candleGraceMs: number;
}
export interface Enrichment { input: MarketInput; marketData: MarketDataSnapshot; policy: Policy }
