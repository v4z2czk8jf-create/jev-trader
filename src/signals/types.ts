/** Observation contracts only. These types have no order/model dependencies. */
export type Direction = "LONG" | "SHORT" | "NEUTRAL";
export type Side = Exclude<Direction, "NEUTRAL">;
export type Stage = "WAIT" | "INSUFFICIENT_DATA" | "INITIAL" | "BREAKOUT" | "ACCELERATION" | "OVERHEAT";
export type ActiveStage = Exclude<Stage, "WAIT" | "INSUFFICIENT_DATA">;
export type Availability = "available" | "unavailable" | "stale";

export type Datum<T> =
  | { status: "available" | "stale"; value: T; observedAt: number; maxAgeMs: number; source: string; reason?: string }
  | { status: "unavailable"; observedAt: null; source: string; reason: string };

export type Timeframe = "5m" | "15m" | "1h" | "4h";
export type TechnicalKind = "RSI" | "MACD" | "EMA" | "VWAP" | "BOLLINGER" | "DIVERGENCE" | "TREND_STRUCTURE";
export interface TechnicalSignal {
  timeframe: Timeframe;
  kind: TechnicalKind;
  direction: Side;
  mode: "continuation" | "reversal";
  evidence: Datum<boolean>;
}
export interface Level {
  id: string;
  kind: "SR" | "RECENT_EXTREME" | "ATH" | "ATL";
  price: number;
  direction: Side; // LONG: resistance to break upward; SHORT: support to break downward
}
export interface MarketInput {
  priceBasis?: "observed_mid" | "closed_candle_close";
  market: string;
  timestamp: number; // evaluation time, milliseconds UTC
  block: number | null;
  price: Datum<number>;
  topOfBook: Datum<{ bid: number; ask: number; spreadBps: number }>;
  priceAction: Datum<{ changePct: number; rangeExpansion: boolean; largeMove: boolean }>;
  volume: Datum<{ ratio: number; reaccelerating: boolean; decelerating: boolean }>;
  oi: Datum<{ direction: Side; changePct: number; high: boolean; outpacingPrice: boolean; disturbed: boolean }>;
  funding: Datum<{ direction: Side; divergent: boolean; notOverheated: boolean; extreme: boolean }>;
  levels: Datum<Level[]>;
  liquidations: Datum<{ direction: Side; largeCluster: boolean; cascade: boolean }>;
  bookStructure: Datum<{ imbalance: number; thinToward: Direction }>;
  onchain: Datum<{ direction: Side; anomalous: boolean }>;
  catalyst: Datum<{ direction: Side; verified: boolean; reference: string }>;
  technicals: Datum<TechnicalSignal[]>;
}
export type InputKey = Exclude<keyof MarketInput, "market" | "timestamp" | "block" | "priceBasis">;
export interface Freshness {
  status: Availability;
  source: string;
  observedAt: number | null;
  ageMs: number | null;
  maxAgeMs: number | null;
  reason: string | null;
}
export interface Factor {
  id: string;
  status: "met" | "not_met" | "unavailable" | "stale";
  inputs: string[];
  description: string;
}
export interface StageAssessment {
  stage: ActiveStage;
  direction: Side;
  factors: Factor[];
  evidenceCount: number;
  minimumEvidence: number;
  required: string[];
  qualified: boolean;
}
export interface BreakoutContext {
  direction: Side;
  level: Level;
  confirmedAt: number;
}
export interface EngineState {
  market: string;
  timestamp: number;
  stage: Stage;
  direction: Direction;
  price: number | null;
  levels: Level[];
  breakout: BreakoutContext | null;
}
export interface SignalEvent {
  id: string;
  type: "STAGE_CHANGED" | "DIRECTION_CHANGED" | "SR_BREAK" | "SR_FAILURE";
  market: string;
  timestamp: number;
  price: number | null;
  fromStage: Stage;
  toStage: Stage;
  fromDirection: Direction;
  direction: Direction;
  progression: boolean;
  level: Level | null;
}
export interface SignalDecision {
  schemaVersion: 1;
  engineVersion: "4stage-v1";
  id: string;
  market: string;
  block: number | null;
  timestamp: number;
  price: number | null;
  stage: Stage;
  direction: Direction;
  reason: string;
  evidenceCount: number;
  metFactors: Factor[];
  unmetFactors: Factor[];
  unavailableData: string[];
  staleData: string[];
  dataFreshness: Record<string, Freshness>;
  assessments: StageAssessment[];
  nextStageRequirements: {
    target: ActiveStage | "REASSESS";
    minimumEvidence: number;
    observedEvidence: number;
    missingRequired: string[];
    supportingCandidates: string[];
  };
  preferredInitialCombinations: string[];
  validation: {
    anchorTimestamp: number;
    anchorPrice: number | null;
    horizonsMinutes: readonly [30, 60, 240, 1440];
    priceBasis: "observed_mid" | "closed_candle_close";
    metrics: "MFE_MAE_NOT_COMPUTED";
  };
}
export interface Evaluation {
  decision: SignalDecision;
  state: EngineState;
  events: SignalEvent[];
}
