import type { ActiveStage, Datum, Direction, EngineState, Evaluation, Factor, Freshness, InputKey, Level, MarketInput, Side, SignalDecision, SignalEvent, Stage, StageAssessment, TechnicalKind } from "./types";

/** Explicit v1 defaults, not calibrated trading thresholds. */
export interface Policy {
  priceAnomalyPct: number;
  volumeAnomalyRatio: number;
  breakoutVolumeRatio: number;
  oiIncreasePct: number;
  nearLevelPct: number;
  bookImbalance: number;
  contextMaxAgeMs: number;
}
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  priceAnomalyPct: 1, volumeAnomalyRatio: 2, breakoutVolumeRatio: 1.5,
  oiIncreasePct: 5, nearLevelPct: 3, bookImbalance: 0.6, contextMaxAgeMs: 15 * 60_000,
});
const keys: InputKey[] = ["price", "topOfBook", "priceAction", "volume", "oi", "funding", "levels", "liquidations", "bookStructure", "onchain", "catalyst", "technicals"];
const sides: Side[] = ["LONG", "SHORT"];
const rank: Record<Stage, number> = { WAIT: 0, INSUFFICIENT_DATA: 0, INITIAL: 1, BREAKOUT: 2, ACCELERATION: 3, OVERHEAT: 4 };
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const positive = (n: unknown): n is number => finite(n) && n > 0;
const bool = (n: unknown) => typeof n === "boolean";
const side = (n: unknown): n is Side => n === "LONG" || n === "SHORT";
const opposite = (s: Side): Side => s === "LONG" ? "SHORT" : "LONG";

export function freshness<T>(d: Datum<T>, now: number, valid = true): Freshness {
  if (d.status === "unavailable") return { status: d.status, source: d.source, observedAt: null, ageMs: null, maxAgeMs: null, reason: d.reason };
  const age = now - d.observedAt;
  if (!valid || !finite(d.observedAt) || !positive(d.maxAgeMs) || !finite(age) || age < 0 || !d.source.trim()) {
    return { status: "unavailable", source: d.source, observedAt: d.observedAt, ageMs: finite(age) ? age : null, maxAgeMs: d.maxAgeMs, reason: "Invalid value, provenance or timestamp" };
  }
  const stale = d.status === "stale" || age > d.maxAgeMs;
  return { status: stale ? "stale" : "available", source: d.source, observedAt: d.observedAt, ageMs: age, maxAgeMs: d.maxAgeMs, reason: stale ? d.reason ?? "Freshness limit exceeded" : null };
}

function validInput(key: InputKey, value: any): boolean {
  if (key === "price") return positive(value);
  if (!value || typeof value !== "object") return false;
  switch (key) {
    case "topOfBook": return positive(value.bid) && positive(value.ask) && value.ask >= value.bid && finite(value.spreadBps) && value.spreadBps >= 0;
    case "priceAction": return finite(value.changePct) && bool(value.rangeExpansion) && bool(value.largeMove);
    case "volume": return finite(value.ratio) && value.ratio >= 0 && bool(value.reaccelerating) && bool(value.decelerating);
    case "oi": return side(value.direction) && finite(value.changePct) && bool(value.high) && bool(value.outpacingPrice) && bool(value.disturbed);
    case "funding": return side(value.direction) && bool(value.divergent) && bool(value.notOverheated) && bool(value.extreme);
    case "levels": return Array.isArray(value) && value.every((l: Level) => l && typeof l.id === "string" && l.id.length > 0 && positive(l.price) && side(l.direction) && ["SR", "RECENT_EXTREME", "ATH", "ATL"].includes(l.kind)) && new Set(value.map((l: Level) => l.id)).size === value.length;
    case "liquidations": return side(value.direction) && bool(value.largeCluster) && bool(value.cascade);
    case "bookStructure": return finite(value.imbalance) && Math.abs(value.imbalance) <= 1 && (side(value.thinToward) || value.thinToward === "NEUTRAL");
    case "onchain": return side(value.direction) && bool(value.anomalous);
    case "catalyst": return side(value.direction) && bool(value.verified) && typeof value.reference === "string" && /^https:\/\/\S+$/.test(value.reference);
    case "technicals": return Array.isArray(value) && value.every(t => t && ["5m", "15m", "1h", "4h"].includes(t.timeframe) && ["RSI", "MACD", "EMA", "VWAP", "BOLLINGER", "DIVERGENCE", "TREND_STRUCTURE"].includes(t.kind) && side(t.direction) && ["continuation", "reversal"].includes(t.mode) && t.evidence && ["available", "unavailable", "stale"].includes(t.evidence.status));
  }
}

/** Pure, deterministic reducer. No clock, I/O, model, wallet or order functions. */
export function evaluate(input: MarketInput, previous?: EngineState, policy: Policy = DEFAULT_POLICY): Evaluation {
  if (!input.market || !finite(input.timestamp)) throw new Error("Market and finite timestamp required");
  if (Object.values(policy).some(n => !positive(n)) || policy.nearLevelPct < 2 || policy.nearLevelPct > 5 || policy.bookImbalance > 1) throw new Error("Invalid signal policy");
  const dataFreshness: Record<string, Freshness> = {};
  for (const k of keys) {
    const d = input[k];
    dataFreshness[k] = freshness(d as Datum<unknown>, input.timestamp, d.status === "unavailable" || validInput(k, d.value));
  }
  function get<K extends InputKey>(key: K): Extract<MarketInput[K], { value: unknown }>["value"] | undefined {
    const d = input[key];
    return dataFreshness[key]!.status === "available" && "value" in d ? d.value as any : undefined;
  }
  const price = get("price") ?? null, pa = get("priceAction"), vol = get("volume"), oi = get("oi"), funding = get("funding");
  const levels = get("levels") ?? [], liq = get("liquidations"), book = get("bookStructure"), onchain = get("onchain"), catalyst = get("catalyst");
  const sameMarket = previous?.market === input.market;
  const ordered = !sameMarket || input.timestamp > previous!.timestamp;
  const prev = sameMarket && ordered && input.timestamp - previous!.timestamp <= policy.contextMaxAgeMs ? previous : undefined;
  const sign = (s: Side) => s === "LONG" ? 1 : -1;
  const beyond = (l: Level) => price !== null && (price - l.price) * sign(l.direction) > 0;
  const crossed = levels.filter(l => beyond(l) && prev?.price !== null && prev?.price !== undefined &&
    prev.levels.some(old => old.id === l.id && old.price === l.price && old.direction === l.direction) && (prev.price - l.price) * sign(l.direction) <= 0);
  let context = prev?.breakout && input.timestamp - prev.breakout.confirmedAt <= policy.contextMaxAgeMs ? prev.breakout : null;
  const failed = context && price !== null && !beyond(context.level) ? context : null;
  if (failed) context = null;
  // Require a still available, identical level; missing/stale levels cannot sustain a breakout.
  if (context && !levels.some(l => l.id === context!.level.id && l.price === context!.level.price && l.direction === context!.direction)) context = null;

  function factor(id: string, inputs: string[], condition: boolean, description: string): Factor {
    const states = inputs.map(k => dataFreshness[k]?.status ?? "unavailable");
    const status = states.includes("unavailable") ? "unavailable" : states.includes("stale") ? "stale" : condition ? "met" : "not_met";
    return { id, inputs, status, description };
  }
  function either(id: string, factors: Factor[], description: string): Factor {
    // One E factor, even if both liquidation and book evidence are present.
    const status = factors.some(f => f.status === "met") ? "met" : factors.some(f => f.status === "unavailable") ? "unavailable" : factors.some(f => f.status === "stale") ? "stale" : "not_met";
    return { id, inputs: factors.flatMap(f => f.inputs), status, description };
  }
  const tech = get("technicals");
  for (const [i, t] of (tech ?? []).entries()) dataFreshness[`technicals.${i}`] = freshness(t.evidence, input.timestamp, t.evidence.status === "unavailable" || bool(t.evidence.value));
  function technical(s: Side, mode: "continuation" | "reversal"): Factor {
    const matrix = new Map<TechnicalKind, Set<string>>();
    for (const [i, t] of (tech ?? []).entries()) {
      if (t.direction !== s || t.mode !== mode || dataFreshness[`technicals.${i}`]?.status !== "available" || !("value" in t.evidence) || !t.evidence.value) continue;
      const frames = matrix.get(t.kind) ?? new Set<string>(); frames.add(t.timeframe); matrix.set(t.kind, frames);
    }
    // The same two distinct kinds must agree on at least two distinct timeframes.
    const sets = [...matrix.values()];
    const met = sets.some((a, i) => sets.slice(i + 1).some(b => [...a].filter(tf => b.has(tf)).length >= 2));
    const base = factor(mode === "continuation" ? "H_TECHNICAL" : "TECH_REVERSAL", ["technicals"], met, "Two distinct technical families agree on two timeframes");
    if (base.status === "not_met") {
      const relevant = (tech ?? []).flatMap((t, i) => t.direction === s && t.mode === mode ? [dataFreshness[`technicals.${i}`]!.status] : []);
      if (relevant.includes("unavailable")) base.status = "unavailable";
      else if (relevant.includes("stale")) base.status = "stale";
    }
    return base;
  }
  function assess(stage: ActiveStage, direction: Side, factors: Factor[], minimumEvidence: number, required: string[] = []): StageAssessment {
    const evidenceCount = factors.filter(f => f.status === "met").length;
    return { stage, direction, factors, minimumEvidence, required, evidenceCount,
      qualified: price !== null && ordered && evidenceCount >= minimumEvidence && required.every(id => factors.some(f => f.id === id && f.status === "met")) };
  }
  const assessments: StageAssessment[] = [];
  for (const s of sides) {
    const moving = !!pa && pa.changePct * sign(s) > 0;
    const oiUp = factor("B_OI", ["oi"], !!oi && oi.direction === s && (oi.changePct >= policy.oiIncreasePct || oi.high || oi.outpacingPrice), "OI surge, high OI or growth outpacing price");
    const fundingSupport = factor("C_FUNDING", ["priceAction", "funding"], moving && !!funding && funding.direction === s && !funding.extreme && (funding.divergent || funding.notOverheated), "Directional price/funding divergence or non-overheated funding");
    const fuel = either("E_FUEL_OR_THIN_BOOK", [factor("LIQ_FUEL", ["liquidations"], !!liq && liq.direction === s && liq.largeCluster, "Liquidation fuel"), factor("THIN_BOOK", ["bookStructure"], book?.thinToward === s, "Thin book")], "Large liquidation cluster or thin book in the move direction");
    const common = [oiUp, fundingSupport, fuel,
      factor("F_ONCHAIN", ["onchain"], !!onchain && onchain.direction === s && onchain.anomalous, "Whale/onchain anomaly"),
      factor("G_CATALYST", ["catalyst"], !!catalyst && catalyst.direction === s && catalyst.verified, "Verified catalyst with source URL"), technical(s, "continuation")];
    assessments.push(assess("INITIAL", s, [
      factor("A_PRICE_VOLUME", ["priceAction", "volume"], moving && Math.abs(pa!.changePct) >= policy.priceAnomalyPct && !!vol && vol.ratio >= policy.volumeAnomalyRatio, "Price AND volume anomaly count as one independent factor"),
      ...common.slice(0, 2),
      factor("D_NEAR_LEVEL", ["price", "levels"], price !== null && levels.some(l => l.direction === s && Math.abs(l.price - price) / price * 100 <= policy.nearLevelPct), "Important level within configured 2–5% proximity"),
      ...common.slice(2),
    ], 2));
    const levelBroken = crossed.some(l => l.direction === s) || context?.direction === s;
    assessments.push(assess("BREAKOUT", s, [
      factor("LEVEL_BREAK", ["price", "levels"], levelBroken, "Observed crossing of an unchanged important level, or retained confirmed breakout"),
      factor("BREAK_VOLUME", ["volume"], !!vol && vol.ratio >= policy.breakoutVolumeRatio, "Breakout accompanied by increased volume"), ...common,
    ], 3, ["LEVEL_BREAK", "BREAK_VOLUME"]));
    const acceleration = [
      factor("OI_INCREASE", ["oi"], !!oi && oi.direction === s && oi.changePct >= policy.oiIncreasePct, "OI increasing"),
      factor("VOLUME_REACCELERATION", ["volume"], !!vol && vol.reaccelerating, "Volume reacceleration"),
      factor("LIQ_CASCADE", ["liquidations"], !!liq && liq.direction === s && liq.cascade, "Liquidation cascade"),
      factor("BOOK_IMBALANCE", ["bookStructure"], !!book && book.imbalance * sign(s) >= policy.bookImbalance, "Directional book imbalance"),
      factor("RANGE_EXPANSION", ["priceAction"], moving && !!pa && pa.rangeExpansion, "Directional short-term range expansion"),
    ];
    const acc = assess("ACCELERATION", s, acceleration, 3);
    // Context is a gate, not a sixth supporting factor. It must predate this evaluation.
    acc.qualified &&= context?.direction === s;
    acc.required = context?.direction === s ? [] : ["PRIOR_CONFIRMED_BREAKOUT"];
    assessments.push(acc);
    const structure = [
      factor("EXTREME_FUNDING", ["funding"], !!funding && funding.direction === opposite(s) && funding.extreme, "Funding extreme in the prior move direction"),
      factor("OI_DISTURBANCE", ["oi"], !!oi && oi.direction === opposite(s) && oi.disturbed, "OI disturbance after the move"),
      factor("OPPOSITE_LIQ_FUEL", ["liquidations"], !!liq && liq.direction === s && liq.largeCluster, "Liquidation fuel toward reversal"),
      factor("VOLUME_DECELERATION", ["volume"], !!vol && vol.decelerating, "Volume deceleration"),
    ];
    assessments.push(assess("OVERHEAT", s, [
      factor("LARGE_PRIOR_MOVE", ["priceAction"], !!pa && pa.largeMove && pa.changePct * sign(s) < 0, "Large move preceding this reversal direction"),
      technical(s, "reversal"), ...structure,
    ], 3, ["LARGE_PRIOR_MOVE", "TECH_REVERSAL"]));
  }
  const qualified = assessments.filter(a => a.qualified).sort((a, b) => rank[b.stage] - rank[a.stage]);
  const conflict = qualified.length > 1 && qualified[0]!.stage === qualified[1]!.stage && qualified[0]!.direction !== qualified[1]!.direction;
  const winner = conflict ? undefined : qualified[0];
  const initial = assessments.filter(a => a.stage === "INITIAL").sort((a, b) => b.evidenceCount - a.evidenceCount);
  const selected = winner ?? initial[0]!;
  const enoughData = initial.some(a => a.factors.filter(f => f.status === "met" || f.status === "not_met").length >= 2);
  const stage: Stage = winner?.stage ?? (price === null || !ordered || !enoughData ? "INSUFFICIENT_DATA" : "WAIT");
  const direction: Direction = winner?.direction ?? "NEUTRAL";
  if (winner?.stage === "BREAKOUT") {
    const level = crossed.find(l => l.direction === direction);
    if (level) context = { direction: winner.direction, level: { ...level }, confirmedAt: input.timestamp };
  }
  const next: Record<Stage, ActiveStage | "REASSESS"> = { WAIT: "INITIAL", INSUFFICIENT_DATA: "INITIAL", INITIAL: "BREAKOUT", BREAKOUT: "ACCELERATION", ACCELERATION: "OVERHEAT", OVERHEAT: "REASSESS" };
  const nextDirection = stage === "ACCELERATION" ? opposite(selected.direction) : selected.direction;
  const target = assessments.find(a => a.stage === next[stage] && a.direction === nextDirection);
  const metIds = new Set(initial.find(a => a.direction === selected.direction)!.factors.filter(f => f.status === "met").map(f => f.id));
  const decision: SignalDecision = {
    schemaVersion: 1, engineVersion: "4stage-v1", id: `${input.market}:${input.timestamp}:${input.block ?? "none"}`,
    market: input.market, block: input.block, timestamp: input.timestamp, price, stage, direction,
    reason: !ordered ? "Out-of-order or duplicate observation" : price === null ? "Fresh price unavailable" : conflict ? "Conflicting directional evidence" : winner ? "Stage requirements met" : enoughData ? "Independent evidence below stage requirements" : "Insufficient independent usable inputs",
    evidenceCount: selected.evidenceCount, metFactors: selected.factors.filter(f => f.status === "met"), unmetFactors: selected.factors.filter(f => f.status !== "met"),
    unavailableData: Object.keys(dataFreshness).filter(k => dataFreshness[k]!.status === "unavailable"), staleData: Object.keys(dataFreshness).filter(k => dataFreshness[k]!.status === "stale"), dataFreshness, assessments,
    nextStageRequirements: { target: next[stage], minimumEvidence: target?.minimumEvidence ?? 0, observedEvidence: target?.evidenceCount ?? 0,
      missingRequired: target?.required.filter(id => !target.factors.some(f => f.id === id && f.status === "met")) ?? [],
      supportingCandidates: target?.factors.filter(f => f.status !== "met").map(f => f.id) ?? [] },
    preferredInitialCombinations: [["A_PRICE_VOLUME", "B_OI"], ["D_NEAR_LEVEL", "E_FUEL_OR_THIN_BOOK"], ["A_PRICE_VOLUME", "C_FUNDING"]].filter(pair => pair.every(id => metIds.has(id))).map(pair => pair.join("+")),
    validation: { anchorTimestamp: input.priceBasis === "closed_candle_close" && input.price.observedAt !== null ? input.price.observedAt : input.timestamp, anchorPrice: price, horizonsMinutes: [30, 60, 240, 1440], priceBasis: input.priceBasis ?? "observed_mid", metrics: "MFE_MAE_NOT_COMPUTED" },
  };
  const state: EngineState = { market: input.market, timestamp: input.timestamp, stage, direction, price, levels: levels.map(l => ({ ...l })), breakout: context ? { ...context, level: { ...context.level } } : null };
  const events: SignalEvent[] = [];
  function event(type: SignalEvent["type"], level: Level | null = null) {
    events.push({ id: `${decision.id}:${type}:${level?.id ?? "stage"}`, type, market: input.market, timestamp: input.timestamp, price,
      fromStage: prev?.stage ?? "WAIT", toStage: stage, fromDirection: prev?.direction ?? "NEUTRAL", direction: level?.direction ?? direction,
      progression: rank[stage] > rank[prev?.stage ?? "WAIT"], level: level ? { ...level } : null });
  }
  if (ordered) {
    if (stage !== (prev?.stage ?? "WAIT")) event("STAGE_CHANGED");
    if (prev && prev.direction !== "NEUTRAL" && direction !== "NEUTRAL" && prev.direction !== direction) event("DIRECTION_CHANGED");
    for (const l of crossed) event("SR_BREAK", l);
    if (failed) event("SR_FAILURE", failed.level);
  }
  return { decision, state: !ordered && previous ? structuredClone(previous) : state, events };
}
