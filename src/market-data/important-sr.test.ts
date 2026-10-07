import { expect, test } from "bun:test";
import { enrich } from "./adapter";
import { attachImportantSR, promoteImportantSR } from "./important-sr";
import { evaluate, DEFAULT_POLICY } from "../signals/engine";
import { unavailable } from "../signals/adapter";
import type { MarketInput, Datum, TechnicalSignal } from "../signals/types";
import type { Candle, History } from "./types";
import { replaySavedSR, type SavedSRChunk } from "./important-sr-replay";

const T = Date.UTC(2026, 8, 19), DT = 300_000, MARKET = "fixture:MON-USDC";
function bars(kind: "support" | "resistance" = "resistance"): Candle[] {
  return Array.from({ length: 40 }, (_, i) => ({ start: T + i * DT, end: T + (i + 1) * DT,
    open: 100, close: 100, low: kind === "support" && [20, 30].includes(i) ? 95 : 99,
    high: kind === "resistance" && [20, 30].includes(i) ? 105 : 101, volume: 10, quoteVolume: 1000, trades: 4 }));
}
function base(now: number): MarketInput {
  const m = unavailable<any>("synthetic-fixture", "Not supplied");
  return { market: MARKET, timestamp: now, block: null, price: m, topOfBook: m, priceAction: m,
    volume: m, oi: m, funding: m, levels: m, liquidations: m, bookStructure: m, onchain: m, catalyst: m, technicals: m };
}
function result(cs = bars(), now = cs.at(-1)!.end) {
  const h: History = { market: MARKET, source: "synthetic-fixture", fromTimestamp: T,
    throughTimestamp: now, receivedTimestamp: now, error: null,
    trades: cs.filter(c => c.end <= now).flatMap((c, i) => [c.open, c.high, c.low, c.close].map((price, j) => ({
      id: `${i}:${j}`, block: i, timestamp: c.start + 1000 + j * 1000, price, volume: 2.5 }))) };
  return enrich(base(now), h, now);
}
const a = <V>(value: V, now: number): Datum<V> => ({ status: "available", value, observedAt: now, maxAgeMs: 60_000, source: "synthetic-fixture" });
function input(now: number, price: number, volume = 2, supporting = true) {
  const r = attachImportantSR(result(bars(), now));
  r.input.price = a(price, now); r.input.priceAction = a({ changePct: 2, rangeExpansion: true, largeMove: false }, now);
  r.input.volume = a({ ratio: volume, reaccelerating: false, decelerating: false }, now);
  r.input.technicals = a(supporting ? ["5m", "15m"].flatMap(timeframe => ["EMA", "RSI"].map(kind => ({
    timeframe, kind, direction: "LONG", mode: "continuation", evidence: a(true, now)
  }))) as TechnicalSignal[] : [], now);
  return r.input;
}

test("important S/R cannot recognize a future pivot or future second touch", () => {
  for (const n of [21, 22, 23, 31, 32]) expect(promoteImportantSR(result(bars(), T + n * DT).marketData, T + n * DT).important).toHaveLength(0);
  const p = attachImportantSR(result(bars(), T + 33 * DT)).marketData.importantSR!;
  expect(p.important).toHaveLength(1); expect(p.important[0]!.recognitionTimestamp).toBe(T + 33 * DT);
  expect(p.important[0]!.candidateRecognizedAt).toBe(T + 23 * DT);
});
test("single validated pivot remains a candidate, not important", () => {
  const p = attachImportantSR(result(bars().slice(0, 28))).marketData.importantSR!;
  expect(p.important).toHaveLength(0); expect(p.excluded.some(x => x.reason === "UNVALIDATED_CANDIDATE")).toBe(true);
});
test("weak reactions do not become important", () => {
  const cs = bars().map(c => ({ ...c, high: c.high === 105 ? 101.01 : c.high }));
  expect(attachImportantSR(result(cs)).marketData.importantSR!.important).toHaveLength(0);
});
test("support/resistance direction and original cluster identity are retained", () => {
  for (const kind of ["support", "resistance"] as const) {
    const p = attachImportantSR(result(bars(kind))).marketData.importantSR!.important;
    expect(p).toHaveLength(1); expect(p[0]!.evidence.touches).toHaveLength(2);
    expect(p[0]!.level.direction).toBe(kind === "support" ? "SHORT" : "LONG");
    expect(p[0]!.candidateId).toBe(`${kind}:${T + 20 * DT}`);
  }
});
test("future candles cannot rewrite earlier important recognition", () => {
  const cs = bars(), now = T + 33 * DT, before = result(cs, now);
  cs[35]!.high = 100000;
  expect(attachImportantSR(result(cs, now))).toEqual(attachImportantSR(before));
});
test("late history never backdates important availability to pivot recognition", () => {
  const r = result(), p = attachImportantSR(r).marketData.importantSR!.important[0]!;
  expect(p.availableAt).toBe(r.input.timestamp); expect(p.dataAvailableAt).toBe(r.input.timestamp);
  expect(p.availableAt).toBeGreaterThan(p.recognitionTimestamp);
});
test("future receipts and unknown source timestamps cannot enter evidence", () => {
  for (const unknown of [false, true]) {
    const r = result(), q = r.marketData.frames["5m"].candles;
    if (unknown) q.sourceTimestamp = null; else q.receivedTimestamp = r.input.timestamp + 1;
    expect(attachImportantSR(r).marketData.importantSR!.important).toHaveLength(0);
  }
});
test("stale history is not revived by available candles", () => {
  const r = result(); r.marketData.historyStatus = "stale";
  expect(attachImportantSR(r).input.levels.status).toBe("unavailable");
});
test("stale candle frame does not contribute important S/R", () => {
  const r = result(); r.marketData.frames["5m"].candles.status = "stale";
  expect(attachImportantSR(r).marketData.importantSR!.important).toHaveLength(0);
});
test("candle gaps are rejected, not filled", () => {
  const r = result(), q = r.marketData.frames["5m"].candles;
  if ("value" in q) q.value.splice(25, 1);
  expect(attachImportantSR(r).marketData.importantSR!.important).toHaveLength(0);
});
test("unconfirmed candle clock cannot disguise a recognized level", () => {
  const r = result(), q = r.marketData.frames["5m"].candles;
  if ("value" in q) q.value.at(-1)!.end++;
  expect(attachImportantSR(r).marketData.importantSR!.important).toHaveLength(0);
});
test("market identity mismatch rejects S/R connection", () => {
  const r = result(); r.input.market = "other";
  expect(attachImportantSR(r).input.levels.status).toBe("unavailable");
});
test("important proximity enters D exactly once with unchanged policy", () => {
  const x = input(T + 40 * DT, 104), d = evaluate(x).decision;
  const factors = d.assessments.find(x => x.stage === "INITIAL" && x.direction === "LONG")!.factors;
  expect(factors.filter(x => x.id === "D_NEAR_LEVEL" && x.status === "met")).toHaveLength(1);
  expect(DEFAULT_POLICY.nearLevelPct).toBe(3);
});
test("candidate without two touches never satisfies D", () => {
  const r = attachImportantSR(result(bars().slice(0, 28))); r.input.price = a(104, r.input.timestamp);
  expect(evaluate(r.input).decision.assessments.every(x => x.factors.every(f => f.id !== "D_NEAR_LEVEL" || f.status !== "met"))).toBe(true);
});
test("multiple level records remain one D factor and do not inflate evidence", () => {
  const x = input(T + 40 * DT, 104), d = evaluate(x).decision;
  if ("value" in x.levels) x.levels.value.push({ ...x.levels.value[0]!, id: "another-timeframe-same-level" });
  expect(evaluate(x).decision.evidenceCount).toBe(d.evidenceCount);
});
test("no breakout before crossing, even when other requirements are met", () => {
  const x = input(T + 39 * DT, 104), y = input(T + 40 * DT, 104.5);
  expect(evaluate(y, evaluate(x).state).decision.stage).not.toBe("BREAKOUT");
});
test("newly recognized level cannot fabricate a past crossing", () => {
  const x = input(T + 32 * DT, 104), y = input(T + 33 * DT, 106);
  expect(evaluate(y, evaluate(x).state).decision.stage).not.toBe("BREAKOUT");
});
test("S/R break plus volume still needs third supporting factor", () => {
  const x = input(T + 39 * DT, 104, 2, false), y = input(T + 40 * DT, 106, 2, false);
  const d = evaluate(y, evaluate(x).state).decision;
  expect(d.stage).not.toBe("BREAKOUT");
  expect(d.assessments.find(x => x.stage === "BREAKOUT" && x.direction === "LONG")!.evidenceCount).toBe(2);
});
test("supporting factors without required volume cannot produce breakout", () => {
  const x = input(T + 39 * DT, 104), y = input(T + 40 * DT, 106, 1);
  expect(evaluate(y, evaluate(x).state).decision.stage).not.toBe("BREAKOUT");
});
test("existing break-volume-third-factor gate can qualify using synthetic technicals", () => {
  const x = input(T + 39 * DT, 104), y = input(T + 40 * DT, 106);
  const d = evaluate(y, evaluate(x).state);
  expect(d.decision.stage).toBe("BREAKOUT"); expect(d.decision.evidenceCount).toBe(3);
  expect(d.decision.metFactors.some(f => f.id === "D_NEAR_LEVEL")).toBe(false);
});
test("failed break clears context and is not kept as a successful breakout", () => {
  const x = input(T + 38 * DT, 104), y = input(T + 39 * DT, 106), z = input(T + 40 * DT, 104);
  const b = evaluate(y, evaluate(x).state), f = evaluate(z, b.state);
  expect(b.decision.stage).toBe("BREAKOUT"); expect(f.state.breakout).toBeNull();
  expect(f.events.some(e => e.type === "SR_FAILURE")).toBe(true); expect(f.decision.stage).not.toBe("BREAKOUT");
});
test("phase B buffered break/failure/retest remain separate diagnostic events", () => {
  const cs = bars(); cs[34] = { ...cs[34]!, high: 108, close: 108 }; cs[35] = { ...cs[35]!, high: 109, low: 105, open: 108, close: 108 };
  const p = attachImportantSR(result(cs)).marketData.importantSR!.important[0]!;
  expect(p.phaseBEvents.map(e => e.type)).toEqual(["BREAK", "RETEST", "FAILURE"]);
  expect(p.recognitionTimestamp).toBe(T + 33 * DT);
});
test("deterministic, immutable attachment changes no other evidence or policy", () => {
  const r = result(), copy = structuredClone(r), p = attachImportantSR(r);
  expect(r).toEqual(copy); expect(p).toEqual(attachImportantSR(r)); expect(p.policy).toEqual(r.policy);
  for (const k of Object.keys(r.input) as (keyof MarketInput)[]) if (k !== "levels") expect(p.input[k]).toEqual(r.input[k]);
  for (const k of ["oi", "funding", "liquidations", "bookStructure"] as const) expect(p.input[k].status).toBe("unavailable");
});

function chunks(): SavedSRChunk[] {
  return bars().map((c, i) => ({ version: 1, market: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394", sizeDecimals: 10,
    fromBlock: i * 4 + 1, throughBlock: i * 4 + 4, fromTimestamp: c.start, throughTimestamp: c.end,
    endHash: "0x" + "0".repeat(64), receivedTimestamp: T + 40 * DT + i,
    trades: [c.open, c.high, c.low, c.close].map((price, j) => ({ id: `${i * 4 + 1}:${j}`, block: i * 4 + 1,
      timestamp: c.start + 1000 + j * 1000, price, volume: 2.5 })) }));
}
test("saved replay uses receipt time, not late backfill event time", () => {
  const cs = chunks(), r = replaySavedSR(cs);
  expect(r.rows.every(x => x.decision.timestamp === cs[x.sourceChunkIndex]!.receivedTimestamp)).toBe(true);
  expect(r.rows[0]!.decision.stage).toBe("INSUFFICIENT_DATA");
  expect(r.summary.firstReplayAvailableAt).toBeGreaterThan(r.summary.firstRecognitionTimestamp!);
  expect(r.summary.publicRequests).toBe(0);
});
test("later received chunks never rewrite earlier replay decisions", () => {
  const cs = chunks(), prefix = replaySavedSR(cs.slice(0, 39)), full = replaySavedSR(cs);
  expect(full.rows.slice(0, 39)).toEqual(prefix.rows);
});
test("replay is deterministic and does not mutate source records", () => {
  const cs = chunks(), copy = structuredClone(cs), a = replaySavedSR(cs);
  expect(replaySavedSR(cs)).toEqual(a); expect(cs).toEqual(copy);
});
test("archived gaps, clock reversal and foreign market are rejected", () => {
  for (const fault of ["gap", "clock", "market"] as const) {
    const cs = chunks();
    if (fault === "gap") cs[2]!.fromBlock++;
    if (fault === "clock") cs[2]!.receivedTimestamp = cs[1]!.receivedTimestamp - 1;
    if (fault === "market") cs[2]!.market = "foreign";
    expect(() => replaySavedSR(cs)).toThrow("DISCONTINUOUS_SOURCE");
  }
});
test("replay rejects duplicated raw trades instead of inflating volume", () => {
  const cs = chunks(); cs[0]!.trades.push(cs[0]!.trades[0]!);
  expect(() => replaySavedSR(cs)).toThrow("DUPLICATE_TRADE");
});
test("unknown observation clock and future source cannot promote", () => {
  for (const fault of ["source", "clock"] as const) {
    const r = result(), q = r.marketData.frames["5m"].candles;
    if (fault === "source") q.sourceTimestamp = r.input.timestamp + 1;
    if (fault === "clock") r.marketData.timestamp++;
    expect(attachImportantSR(r).marketData.importantSR!.important).toHaveLength(0);
  }
});
