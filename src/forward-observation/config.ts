import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import frozenRules from "./frozen-rules.json";
import { DEFAULT_POLICY } from "../signals/engine";
import { PARAMETERS } from "../market-data/adapter";
import { SR_PROMOTION_VERSION } from "../market-data/important-sr";
import { STORAGE } from "./storage-policy";

export const RULE_COMMIT = "91e0b07a7638f0c575ceabd8fb770c7e89eda88c";
export const MARKET = Object.freeze({ venue: "Kuru", chainId: 143, symbol: "MON-USDC", marketType: "spot",
  base: "MON", quote: "USDC", contract: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394" });
export const PLAN = Object.freeze({ version: "kuru-forward-v1", observationMs: 7 * 86400000, tailMs: 4 * 3600000,
  decisionIntervalMs: 60000, baselineBookIntervalMs: 60000, dueBookIntervalMs: 5000,
  notional: 100, notionalCurrency: "USDC", capacityBytes: STORAGE.campaignBytes, warningRatio: STORAGE.warningRatio,
  storage: STORAGE,
  entryDirection: "LONG", entryStages: ["BREAKOUT", "ACCELERATION"], exitHours: [1, 4],
  variants: ["BREAKOUT_1H", "BREAKOUT_4H", "ACCELERATION_1H", "ACCELERATION_4H"] } as const);
export const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export function verifyFrozenRules() {
  for (const [path, expected] of Object.entries(frozenRules)) {
    if (hash(readFileSync(resolve(import.meta.dir, "../..", path))) !== expected) throw Error(`FROZEN_RULE_CHANGED:${path}`);
  }
  return { codeCommit: RULE_COMMIT, fileHashes: frozenRules };
}
export function manifest(campaignId: string, startedAt: number, safety: { dryRun: boolean; model: string; noEnvFile: boolean }, runtimeCodeCommit: string | null = null) {
  if (!/^[a-z0-9-]+$/.test(campaignId) || !Number.isSafeInteger(startedAt) || startedAt < 0) throw Error("INVALID_CAMPAIGN");
  if (!safety.dryRun || safety.model !== "mock" || !safety.noEnvFile) throw Error("OBSERVATION_SAFETY_REQUIRED");
  if (runtimeCodeCommit !== null && !/^[0-9a-f]{40}$/.test(runtimeCodeCommit)) throw Error("INVALID_RUNTIME_COMMIT");
  const config = structuredClone({ ...PLAN, market: MARKET, engine: DEFAULT_POLICY, indicators: PARAMETERS, srPromotion: SR_PROMOTION_VERSION });
  return { campaignId, startedAt, observationEnd: startedAt + PLAN.observationMs,
    tailEnd: startedAt + PLAN.observationMs + PLAN.tailMs, codeCommit: RULE_COMMIT, config,
    // codeCommit remains the legacy rule-provenance alias; never reinterpret old records.
    ruleSourceCommit: RULE_COMMIT, runtimeCodeCommit, ruleFilesHash: hash(JSON.stringify(frozenRules)),
    configHash: hash(JSON.stringify(config)), ruleFiles: frozenRules, rulesFrozen: true, automaticExtension: false,
    liveApproval: "NOT_GRANTED", implementationScope: "OBSERVATION_ONLY_EXPLICIT_SESSION_APPROVAL",
    dryRun: safety.dryRun, model: safety.model, noEnvFile: safety.noEnvFile };
}
export type Manifest = ReturnType<typeof manifest>;

export type CostClass = "OBSERVED" | "POINT_IN_TIME" | "ASSUMED" | "UNKNOWN" | "NOT_APPLICABLE";
export function initialCostLedger() {
  return ["entryFee", "exitFee", "spreadCost", "slippageCost", "fundingCost", "gasCost", "otherExecutionCost"].map(name => ({
    name, evidenceClass: (name === "fundingCost" ? "NOT_APPLICABLE" : "UNKNOWN") as CostClass,
    value: name === "fundingCost" ? 0 : null, currency: name === "gasCost" ? "MON" : "USDC",
    timestamp: null, sourceId: null, scenario: "unassigned", reason: name === "fundingCost" ? "KURU_SPOT" : "No verified execution cost",
  }));
}
