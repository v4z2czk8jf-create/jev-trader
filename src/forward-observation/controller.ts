import { enrich } from "../market-data/adapter";
import { attachImportantSR } from "../market-data/important-sr";
import { closedIntervals } from "../market-data/candles";
import type { History } from "../market-data/types";
import type { BookObservation } from "../market-data/book-source";
import { unavailable } from "../signals/adapter";
import { evaluate } from "../signals/engine";
import type { EngineState, MarketInput, Evaluation } from "../signals/types";
import { hash, MARKET, PLAN, manifest as makeManifest, verifyFrozenRules, type Manifest } from "./config";
import { virtualSnapshot, type VirtualSnapshot } from "./execution";

interface Entry { id: string; signalId: string; stage: "BREAKOUT" | "ACCELERATION"; signalTimestamp: number; entry: VirtualSnapshot | null; additionalSignalIds?: string[] }
interface Job { id: string; entryId: string; targetTimestamp: number; kind: "ENTRY" | "EXIT_1H" | "EXIT_4H"; done: boolean }
export interface SavedRecord { stream: "signal" | "input" | "sr" | "price" | "execution" | "health"; id: string; value: unknown }

/** Accept an unchanged engine result; exported to test natural transition handling with labelled fixtures. */
export function entryTransition(e: Evaluation): boolean {
  return e.decision.direction === "LONG" && ["BREAKOUT", "ACCELERATION"].includes(e.decision.stage) &&
    e.events.some(x => x.type === "STAGE_CHANGED" && x.toStage === e.decision.stage);
}

/** No timer or transport. Caller must durably save every returned record before the next step.
 * A save failure requires caller stop; this cannot drive any Trader or Execution component.
 */
export class ForwardController {
  private previous?: EngineState;
  private lastTimestamp = -Infinity;
  private lastDecision = -Infinity;
  private lastMinuteEnd: number | null = null;
  private stopped = false;
  private entries = new Map<string, Entry>();
  private jobs: Job[] = [];
  private seenInputs = new Set<string>();
  private srState: unknown = null;
  readonly manifest: Manifest;
  private readonly fixedStart: number;
  constructor(manifest: Manifest) {
    const expected = makeManifest(manifest.campaignId, manifest.startedAt, manifest, manifest.runtimeCodeCommit);
    if (hash(JSON.stringify(manifest.config)) !== expected.configHash || manifest.configHash !== expected.configHash ||
        manifest.codeCommit !== expected.codeCommit || manifest.observationEnd !== expected.observationEnd || manifest.tailEnd !== expected.tailEnd) throw Error("FROZEN_CONFIG_MISMATCH");
    if (manifest.ruleSourceCommit !== expected.ruleSourceCommit || manifest.ruleFilesHash !== expected.ruleFilesHash ||
        JSON.stringify(manifest.ruleFiles) !== JSON.stringify(expected.ruleFiles)) throw Error("RULE_PROVENANCE_MISMATCH");
    verifyFrozenRules();
    this.fixedStart = manifest.startedAt;
    this.manifest = structuredClone(manifest);
  }
  phase(now: number) { return this.stopped || now >= this.manifest.tailEnd ? "ENDED" : now >= this.manifest.observationEnd ? "TAIL" : "OBSERVATION"; }
  private clock(now: number) {
    if (hash(JSON.stringify(this.manifest.config)) !== this.manifest.configHash) throw Error("CONFIG_CHANGED");
    if (this.manifest.startedAt !== this.fixedStart || this.manifest.observationEnd !== this.fixedStart + PLAN.observationMs ||
      this.manifest.tailEnd !== this.fixedStart + PLAN.observationMs + PLAN.tailMs) throw Error("CAMPAIGN_DEADLINE_CHANGED");
    if (!Number.isSafeInteger(now) || now < this.manifest.startedAt || now < this.lastTimestamp) throw Error("CLOCK_REVERSED_OR_INVALID");
    this.lastTimestamp = now;
  }
  dueBook(now: number) { return this.phase(now) !== "ENDED" && this.jobs.some(j => !j.done && j.targetTimestamp <= now &&
    (j.kind !== "ENTRY" || this.phase(now) === "OBSERVATION")); }
  state() { return structuredClone({ entries: [...this.entries.values()], jobs: this.jobs, stopped: this.stopped }); }
  checkpoint() {
    return structuredClone({ version: 1 as const, campaignId: this.manifest.campaignId, configHash: this.manifest.configHash,
      startedAt: this.manifest.startedAt, observationEnd: this.manifest.observationEnd, tailEnd: this.manifest.tailEnd,
      previous: this.previous ?? null, lastTimestamp: Number.isFinite(this.lastTimestamp) ? this.lastTimestamp : null,
      lastDecision: Number.isFinite(this.lastDecision) ? this.lastDecision : null, lastMinuteEnd: this.lastMinuteEnd,
      ...this.state(), srState: this.srState, lastInputId: [...this.seenInputs].at(-1) ?? null });
  }
  static restore(m: Manifest, s: ReturnType<ForwardController["checkpoint"]>) {
    const c = new ForwardController(m);
    if (s.version !== 1 || s.campaignId !== m.campaignId || s.configHash !== m.configHash || s.startedAt !== m.startedAt ||
        s.observationEnd !== m.observationEnd || s.tailEnd !== m.tailEnd ||
        [s.lastTimestamp, s.lastDecision, s.lastMinuteEnd].some(x => x !== null && !Number.isSafeInteger(x)) ||
        new Set(s.jobs.map(j => j.id)).size !== s.jobs.length || new Set(s.entries.map(e => e.id)).size !== s.entries.length ||
        s.jobs.some(j => !s.entries.some(e => e.id === j.entryId) || !Number.isSafeInteger(j.targetTimestamp))) throw Error("INVALID_CONTROLLER_CHECKPOINT");
    c.previous = structuredClone(s.previous ?? undefined); c.lastTimestamp = s.lastTimestamp ?? -Infinity;
    c.lastDecision = s.lastDecision ?? -Infinity; c.lastMinuteEnd = s.lastMinuteEnd; c.stopped = s.stopped;
    c.entries = new Map(structuredClone(s.entries).map(e => [e.id, e])); c.jobs = structuredClone(s.jobs);
    c.srState = structuredClone(s.srState); if (s.lastInputId) c.seenInputs.add(s.lastInputId);
    return c;
  }
  observe(history: History, now: number, inputRecordIds: string[], minuteHistory: History = history): SavedRecord[] {
    this.clock(now);
    if (this.phase(now) === "ENDED") return this.finish(now);
    if (history.market.toLowerCase() !== MARKET.contract.toLowerCase() || !inputRecordIds.length) throw Error("MARKET_OR_SOURCE_ID_MISSING");
    if (![history.fromTimestamp, history.throughTimestamp, history.receivedTimestamp].every(Number.isSafeInteger) ||
      history.fromTimestamp > history.throughTimestamp || history.throughTimestamp > history.receivedTimestamp) throw Error("INVALID_HISTORY_CLOCK");
    if (minuteHistory.market.toLowerCase() !== MARKET.contract.toLowerCase() ||
      ![minuteHistory.fromTimestamp, minuteHistory.throughTimestamp, minuteHistory.receivedTimestamp].every(Number.isSafeInteger) ||
      minuteHistory.fromTimestamp > minuteHistory.throughTimestamp || minuteHistory.throughTimestamp > minuteHistory.receivedTimestamp) throw Error("INVALID_MINUTE_HISTORY");
    const records: SavedRecord[] = [];
    // At a4h compaction boundary, missing1m source is recorded, never synthesized from5m.
    const minuteEnd = Math.floor(Math.min(now, minuteHistory.throughTimestamp) / 60000) * 60000;
    const rawStart = minuteHistory.rawFromTimestamp ?? minuteHistory.fromTimestamp;
    const start = this.lastMinuteEnd ?? Math.ceil(rawStart / 60000) * 60000;
    if (minuteHistory.receivedTimestamp <= now && !minuteHistory.error && (this.lastMinuteEnd === null || minuteEnd >= this.lastMinuteEnd)) {
      const intervals = closedIntervals(minuteHistory, 60000, now), byStart = new Map(intervals.map(c => [c.start, c]));
      for (let t = start; t < minuteEnd; t += 60000) {
        const c = byStart.get(t), id = `1m:${t}`;
        records.push({ stream: "price", id, value: { id, market: MARKET, start: t, end: t + 60000,
          confirmed: true, candle: c?.candle ?? null, status: c?.candle ? "available" : "unavailable",
          reason: c ? c.candle ? null : "PROVED_EMPTY_NO_OHLC" : "RAW_HISTORY_GAP_OR_COMPACTION",
          sourceTimestamp: t + 60000, receivedTimestamp: minuteHistory.receivedTimestamp, availableAt: now,
          ageMs: now - (t + 60000), purpose: t + 60000 === minuteEnd ? "CURRENT" : "HISTORICAL", inputRecordIds } });
      }
      this.lastMinuteEnd = minuteEnd;
    }
    if (this.phase(now) === "TAIL" || now - this.lastDecision < PLAN.decisionIntervalMs) return records;
    const m = unavailable<never>("forward:kuru:missing", "Not supplied; no inference");
    const input: MarketInput = { market: MARKET.contract, timestamp: now, block: null,
      price: m, topOfBook: m, priceAction: m, volume: m, levels: m, oi: m, funding: m,
      liquidations: m, bookStructure: m, onchain: m, catalyst: m, technicals: m };
    // Reject even sub-second future receipt; do not change the existing adapter tolerance.
    const safe = history.receivedTimestamp > now || history.throughTimestamp > now ? { ...history, error: "FUTURE_HISTORY" } : history;
    const r = attachImportantSR(enrich(input, safe, now));
    const e = evaluate(r.input, this.previous, r.policy);
    const inputId = hash(JSON.stringify({ input: r.input, policy: r.policy, inputRecordIds }));
    if (!this.seenInputs.has(inputId)) {
      records.push({ stream: "input", id: inputId, value: { input: r.input, policy: r.policy, inputRecordIds } });
      this.seenInputs.clear(); this.seenInputs.add(inputId);
    }
    const sr = r.marketData.importantSR!, srId = hash(JSON.stringify(sr));
    this.srState = sr;
    records.push({ stream: "sr", id: srId, value: sr });
    records.push(...this.recordEvaluation(e, now, [inputId, srId], sr.important.map(s => ({ id: s.id,
      recognitionTimestamp: s.recognitionTimestamp, availableAt: s.availableAt, distancePct: e.decision.price === null ? null : (s.level.price / e.decision.price - 1) * 100,
      phaseBEvents: s.phaseBEvents }))));
    this.lastDecision = now;
    return records;
  }
  private recordEvaluation(e: Evaluation, now: number, inputRecordIds: string[], sr: unknown[]): SavedRecord[] {
    const d = e.decision, transition = e.events.filter(x => x.type === "STAGE_CHANGED");
    const record: SavedRecord = { stream: "signal", id: d.id, value: { ...e, decisionTimestamp: now, availableAt: now, market: MARKET,
      previousStage: this.previous?.stage ?? null, transition, evidenceGroups: d.metFactors.map(x => x.id),
      groupSemantics: "EXISTING_4STAGE_FACTORS_NOT_SCANNER_CHEAP_GROUPS", quality: d.dataFreshness, inputRecordIds,
      importantSr: sr, policyVersion: this.manifest.config.srPromotion, codeCommit: this.manifest.codeCommit, configHash: this.manifest.configHash,
      ruleSourceCommit: this.manifest.ruleSourceCommit, runtimeCodeCommit: this.manifest.runtimeCodeCommit,
      episodeId: null, continuity: "SESSION_ONLY", independentPositionSample: false } };
    this.previous = e.state;
    if (entryTransition(e) && now < this.manifest.observationEnd && !this.entries.has(d.id)) {
      const active = [...this.entries.values()].find(x => this.jobs.some(j => j.entryId === x.id && !j.done));
      if (active) {
        active.additionalSignalIds ??= [];
        if (!active.additionalSignalIds.includes(d.id)) active.additionalSignalIds.push(d.id);
        (record.value as Record<string, unknown>).positionReference = active.id;
      } else {
        this.entries.set(d.id, { id: d.id, signalId: d.id, stage: d.stage as Entry["stage"], signalTimestamp: now, entry: null });
        this.jobs.push({ id: `${d.id}:entry`, entryId: d.id, targetTimestamp: now, kind: "ENTRY", done: false });
      }
    }
    return [record];
  }
  book(book: BookObservation, now: number, sourceRecordId: string): SavedRecord[] {
    if (!sourceRecordId) throw Error("BOOK_SOURCE_ID_REQUIRED");
    this.clock(now); if (this.phase(now) === "ENDED") return this.finish(now);
    const records: SavedRecord[] = [];
    for (const job of [...this.jobs]) {
      if (job.done || job.targetTimestamp > now) continue;
      // A pending pre-tail Entry must not become a new virtual position in the tail.
      if (job.kind === "ENTRY" && this.phase(now) !== "OBSERVATION") continue;
      const e = this.entries.get(job.entryId)!;
      const benchmark = virtualSnapshot(book, job.kind === "ENTRY" ? "BUY" : "SELL", PLAN.notional, "USDC", job.targetTimestamp, now);
      records.push({ stream: "execution", id: `${job.id}:${now}`, value: { job: { ...job }, signalId: e.signalId, sourceRecordId,
        fixedNotional: PLAN.notional, benchmark,
        inventoryExit: job.kind !== "ENTRY" && e.entry?.filledQuantity && e.entry.filledQuantity > 0 ?
          virtualSnapshot(book, "SELL", e.entry.filledQuantity!, "MON", job.targetTimestamp, now) : null,
        variantId: job.kind === "ENTRY" ? null : `${e.stage}_${job.kind === "EXIT_1H" ? "1H" : "4H"}` } });
      if (benchmark.status === "UNAVAILABLE") continue;
      job.done = true;
      if (job.kind === "ENTRY") {
        e.entry = benchmark;
        if (benchmark.filledQuantity && benchmark.filledQuantity > 0) for (const hours of PLAN.exitHours) this.jobs.push({ id: `${e.id}:exit-${hours}h`, entryId: e.id,
          targetTimestamp: now + hours * 3600000, kind: hours === 1 ? "EXIT_1H" : "EXIT_4H", done: false });
      }
    }
    return records;
  }
  finish(now: number, reason = "FIXED_CAMPAIGN_END"): SavedRecord[] {
    this.clock(now); if (this.stopped) return [];
    this.stopped = true;
    return [{ stream: "health", id: "stop", value: { reason, at: now, phase: "ENDED", openJobs: this.jobs.filter(j => !j.done),
      missingExitsRemainIncomplete: true, previousMarketStage: this.previous?.stage ?? null, syntheticResolution: false } }];
  }
}
