import { MARKET, type Kind, type Observation } from "./types";

export function numeric(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || value === "" || !Number.isFinite(Number(value))) throw Error("Invalid numeric field");
  return Number(value);
}
export function timestamp(value: unknown): number {
  const n = numeric(value);
  if (!Number.isSafeInteger(n) || n < 1e12) throw Error("Expected UTC milliseconds");
  return n;
}
export function quality(source: number | null, received: number, now: number, ttl: number) {
  const ageMs = source === null ? null : now - source;
  if (source === null) return { status: "unavailable" as const, ageMs, reason: "Source update timestamp unknown" };
  if (source > received || now < received) return { status: "unavailable" as const, ageMs, reason: "Future timestamp / clock skew" };
  return { status: ageMs! > ttl ? "stale" as const : "available" as const, ageMs, reason: ageMs! > ttl ? "Freshness limit exceeded" : null };
}
export function observation(kind: Kind, raw: unknown, value: Record<string,unknown>, source: string,
  sourceTimestamp: number | null, receivedTimestamp: number, responseTimestamp: number | null,
  ttl: number, timestampKind: Observation["timestampKind"]): Observation {
  return {schemaVersion:1,mode:"observation-only",market:MARKET,kind,raw,value,source,sourceTimestamp,
    receivedTimestamp,observedTimestamp:receivedTimestamp,responseTimestamp,timestampKind,
    ...quality(sourceTimestamp,receivedTimestamp,receivedTimestamp,ttl)};
}
/** Historical replay may only see data actually received by the replay instant. */
export function asOf(rows: Observation[], at: number) {
  return rows.filter(r => r.receivedTimestamp <= at && r.sourceTimestamp !== null && r.sourceTimestamp <= at);
}
export function historyGaps(rows: Observation[], intervalMs: number) {
  const times = [...new Set(rows.map(r=>r.sourceTimestamp).filter((t):t is number=>t!==null))].sort((a,b)=>a-b);
  return times.slice(1).flatMap((t,i)=>t-times[i]!>intervalMs ? [{from:times[i]!,to:t,missingIntervals:Math.ceil((t-times[i]!)/intervalMs)-1}]:[]);
}
