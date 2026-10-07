import { describe, expect, test } from "bun:test";
import type { BlockEvent } from "../trader";
import { adaptObservation, captureObservation, unavailable } from "./adapter";
import { DEFAULT_POLICY, evaluate, freshness } from "./engine";
import { createSignalObserver, type SignalRecord } from "./observer";
import type { Datum, EngineState, MarketInput, Side, TechnicalSignal } from "./types";

// Synthetic fixtures ONLY. No fixtures are imported by the production adapter.
const T = 1_000_000;
function available<V>(value: V, observedAt = T): Datum<V> {
  return { status: "available", value, observedAt, maxAgeMs: 60_000, source: "test:synthetic-fixture" };
}
function base(time = T, price = 98): MarketInput {
  const a = <V>(v: V) => available(v, time);
  return {
    market: "fixture:MON-USDC", timestamp: time, block: time,
    price: a(price), topOfBook: a({ bid: price - 0.01, ask: price + 0.01, spreadBps: 2 }),
    priceAction: a({ changePct: 0, rangeExpansion: false, largeMove: false }),
    volume: a({ ratio: 1, reaccelerating: false, decelerating: false }),
    oi: a({ direction: "LONG", changePct: 0, high: false, outpacingPrice: false, disturbed: false }),
    funding: a({ direction: "LONG", divergent: false, notOverheated: false, extreme: false }),
    levels: a([]), liquidations: a({ direction: "LONG", largeCluster: false, cascade: false }),
    bookStructure: a({ imbalance: 0, thinToward: "NEUTRAL" }),
    onchain: a({ direction: "LONG", anomalous: false }),
    catalyst: a({ direction: "LONG", verified: false, reference: "https://example.test/fixture" }),
    technicals: a([]),
  };
}
function trend(time: number, price: number): MarketInput {
  const x = base(time, price);
  x.levels = available([{ id: "resistance-100", kind: "SR", price: 100, direction: "LONG" }], time);
  x.priceAction = available({ changePct: 1.2, rangeExpansion: false, largeMove: false }, time);
  x.volume = available({ ratio: 2, reaccelerating: false, decelerating: false }, time);
  x.oi = available({ direction: "LONG", changePct: 6, high: false, outpacingPrice: false, disturbed: false }, time);
  return x;
}
function technicals(direction: Side, mode: "continuation" | "reversal", time: number): TechnicalSignal[] {
  return ["5m", "15m"].flatMap(timeframe => ["RSI", "MACD"].map(kind => ({
    timeframe, kind, direction, mode, evidence: available(true, time),
  }))) as TechnicalSignal[];
}
function breakout() {
  const initial = evaluate(trend(T, 99));
  return evaluate(trend(T + 1000, 101), initial.state);
}
function acceleration(time = T + 2000): MarketInput {
  const x = trend(time, 104);
  x.volume = available({ ratio: 3, reaccelerating: true, decelerating: false }, time);
  x.liquidations = available({ direction: "LONG", largeCluster: true, cascade: true }, time);
  x.bookStructure = available({ imbalance: 0.8, thinToward: "LONG" }, time);
  x.priceAction = available({ changePct: 4, rangeExpansion: true, largeMove: false }, time);
  return x;
}
function overheat(time = T + 3000): MarketInput {
  const x = base(time, 105);
  x.priceAction = available({ changePct: 10, rangeExpansion: false, largeMove: true }, time);
  x.volume = available({ ratio: 0.8, reaccelerating: false, decelerating: true }, time);
  x.technicals = available(technicals("SHORT", "reversal", time), time);
  return x;
}
function event(ts = Date.now()): BlockEvent {
  return {
    block: 100, ts, mid: 100, bestBid: 99.99, bestAsk: 100.01, spreadBps: 2,
    decision: { action: "buy", probabilities: { buy: 0.9, sell: 0.1, hold: 0 }, upIn10: 0.9, latencyMs: 80, late: false },
    quote: { side: "buy", price: 100, size: 200, txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false },
    fill: null, resting: { bidMon: 200, askMon: 0 }, position: { side: "flat", size: 0, entryPrice: null, unrealizedUsd: 0, unrealizedMon: 0 },
    totals: { blocks: 1, decisions: 1, quotes: 1, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 },
  };
}

describe("4Stage deterministic engine", () => {
  test("WAIT → INITIAL → BREAKOUT → ACCELERATION → OVERHEAT, with event anchors", () => {
    const inputs = [base(), trend(T + 1000, 99), trend(T + 2000, 101), acceleration(T + 3000), overheat(T + 4000)];
    let state: EngineState | undefined;
    const results = inputs.map(input => { const r = evaluate(input, state); state = r.state; return r; });
    expect(results.map(r => r.decision.stage)).toEqual(["WAIT", "INITIAL", "BREAKOUT", "ACCELERATION", "OVERHEAT"]);
    expect(results.map(r => r.decision.direction)).toEqual(["NEUTRAL", "LONG", "LONG", "LONG", "SHORT"]);
    expect(results[2]!.events.some(e => e.type === "SR_BREAK")).toBe(true);
    expect(results[4]!.events.some(e => e.type === "DIRECTION_CHANGED")).toBe(true);
    expect(results[1]!.decision.preferredInitialCombinations).toContain("A_PRICE_VOLUME+B_OI");
    expect(results[3]!.decision.evidenceCount).toBe(5);
    expect(results[4]!.decision.validation.horizonsMinutes).toEqual([30, 60, 240, 1440]);
  });

  test("unavailable and price-only data never become a stage", () => {
    const x = adaptObservation(captureObservation(event(T)), "MON-USDC", T);
    expect(evaluate(x).decision.stage).toBe("INSUFFICIENT_DATA");
    expect(evaluate(x).decision.evidenceCount).toBe(0);
    x.priceAction = available({ changePct: 99, rangeExpansion: true, largeMove: true });
    expect(evaluate(x).decision.stage).toBe("INSUFFICIENT_DATA");
    x.volume = available({ ratio: 10, reaccelerating: true, decelerating: false });
    expect(evaluate(x).decision.evidenceCount).toBe(1);
    expect(evaluate(x).decision.stage).toBe("INSUFFICIENT_DATA");
  });

  test("E counts as one factor, even with both thin book and liquidation fuel", () => {
    const x = base();
    x.bookStructure = available({ imbalance: 0.8, thinToward: "LONG" });
    x.liquidations = available({ direction: "LONG", largeCluster: true, cascade: true });
    const r = evaluate(x);
    expect(r.decision.stage).toBe("WAIT");
    expect(r.decision.evidenceCount).toBe(1);
  });

  test("near important level plus directional liquidation fuel produces INITIAL", () => {
    const x = base();
    x.levels = available([{ id: "r", kind: "ATH", price: 100, direction: "LONG" }]);
    x.liquidations = available({ direction: "LONG", largeCluster: true, cascade: false });
    const d = evaluate(x).decision;
    expect(d.stage).toBe("INITIAL");
    expect(d.preferredInitialCombinations).toContain("D_NEAR_LEVEL+E_FUEL_OR_THIN_BOOK");
  });

  test("price/volume plus non-overheated funding is a preferred INITIAL combination", () => {
    const x = base();
    x.priceAction = available({ changePct: 2, rangeExpansion: false, largeMove: false });
    x.volume = available({ ratio: 3, reaccelerating: false, decelerating: false });
    x.funding = available({ direction: "LONG", divergent: false, notOverheated: true, extreme: false });
    expect(evaluate(x).decision.preferredInitialCombinations).toContain("A_PRICE_VOLUME+C_FUNDING");
  });

  test("breakout requires volume AND third independent supporting factor", () => {
    const before = evaluate(trend(T, 99)).state;
    const x = trend(T + 1000, 101);
    x.volume = unavailable("fixture", "No measured volume");
    expect(evaluate(x, before).decision.stage).not.toBe("BREAKOUT");
    const y = base(T + 1000, 110);
    y.levels = x.levels;
    y.volume = available({ ratio: 2, reaccelerating: false, decelerating: false }, y.timestamp);
    expect(evaluate(y, before).decision.stage).not.toBe("BREAKOUT");
    expect(evaluate(y, before).events.some(e => e.type === "SR_BREAK")).toBe(true);
  });

  test("first sample beyond a level or a moving level does not fabricate a crossing", () => {
    expect(evaluate(trend(T, 101)).decision.stage).not.toBe("BREAKOUT");
    const prev = evaluate(trend(T, 99)).state;
    const next = trend(T + 1000, 101);
    next.levels = available([{ id: "resistance-100", kind: "SR", price: 98, direction: "LONG" }], next.timestamp);
    expect(evaluate(next, prev).events.some(e => e.type === "SR_BREAK")).toBe(false);
  });

  test("acceleration requires a prior unexpired breakout and three of five factors", () => {
    const x = acceleration();
    expect(evaluate(x).decision.stage).not.toBe("ACCELERATION");
    expect(evaluate(x, breakout().state).decision.stage).toBe("ACCELERATION");
    x.liquidations = unavailable("fixture", "missing");
    x.bookStructure = unavailable("fixture", "missing");
    x.priceAction = unavailable("fixture", "missing");
    expect(evaluate(x, breakout().state).decision.stage).not.toBe("ACCELERATION");
    expect(evaluate(acceleration(T + DEFAULT_POLICY.contextMaxAgeMs + 2000), breakout().state).decision.stage).not.toBe("ACCELERATION");
  });

  test("support breaks work symmetrically for SHORT", () => {
    const make = (t: number, p: number) => {
      const x = base(t, p);
      x.levels = available([{ id: "support", kind: "SR", price: 100, direction: "SHORT" }], t);
      x.priceAction = available({ changePct: -2, rangeExpansion: false, largeMove: false }, t);
      x.volume = available({ ratio: 2, reaccelerating: false, decelerating: false }, t);
      x.oi = available({ direction: "SHORT", changePct: 6, high: false, outpacingPrice: false, disturbed: false }, t);
      return x;
    };
    const r = evaluate(make(T + 1000, 99), evaluate(make(T, 101)).state);
    expect(r.decision.stage).toBe("BREAKOUT");
    expect(r.decision.direction).toBe("SHORT");
  });

  test("S/R failure records once and invalidates acceleration context", () => {
    const x = acceleration(); x.price = available(99, x.timestamp);
    const failed = evaluate(x, breakout().state);
    expect(failed.events.filter(e => e.type === "SR_FAILURE")).toHaveLength(1);
    expect(failed.state.breakout).toBeNull();
    expect(failed.decision.stage).not.toBe("ACCELERATION");
    const next = evaluate({ ...x, timestamp: x.timestamp + 1000 }, failed.state);
    expect(next.events.filter(e => e.type === "SR_FAILURE")).toHaveLength(0);
  });

  test("OVERHEAT requires large prior move, 2x2 technical agreement and market structure", () => {
    expect(evaluate(overheat()).decision.stage).toBe("OVERHEAT");
    const x = overheat(); x.volume = unavailable("fixture", "missing");
    expect(evaluate(x).decision.stage).not.toBe("OVERHEAT");
    const y = overheat(); y.priceAction = available({ changePct: 1, rangeExpansion: false, largeMove: false }, y.timestamp);
    expect(evaluate(y).decision.stage).not.toBe("OVERHEAT");
    const z = overheat(); z.technicals = available(technicals("SHORT", "reversal", z.timestamp).filter(t => t.kind === "RSI"), z.timestamp);
    expect(evaluate(z).decision.stage).not.toBe("OVERHEAT");
  });

  test("duplicate indicators, one timeframe, and split pairs cannot satisfy 2x2", () => {
    for (const pattern of ["duplicates", "one-frame", "split"]) {
      const x = overheat();
      const ts = technicals("SHORT", "reversal", x.timestamp);
      if (pattern === "duplicates") x.technicals = available(Array(4).fill(ts[0]!), x.timestamp);
      if (pattern === "one-frame") x.technicals = available(ts.filter(t => t.timeframe === "5m"), x.timestamp);
      if (pattern === "split") x.technicals = available(ts.map((t, i) => i >= 2 ? { ...t, kind: i === 2 ? "EMA" : "VWAP" } : t), x.timestamp);
      expect(evaluate(x).decision.stage).not.toBe("OVERHEAT");
    }
  });

  test("stale and unavailable sub-indicators are not counted", () => {
    const x = overheat();
    const ts = technicals("SHORT", "reversal", x.timestamp);
    ts[0]!.evidence = { ...available(true, x.timestamp - 100_000) };
    x.technicals = available(ts, x.timestamp);
    const d = evaluate(x).decision;
    expect(d.stage).not.toBe("OVERHEAT");
    expect(d.staleData).toContain("technicals.0");
    ts[0]!.evidence = unavailable("fixture", "missing indicator");
    expect(evaluate(x).decision.unavailableData).toContain("technicals.0");
  });

  test("stale, future, nonfinite and explicitly stale values fail closed", () => {
    expect(freshness(available(10, T - 60_001), T).status).toBe("stale");
    expect(freshness(available(10, T + 1), T).status).toBe("unavailable");
    for (const price of [NaN, Infinity, 0, -1]) {
      const x = trend(T, 99); x.price = available(price);
      expect(evaluate(x).decision.stage).toBe("INSUFFICIENT_DATA");
    }
    const x = trend(T, 99); x.price = { status: "stale", value: 99, observedAt: T, maxAgeMs: 2000, source: "fixture" };
    expect(evaluate(x).decision.staleData).toContain("price");
    expect(evaluate(x).decision.price).toBeNull();
    expect(evaluate(x).decision.stage).toBe("INSUFFICIENT_DATA");
  });

  test("malformed or duplicate levels and invalid numeric evidence are unavailable", () => {
    const x = trend(T, 99);
    x.levels = available([null] as unknown as never[]);
    x.volume = available({ ratio: NaN, reaccelerating: true, decelerating: false });
    expect(evaluate(x).decision.unavailableData).toContain("levels");
    expect(evaluate(x).decision.unavailableData).toContain("volume");
    const level = { id: "duplicate", kind: "SR" as const, price: 100, direction: "LONG" as const };
    x.levels = available([level, { ...level }]);
    expect(evaluate(x).decision.unavailableData).toContain("levels");
  });

  test("unchanged stage produces no repeated transition events", () => {
    const first = evaluate(trend(T, 99));
    const second = evaluate(trend(T + 1000, 99.5), first.state);
    expect(second.decision.stage).toBe("INITIAL");
    expect(second.events).toHaveLength(0);
  });

  test("no cross-market state, duplicate replay, mutation or nondeterminism", () => {
    const prev = breakout().state;
    const x = acceleration();
    const saved = JSON.stringify({ x, prev });
    expect(evaluate(x, prev)).toEqual(evaluate(x, prev));
    expect(JSON.stringify({ x, prev })).toBe(saved);
    expect(evaluate({ ...x, market: "other" }, prev).decision.stage).not.toBe("ACCELERATION");
    const replay = evaluate({ ...x, timestamp: prev.timestamp }, prev);
    expect(replay.decision.stage).toBe("INSUFFICIENT_DATA");
    expect(replay.events).toHaveLength(0);
    expect(replay.state).toEqual(prev);
  });

  test("conflicting directions do not select an arbitrary INITIAL", () => {
    const x = base();
    x.levels = available([{ id: "r", kind: "SR", price: 100, direction: "LONG" }, { id: "s", kind: "SR", price: 97, direction: "SHORT" }]);
    x.bookStructure = available({ imbalance: 0, thinToward: "LONG" });
    x.liquidations = available({ direction: "SHORT", largeCluster: true, cascade: false });
    expect(evaluate(x).decision.stage).toBe("WAIT");
    expect(evaluate(x).decision.direction).toBe("NEUTRAL");
  });
});

describe("observation-only adapter and logger", () => {
  test("actual quotes are available; unavailable derivatives are not fabricated", () => {
    const e = event(T);
    const x = adaptObservation(captureObservation(e), "MON-USDC", T);
    expect(x.price.status).toBe("available");
    expect(x.topOfBook.status).toBe("available");
    for (const key of ["oi", "funding", "liquidations", "onchain", "technicals", "volume", "levels", "catalyst", "priceAction", "bookStructure"] as const) expect(x[key].status).toBe("unavailable");
    e.decision!.late = true;
    expect(evaluate(adaptObservation(captureObservation(e), "MON-USDC", T)).decision.staleData).toContain("price");
  });

  test("observer snapshots primitives and never mutates order decisions", async () => {
    const records: SignalRecord[] = [];
    const observer = createSignalObserver({ market: "MON-USDC", dryRun: true, model: "mock" }, async r => { records.push(r); });
    const e = event();
    const before = structuredClone(e);
    observer.observe(e);
    expect(e).toEqual(before);
    e.mid = 999; // later trader mutations cannot change the captured observation
    await observer.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.decision.price).toBe(100);
    expect(records[0]!.decision.stage).toBe("INSUFFICIENT_DATA");
    expect(e.decision).toEqual(before.decision);
    expect(e.quote).toEqual(before.quote);
  });

  test("live or Jev mode disables observer entirely", async () => {
    let calls = 0;
    for (const opts of [{ dryRun: false, model: "mock" }, { dryRun: true, model: "jev" }]) {
      const o = createSignalObserver({ market: "MON-USDC", ...opts }, async () => { calls++; });
      o.observe(event()); await o.flush();
    }
    expect(calls).toBe(0);
  });

  test("a slow or failing log sink cannot block or throw into trading", async () => {
    let calls = 0;
    const o = createSignalObserver({ market: "MON-USDC", dryRun: true, model: "mock" }, async () => { calls++; await Bun.sleep(5); throw new Error("fixture disk failure"); });
    const e = event();
    expect(() => o.observe(e)).not.toThrow();
    for (let i = 1; i < 10; i++) o.observe({ ...e, ts: e.ts + i * 1000 });
    await o.flush();
    o.observe({ ...e, ts: e.ts + 20_000 }); await o.flush();
    expect(calls).toBe(1);
  });
});
