/** Public read-only acquisition + offline evaluation. No backend, wallet or orders. */
import { mkdir, appendFile } from "node:fs/promises";
import { KuruHistorySource } from "../src/market-data/rpc-source";
import { enrich } from "../src/market-data/adapter";
import { adaptObservation, unavailable } from "../src/signals/adapter";
import { evaluate } from "../src/signals/engine";

if (process.env.DRY_RUN !== "true" || process.env.MODEL !== "mock" || process.env.PRIVATE_KEY || process.env.TYPESAFE_AI_API_KEY) throw Error("Require dry/mock with no credentials");
const market = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const source = new KuruHistorySource(market);
const ranges = Number(process.argv[2] ?? 8);
await source.refresh(ranges, (n, through) => console.log(JSON.stringify({ readOnlyRanges: n, through: new Date(through).toISOString() })));
// No live quote was acquired by this script. The template's price fields are replaced
// with explicit unavailable data before evaluation/logging, never treated as market prices.
const raw = adaptObservation({ block: 0, ts: Date.now(), mid: NaN, bestBid: NaN, bestAsk: NaN, spreadBps: NaN, cached: true }, market, Date.now());
raw.price = unavailable("read-only-smoke", "Live quote not requested");
raw.topOfBook = unavailable("read-only-smoke", "Live quote not requested");
const data = enrich(raw, source.history(), Date.now());
const evaluation = evaluate(data.input, undefined, data.policy);
await mkdir("data", { recursive: true });
await appendFile("data/market-data-smoke.jsonl", JSON.stringify({ mode: "read-only-market-data", ...data, ...evaluation }) + "\n");
console.log(JSON.stringify({ source: source.source, error: source.history().error, trades: source.history().trades.length,
  through: new Date(source.history().throughTimestamp).toISOString(), stage: evaluation.decision.stage, evidenceCount: evaluation.decision.evidenceCount,
  frames: Object.fromEntries(Object.entries(data.marketData.frames).map(([tf, f]) => [tf, {
    bars: f.candles.trace.barsUsed, sourceTimestamp: f.candles.sourceTimestamp,
    statuses: Object.fromEntries(Object.entries(f).filter(([k]) => k !== "timeframe").map(([k, v]) => [k, typeof v === "object" ? v.status : v])),
  }])) }, null, 2));
if (source.history().error) process.exitCode = 1;
