import { freshness } from "../signals/engine";
import type { Datum, Level, Timeframe } from "../signals/types";
import { observeSR } from "./phase-b";
import { replaySR, type SRReplay } from "./sr-replay";
import type { SRCandidate } from "./sr-candidates";
import { INTERVALS, type Enrichment, type MarketDataSnapshot } from "./types";

export const SR_PROMOTION_VERSION = "phase-b-validated-sr-v1" as const;
export interface ImportantSR {
  id: string;
  candidateId: string;
  classification: "IMPORTANT_SUPPORT" | "IMPORTANT_RESISTANCE";
  timeframe: Timeframe;
  level: Level;
  candidateRecognizedAt: number;
  recognitionTimestamp: number;
  dataAvailableAt: number;
  availableAt: number;
  sourceTimestamp: number;
  receivedTimestamp: number;
  evidence: SRCandidate;
  phaseBEvents: SRReplay["events"];
}
export interface ImportantSRObservation {
  version: typeof SR_PROMOTION_VERSION;
  market: string;
  evaluatedAt: number;
  asOf: number | null;
  important: ImportantSR[];
  excluded: { timeframe: Timeframe; candidateId: string | null; reason: string }[];
  levels: Datum<Level[]>;
}

/** Reuse Phase B's validatedAt, not a new S/R detector or fitted threshold.
 * This additional record leaves Phase B candidateOnly and historical outcomes intact.
 */
export function promoteImportantSR(snapshot: MarketDataSnapshot, now: number): ImportantSRObservation {
  const out: ImportantSRObservation = { version: SR_PROMOTION_VERSION, market: snapshot.market,
    evaluatedAt: now, asOf: snapshot.asOf, important: [], excluded: [],
    levels: { status: "unavailable", observedAt: null, source: SR_PROMOTION_VERSION, reason: "No usable S/R validation frame" } };
  const fail = (tf: Timeframe, reason: string, candidateId: string | null = null) => out.excluded.push({ timeframe: tf, candidateId, reason });
  let observedAt = Infinity, expiresAt = Infinity, usableFrames = 0;
  for (const tf of Object.keys(INTERVALS) as Timeframe[]) {
    const q = snapshot.frames[tf].candles;
    if (!Number.isFinite(now) || snapshot.timestamp !== now || snapshot.asOf === null || snapshot.asOf > now ||
        !Number.isFinite(q.receivedTimestamp) || q.receivedTimestamp > now || q.sourceTimestamp === null ||
        !Number.isFinite(q.sourceTimestamp) || q.sourceTimestamp > snapshot.asOf ||
        q.receivedTimestamp < q.sourceTimestamp || q.observedAt !== q.sourceTimestamp) {
      fail(tf, "UNKNOWN_OR_FUTURE_TIMESTAMP"); continue;
    }
    const f = freshness(q, now);
    if (snapshot.historyStatus !== "available" || f.status !== "available" || !("value" in q)) {
      fail(tf, snapshot.historyStatus !== "available" ? `HISTORY_${snapshot.historyStatus.toUpperCase()}` : f.status.toUpperCase()); continue;
    }
    const cs = q.value.filter(c => c.end <= snapshot.asOf!);
    if (!cs.length || cs.at(-1)!.end !== q.sourceTimestamp || cs.some(c => c.end - c.start !== INTERVALS[tf] || c.start % INTERVALS[tf] !== 0)) {
      fail(tf, "INVALID_CANDLE_CLOCK"); continue;
    }
    // observeSR uses the original pivot, ATR, separated-touch and clustering rules.
    const safe = { ...snapshot, frames: { ...snapshot.frames, [tf]: { ...snapshot.frames[tf], candles: { ...q, value: cs } } } };
    const candidates = observeSR(safe)[tf]!;
    if (candidates.status !== "available" || !("value" in candidates)) { fail(tf, "INSUFFICIENT_OR_INVALID_SR_HISTORY"); continue; }
    usableFrames++;
    observedAt = Math.min(observedAt, q.observedAt);
    expiresAt = Math.min(expiresAt, q.observedAt + q.maxAgeMs);
    for (const c of candidates.value) {
      if (c.validatedAt === null) { fail(tf, "UNVALIDATED_CANDIDATE", c.id); continue; }
      if (c.validatedAt > snapshot.asOf || c.validatedAt > now || c.touches.some(t => t.confirmedAt > snapshot.asOf!)) {
        fail(tf, "NOT_YET_RECOGNIZED", c.id); continue;
      }
      const id = `${snapshot.market.toLowerCase()}:${tf}:${c.id}`;
      const level: Level = { id, kind: "SR", price: c.price, direction: c.kind === "resistance" ? "LONG" : "SHORT" };
      out.important.push({ id, candidateId: c.id, classification: c.kind === "support" ? "IMPORTANT_SUPPORT" : "IMPORTANT_RESISTANCE",
        timeframe: tf, level, candidateRecognizedAt: c.recognizedAt, recognitionTimestamp: c.validatedAt,
        dataAvailableAt: Math.max(c.validatedAt, q.receivedTimestamp), availableAt: now,
        sourceTimestamp: q.sourceTimestamp, receivedTimestamp: q.receivedTimestamp, evidence: structuredClone(c),
        phaseBEvents: replaySR(c, cs, snapshot.asOf).events });
    }
  }
  if (usableFrames) out.levels = { status: "available", value: out.important.map(x => x.level),
    source: `${snapshot.source}:${SR_PROMOTION_VERSION}`, observedAt, maxAgeMs: expiresAt - observedAt };
  return out;
}

/** Observation layer only. Every other engine input and its policy stay unchanged. */
export function attachImportantSR(result: Enrichment): Enrichment {
  const importantSR = promoteImportantSR(result.marketData, result.input.timestamp);
  if (result.input.market.toLowerCase() !== result.marketData.market.toLowerCase()) {
    return { ...result, input: { ...result.input, levels: { status: "unavailable", observedAt: null,
      source: SR_PROMOTION_VERSION, reason: "Market identity mismatch" } } };
  }
  return { ...result, input: { ...result.input, levels: importantSR.levels }, marketData: { ...result.marketData, importantSR } };
}
