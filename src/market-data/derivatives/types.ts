/** Independent observations: never imported by the trader or signal engine. */
export const MARKET = {
  exchange: "bybit", symbol: "MONUSDT", marketType: "linear_perpetual",
  underlying: "Monad", baseAsset: "MON", quoteAsset: "USDT", settleAsset: "USDT",
  identityBasis: "explicit MON/Monad mapping; validate Trading LinearPerpetual metadata",
  relatedSpot: { exchange: "kuru", symbol: "MON-USDC", chainId: 143, comparable: false },
} as const;
export type Status = "available" | "stale" | "unavailable";
export type Kind = "oi" | "funding-settled" | "funding-current" | "liquidation";
export interface Observation {
  schemaVersion: 1;
  mode: "observation-only";
  market: typeof MARKET;
  kind: Kind;
  source: string;
  sourceTimestamp: number | null;
  receivedTimestamp: number;
  observedTimestamp: number;
  responseTimestamp: number | null;
  timestampKind: "bucket" | "settlement" | "event" | "unknown";
  ageMs: number | null;
  status: Status;
  reason: string | null;
  raw: unknown;
  value: Record<string, unknown>;
}
export function assertSafe(env: Record<string, string | undefined>) {
  if (env.DRY_RUN !== "true" || env.MODEL !== "mock") throw Error("Require DRY_RUN=true MODEL=mock");
  if (Object.entries(env).some(([k,v]) => !!v && /PRIVATE_KEY|MNEMONIC|SEED_PHRASE|API_KEY|API_SECRET|WALLET/i.test(k)))
    throw Error("Credential-bearing environment refused (values not displayed)");
}
