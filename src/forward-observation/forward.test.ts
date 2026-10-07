import { expect, test } from "bun:test";
import { readFile, mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ForwardArchive } from "./archive";
import { manifest, MARKET, PLAN, RULE_COMMIT, initialCostLedger, verifyFrozenRules, hash } from "./config";
import { ForwardController, entryTransition } from "./controller";
import { virtualSnapshot, gasContext } from "./execution";
import { bookMetrics, type BookObservation } from "../market-data/book-source";
import { missing } from "../market-data/adapter";
import type { History } from "../market-data/types";
import type { Evaluation } from "../signals/types";
import { MinuteSource } from "./minute-source";

const T = Date.UTC(2026, 8, 22), safe = { dryRun: true, model: "mock", noEnvFile: true };
const make = () => new ForwardController(manifest("synthetic-only", T, safe));
function book(now = T, bids: [number, number][] = [[99, 20]], asks: [number, number][] = [[101, 20]]): BookObservation {
  return { block: 1, blockHash: "0x" + "a".repeat(64), finality: "finalized", intervalMs: 5000,
    requestedTimestamp: now, completedTimestamp: now, acquisitionMs: 0,
    metrics: { attempts: 1, successes: 1, failures: 0, rpcCalls: 0, rpcFailures: 0, rpcTotalMs: 0, acquisitionTotalMs: 0, maxAcquisitionMs: 0, missingRate: 0, elapsedMs: 1, rpcPerSecond: 0 },
    data: { status: "available", source: `monad:143:kuru:${MARKET.contract.toLowerCase()}:finalized-book`, observedAt: now,
      sourceTimestamp: now, receivedTimestamp: now, ageMs: 0, maxAgeMs: 5000, timeBasis: "chain_snapshot", trace: {},
      value: { ...bookMetrics(bids, asks), vaultActive: false, thinness: missing("synthetic", "not needed", now) } } };
}
function history(now = T): History { return { market: MARKET.contract, source: "synthetic-only", fromTimestamp: now - 7200000,
  throughTimestamp: now, receivedTimestamp: now, error: null,
  trades: Array.from({ length: 120 }, (_, i) => ({ id: `${i}:0`, block: i + 1, timestamp: now - 7200000 + i * 60000 + 1000, price: 100, volume: 10 })) }; }
// Labelled synthetic lifecycle fixture: never accepted by a live/public ingestion API.
function evaluation(time = T, stage: "BREAKOUT" | "ACCELERATION" = "BREAKOUT", transition = true): Evaluation {
  return { decision: { id: `synthetic:${time}:${stage}`, timestamp: time, direction: "LONG", stage, metFactors: [], dataFreshness: {}, evidenceCount: 3 },
    state: { market: MARKET.contract, timestamp: time, direction: "LONG", stage, price: 100, levels: [], breakout: null },
    events: transition ? [{ type: "STAGE_CHANGED", toStage: stage }] : [] } as unknown as Evaluation;
}
function seed(c: ForwardController, time = T, stage: "BREAKOUT" | "ACCELERATION" = "BREAKOUT") {
  (c as unknown as { recordEvaluation(e: Evaluation, now: number, ids: string[], sr: unknown[]): unknown }).recordEvaluation(evaluation(time, stage), time, ["synthetic-source"], []);
}
test("frozen source fingerprints and version match committed S/R rules", () => { expect(verifyFrozenRules().codeCommit).toBe(RULE_COMMIT); });
test("manifest freezes seven days, four-hour tail, four variants, same market", () => {
  const m = manifest("fixture", T, safe);
  expect(m.observationEnd - T).toBe(604800000); expect(m.tailEnd - m.observationEnd).toBe(14400000);
  expect(m.config.variants).toHaveLength(4); expect(m.config.market).toEqual(MARKET); expect(m.liveApproval).toBe("NOT_GRANTED");
});
test("unsafe mode and absent no-env flag are refused", () => {
  for (const s of [{ ...safe, dryRun: false }, { ...safe, model: "other" }, { ...safe, noEnvFile: false }]) expect(() => manifest("fixture", T, s)).toThrow();
});
test("config digest mismatch refuses controller; later config mutation refuses steps", () => {
  const m = manifest("fixture", T, safe); m.configHash = "wrong"; expect(() => new ForwardController(m)).toThrow();
  const c = make(); (c.manifest.config as any).notional = 999; expect(() => c.observe(history(), T, ["raw"])).toThrow("CONFIG_CHANGED");
});
test("phase boundaries do not extend automatically", () => {
  const c = make(); expect(c.phase(c.manifest.observationEnd - 1)).toBe("OBSERVATION");
  expect(c.phase(c.manifest.observationEnd)).toBe("TAIL"); expect(c.phase(c.manifest.tailEnd)).toBe("ENDED");
});
test("changed absolute end times and recomputed alternative config are rejected", () => {
  const m = manifest("fixture", T, safe); (m.config as any).notional = 200; m.configHash = hash(JSON.stringify(m.config));
  expect(() => new ForwardController(m)).toThrow();
  const c = make(); c.manifest.tailEnd++; expect(() => c.observe(history(), T, ["raw"])).toThrow("DEADLINE_CHANGED");
});
test("invalid infinite history clock cannot enter aggregation", () => {
  expect(() => make().observe({ ...history(), throughTimestamp: Infinity }, T, ["raw"])).toThrow("HISTORY_CLOCK");
});
test("all generated decisions carry immutable source and policy linkage", () => {
  const c = make(), rows = c.observe(history(), T, ["raw-range"]), signal: any = rows.find(r => r.stream === "signal")!.value;
  expect(signal.decisionTimestamp).toBe(T); expect(signal.availableAt).toBe(T); expect(signal.codeCommit).toBe(RULE_COMMIT);
  expect(signal.inputRecordIds).toHaveLength(2); expect(signal.episodeId).toBeNull(); expect(signal.independentPositionSample).toBe(false);
});
test("unchanged tick is not a transition and new sampling respects one-minute cadence", () => {
  const c = make(); c.observe(history(), T, ["raw"]);
  expect(c.observe(history(), T + 1, ["raw"]).filter(r => r.stream === "signal")).toHaveLength(0);
  expect(entryTransition(evaluation(T, "BREAKOUT", false))).toBe(false);
});
test("tail records prices but creates no new decisions or entries", () => {
  const c = make(), now = c.manifest.observationEnd;
  const rows = c.observe(history(now), now, ["raw"]);
  expect(rows.some(r => r.stream === "price")).toBe(true); expect(rows.some(r => r.stream === "signal")).toBe(false);
  expect(c.state().entries).toHaveLength(0);
});
test("confirmed1m only, no future high/close, same source not saved twice", () => {
  const c = make(), h = history(); h.trades.push({ id: "future", block: 999, timestamp: T + 1000, price: 1e9, volume: 100 });
  const rows = c.observe(h, T, ["raw"]), prices: any[] = rows.filter(r => r.stream === "price").map(r => r.value);
  expect(prices.every(x => x.end <= T && x.candle.high === 100)).toBe(true);
  expect(c.observe(h, T + 1, ["raw"]).some(r => r.stream === "price")).toBe(false);
});
test("empty minute is explicit missing OHLC, not a fabricated zero price", () => {
  const c = make(), h = history(); h.trades = h.trades.filter(t => t.timestamp < T - 60000);
  const p: any = c.observe(h, T, ["raw"]).filter(r => r.stream === "price").at(-1)!.value;
  expect(p.candle).toBeNull(); expect(p.reason).toBe("PROVED_EMPTY_NO_OHLC");
});
test("compaction gap does not synthesize a1m candle from higher timeframes", () => {
  const c = make(); c.observe(history(), T, ["raw"]); const h = history(T + 120000); h.rawFromTimestamp = T + 120000; h.trades = [];
  const p: any[] = c.observe(h, T + 120000, ["raw"]).filter(r => r.stream === "price").map(r => r.value);
  expect(p).toHaveLength(2); expect(p.every(x => x.reason === "RAW_HISTORY_GAP_OR_COMPACTION")).toBe(true);
});
test("foreign market and clock reversal rejected", () => {
  const c = make(); c.observe(history(), T, ["raw"]);
  expect(() => c.observe(history(), T - 1, ["raw"])).toThrow(); expect(() => c.observe({ ...history(), market: "Bybit" }, T, ["raw"])).toThrow();
});
test("future received history is unavailable, not fresh evidence", () => {
  const c = make(), h = history(); h.receivedTimestamp++;
  const rows = c.observe(h, T, ["raw"]), s: any = rows.find(r => r.stream === "signal")!.value;
  expect(s.decision.stage).toBe("INSUFFICIENT_DATA"); expect(rows.some(r => r.stream === "price")).toBe(false);
});
test("visible book buy/sell arithmetic keeps spread inside VWAP", () => {
  const b = book(), x = virtualSnapshot(b, "BUY", 100, "USDC", T, T), y = virtualSnapshot(b, "SELL", 1, "MON", T, T);
  expect(x.virtualVwap).toBeCloseTo(101); expect(x.filledQuantity).toBeCloseTo(100 / 101); expect(y.quoteAmount).toBe(99);
  expect(x.priceImpactBps).toBeCloseTo(100); expect(x.profitabilityEligible).toBe(false);
});
test("multiple price levels produce weighted VWAP", () => {
  const x = virtualSnapshot(book(T, [[99, 20]], [[101, 1], [102, 1]]), "BUY", 203, "USDC", T, T);
  expect(x.virtualVwap).toBe(101.5); expect(x.filledQuantity).toBe(2);
});
test("partial visible depth never implies full fill", () => {
  const x = virtualSnapshot(book(T, [[99, 0.1]], [[101, 0.1]]), "BUY", 100, "USDC", T, T);
  expect(x.status).toBe("PARTIAL"); expect(x.unfilledAmount).toBeCloseTo(89.9); expect(x.coverage).toBe("TOP_5_LEVELS_ONLY");
});
test("pre-target snapshot cannot be backdated into an entry", () => {
  expect(virtualSnapshot(book(T - 1), "BUY", 100, "USDC", T, T).status).toBe("UNAVAILABLE");
});
test("stale or future received book does not provide executable benchmark", () => {
  expect(virtualSnapshot(book(), "BUY", 100, "USDC", T, T + 5001).status).toBe("UNAVAILABLE");
  const b = book(); b.data.receivedTimestamp = T + 1; expect(virtualSnapshot(b, "BUY", 100, "USDC", T, T).status).toBe("UNAVAILABLE");
});
test("wrong venue and active AMM never silently become executable inventory", () => {
  const b = book(); b.data.source = "Bybit"; expect(virtualSnapshot(b, "BUY", 100, "USDC", T, T).status).toBe("UNAVAILABLE");
  const a = book(); if ("value" in a.data) a.data.value.vaultActive = true;
  expect(virtualSnapshot(a, "BUY", 100, "USDC", T, T).reasons).toContain("ACTIVE_AMM_EXECUTABILITY_UNVERIFIED");
});
test("entry transition schedules exactly one entry even on repeated fixture", () => {
  const c = make(); seed(c); seed(c); expect(c.state().entries).toHaveLength(1); expect(c.state().jobs).toHaveLength(1);
});
test("entry snapshot schedules1h/4h from actual capture, not signal time", () => {
  const c = make(); seed(c); const at = T + 5000; c.book(book(at), at, "book-record");
  expect(c.state().jobs.filter(j => j.kind !== "ENTRY").map(j => j.targetTimestamp)).toEqual([at + 3600000, at + 14400000]);
});
test("exit records delayed actual capture and same inventory, separate100USDC benchmark", () => {
  const c = make(); seed(c); c.book(book(), T, "entry-book"); const at = T + 3600000 + 3000;
  const r: any = c.book(book(at, [[120, 20]], [[121, 20]]), at, "exit-book")[0]!.value;
  expect(r.benchmark.delayMs).toBe(3000); expect(r.inventoryExit.requestedAmount).toBeCloseTo(100 / 101);
  expect(r.benchmark.requestedAmount).toBe(100); expect(r.inventoryExit.quoteAmount).toBeCloseTo(120 * 100 / 101);
});
test("completed exit is not processed twice", () => {
  const c = make(); seed(c); c.book(book(), T, "b"); const at = T + 3600000;
  expect(c.book(book(at), at, "b1")).toHaveLength(1); expect(c.book(book(at), at, "b1")).toHaveLength(0);
});
test("end preserves missed exits and last market state, does not resolve episode", () => {
  const c = make(); seed(c, c.manifest.observationEnd - 1); const r: any = c.finish(c.manifest.tailEnd)[0]!.value;
  expect(r.openJobs).toHaveLength(1); expect(r.previousMarketStage).toBe("BREAKOUT"); expect(r.syntheticResolution).toBe(false);
  expect(c.finish(c.manifest.tailEnd + 1)).toHaveLength(0);
});
test("SHORT transition is saved but not a spot-long entry", () => {
  const e = evaluation(); e.decision.direction = "SHORT"; expect(entryTransition(e)).toBe(false);
});
test("unknown costs stay null and spot funding alone is not applicable", () => {
  const costs = initialCostLedger(); expect(costs.filter(c => c.name !== "fundingCost").every(c => c.value === null && c.evidenceClass === "UNKNOWN")).toBe(true);
  expect(costs.find(c => c.name === "fundingCost")!.evidenceClass).toBe("NOT_APPLICABLE");
});
test("block gas is context, never an observed transaction payment", () => {
  const g = gasContext({ number: "0x1", hash: "block", timestamp: "0x" + (T / 1000).toString(16), baseFeePerGas: "0x64", gasUsed: "0x10" }, T);
  expect(g.baseFeePerGasWei).toBe("100"); expect(g.actualPaidGasCost).toBeNull(); expect(g.gasCostClass).toBe("UNKNOWN");
});
test("missing base fee remains null; invalid gas source time rejected", () => {
  const h = { number: "0x1", hash: "block", timestamp: "0x" + (T / 1000).toString(16) };
  expect(gasContext(h, T).baseFeePerGasWei).toBeNull(); expect(() => gasContext(h, T - 1)).toThrow();
});
test("same offline inputs produce identical decision records", () => {
  expect(make().observe(history(), T, ["raw"])).toEqual(make().observe(history(), T, ["raw"]));
});
test("real file archive sync/readback checksum and dedup", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kuru-forward-offline-")), a = await ForwardArchive.create(parent, "fixture");
  const row = { synthetic: true, value: 123 }; await a.append("signal", "x", row);
  const before = a.status().bytes; expect((await a.append("signal", "x", row)).duplicate).toBe(true); expect(a.status().bytes).toBe(before);
  const r = JSON.parse((await readFile(join(a.directory, "signal.jsonl"), "utf8")).trim()); expect(hash(r.payload)).toBe(r.sha256);
  await expect(ForwardArchive.create(parent, "fixture")).rejects.toThrow();
});
test("capacity stop counts external raw cache and preserves prior data", async () => {
  const parent = await mkdtemp(join(tmpdir(), "kuru-forward-offline-")), a = await ForwardArchive.create(parent, "fixture", 1024);
  await a.append("health", "one", { synthetic: true }); const old = await readFile(join(a.directory, "health.jsonl"), "utf8");
  await expect(a.append("health", "two", {}, 1024)).rejects.toThrow("CAPACITY"); expect(a.status().stopped).toBe(true);
  expect(await readFile(join(a.directory, "health.jsonl"), "utf8")).toBe(old);
});
test("conflicting duplicate stops archive without overwriting", async () => {
  const a = await ForwardArchive.create(await mkdtemp(join(tmpdir(), "kuru-forward-offline-")), "fixture");
  await a.append("signal", "id", 1); await expect(a.append("signal", "id", 2)).rejects.toThrow("CONFLICT"); expect(a.status().stopped).toBe(true);
});
test("disk failure marks archive stopped; no deletion or retry", async () => {
  const a = await ForwardArchive.create(await mkdtemp(join(tmpdir(), "kuru-forward-offline-")), "fixture");
  await mkdir(join(a.directory, "health.jsonl")); await expect(a.append("health", "id", {})).rejects.toThrow(); expect(a.status().stopped).toBe(true);
});
test("raw incremental adapter retains minute across4h compaction, then acknowledges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuru-forward-offline-")), path = join(dir, "raw.jsonl");
  const c = { version: 1, market: MARKET.contract, sizeDecimals: 10, fromBlock: 1, throughBlock: 2,
    fromTimestamp: T - 60000, throughTimestamp: T, receivedTimestamp: T, endHash: "fixture",
    trades: [{ id: "1:0", block: 1, timestamp: T - 30000, price: 100, volume: 10 }] };
  await writeFile(path, JSON.stringify(c) + "\n"); const source = new MinuteSource(path), h = await source.read();
  const compact = { ...history(), rawFromTimestamp: T, trades: [] };
  const row: any = make().observe(compact, T, [h.sourceRecordId], h.history!).find(r => r.stream === "price")!.value;
  expect(row.candle.close).toBe(100); source.acknowledge(T); expect((await source.read()).bytesRead).toBe(0);
  const next = { ...c, fromBlock: 3, throughBlock: 4, fromTimestamp: T, throughTimestamp: T + 60000, receivedTimestamp: T + 60000,
    trades: [{ id: "3:0", block: 3, timestamp: T + 30000, price: 101, volume: 11 }] };
  await appendFile(path, JSON.stringify(next) + "\n"); const n = await source.read();
  expect(n.history!.trades).toHaveLength(1); expect(n.history!.rawFromTimestamp).toBe(T);
});
test("incomplete raw tail is not parsed as confirmed data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kuru-forward-offline-")), path = join(dir, "raw.jsonl");
  await writeFile(path, '{"version":'); const r = await new MinuteSource(path).read();
  expect(r.history).toBeNull(); expect(r.pendingBytes).toBeGreaterThan(0);
});
