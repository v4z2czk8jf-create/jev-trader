import type { BlockEvent } from "../trader";
import type { Datum, MarketInput } from "./types";

/** No decisions, quantities, fills or simulated volume enter the signal engine. */
export interface Observation {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  cached: boolean;
}
export function captureObservation(e: BlockEvent): Observation {
  return { block: e.block, ts: e.ts, mid: e.mid, bestBid: e.bestBid, bestAsk: e.bestAsk, spreadBps: e.spreadBps, cached: e.decision?.late === true };
}
export function unavailable<T>(source: string, reason: string): Datum<T> {
  return { status: "unavailable", observedAt: null, source, reason };
}

/** Event timestamps are local reception/emission times, not exchange timestamps. */
export function adaptObservation(e: Observation, market: string, now: number): MarketInput {
  const actual = <T>(value: T): Datum<T> => ({
    status: e.cached ? "stale" : "available", value, observedAt: e.ts, maxAgeMs: 2_000,
    source: "kuru:block-event:local-emission-time",
    ...(e.cached ? { reason: "Late block reused a cached order book; original read time unknown" } : {}),
  });
  const missing = <T>(reason: string) => unavailable<T>("jev-trader:adapter-v1", reason);
  return {
    market, timestamp: now, block: e.block,
    price: actual(e.mid), topOfBook: actual({ bid: e.bestBid, ask: e.bestAsk, spreadBps: e.spreadBps }),
    priceAction: missing("No validated short-term comparison window or large-move baseline"),
    volume: missing("Trade prints exist internally, but no validated volume baseline/window is exposed here; simulated fills are not market volume"),
    oi: missing("No open-interest data provider"),
    funding: missing("No funding data provider; this feed is a spot market"),
    levels: missing("No verified important S/R, recent extremes or ATH/ATL dataset"),
    liquidations: missing("No liquidation map or cascade provider"),
    bookStructure: missing("Top-of-book quotes do not establish depth imbalance or a thin-book baseline"),
    onchain: missing("No whale/onchain anomaly provider"),
    catalyst: missing("No verified catalyst source"),
    technicals: missing("No validated 5m/15m/1h/4h candles or technical series"),
  };
}
