import { createHash } from "node:crypto";
import { open, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { unavailable } from "../signals/adapter";
import { evaluate } from "../signals/engine";
import type { EngineState, MarketInput, Stage } from "../signals/types";
import { enrich } from "./adapter";
import { attachImportantSR, SR_PROMOTION_VERSION } from "./important-sr";
import type { History, Print } from "./types";

const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
export interface SavedSRChunk {
  version: number; market: string; sizeDecimals: number; fromBlock: number; throughBlock: number;
  fromTimestamp: number; throughTimestamp: number; endHash: string; receivedTimestamp: number; trades: Print[];
}
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

/** Fixed Kuru source, replayed in archived receipt order, not event-time backdating.
 * No feed, RPC client, observer, trader or long-observation directory is imported/opened.
 */
export function replaySavedSR(chunks: SavedSRChunk[]) {
  if (!chunks.length) throw Error("EMPTY_SOURCE");
  const history: History = { market: MARKET, source: `monad:143:kuru:${MARKET.toLowerCase()}:finalized-Trade`,
    fromTimestamp: chunks[0]!.fromTimestamp, throughTimestamp: chunks[0]!.fromTimestamp,
    receivedTimestamp: chunks[0]!.receivedTimestamp, trades: [], error: null };
  const stages: Record<Stage, number> = { WAIT: 0, INSUFFICIENT_DATA: 0, INITIAL: 0, BREAKOUT: 0, ACCELERATION: 0, OVERHEAT: 0 };
  const exclusions: Record<string, number> = {}, missingBreakoutRequirements: Record<string, number> = {};
  const firstImportant = new Map<string, { kind: string; recognitionTimestamp: number; firstReplayAvailableAt: number }>();
  let previous: EngineState | undefined, last: SavedSRChunk | undefined, factorDObservations = 0;
  const seenTrades = new Set<string>(), rows = [];
  for (const [index, c] of chunks.entries()) {
    if (c.version !== 1 || c.market.toLowerCase() !== MARKET.toLowerCase() || c.sizeDecimals !== 10 ||
        ![c.fromBlock, c.throughBlock, c.fromTimestamp, c.throughTimestamp, c.receivedTimestamp].every(Number.isSafeInteger) ||
        c.fromBlock < 1 || c.throughBlock < c.fromBlock || c.throughBlock - c.fromBlock >= 100 ||
        c.throughTimestamp < c.fromTimestamp || c.throughTimestamp > c.receivedTimestamp ||
        !/^0x[0-9a-f]{64}$/i.test(c.endHash) || !Array.isArray(c.trades) ||
        last && (c.fromBlock !== last.throughBlock + 1 || c.fromTimestamp !== last.throughTimestamp || c.receivedTimestamp < last.receivedTimestamp)) {
      throw Error(`INVALID_OR_DISCONTINUOUS_SOURCE:${index}`);
    }
    for (const t of c.trades) {
      if (![t.timestamp, t.block, t.price, t.volume].every(Number.isFinite) || t.price <= 0 || t.volume < 0 ||
          t.block < c.fromBlock || t.block > c.throughBlock || t.timestamp < c.fromTimestamp || t.timestamp > c.throughTimestamp || seenTrades.has(t.id)) {
        throw Error(`INVALID_OR_DUPLICATE_TRADE:${index}`);
      }
      seenTrades.add(t.id); history.trades.push(t);
    }
    last = c; history.throughTimestamp = c.throughTimestamp; history.receivedTimestamp = c.receivedTimestamp;
    if (chunks[index + 1]?.receivedTimestamp === c.receivedTimestamp) continue;
    const missing = unavailable<never>("offline-saved-kuru-only", "Not present in archived trade source; not inferred");
    const input: MarketInput = { market: MARKET, timestamp: c.receivedTimestamp, block: c.throughBlock,
      price: missing, topOfBook: missing, priceAction: missing, volume: missing, levels: missing,
      oi: missing, funding: missing, liquidations: missing, bookStructure: missing, onchain: missing, catalyst: missing, technicals: missing };
    const enriched = attachImportantSR(enrich(input, history, c.receivedTimestamp));
    const evaluation = evaluate(enriched.input, previous, enriched.policy);
    previous = evaluation.state;
    const p = enriched.marketData.importantSR!;
    for (const s of p.important) if (!firstImportant.has(s.id)) firstImportant.set(s.id, {
      kind: s.classification, recognitionTimestamp: s.recognitionTimestamp, firstReplayAvailableAt: s.availableAt });
    for (const e of p.excluded) exclusions[e.reason] = (exclusions[e.reason] ?? 0) + 1;
    const factorD = evaluation.decision.assessments.some(a => a.stage === "INITIAL" && a.factors.some(f => f.id === "D_NEAR_LEVEL" && f.status === "met"));
    if (factorD) factorDObservations++;
    for (const a of evaluation.decision.assessments.filter(a => a.stage === "BREAKOUT" && !a.qualified)) {
      for (const f of a.factors.filter(f => a.required.includes(f.id) && f.status !== "met")) {
        const key = `${a.direction}:${f.id}:${f.status}`; missingBreakoutRequirements[key] = (missingBreakoutRequirements[key] ?? 0) + 1;
      }
      if (a.evidenceCount < a.minimumEvidence) missingBreakoutRequirements[`${a.direction}:SUPPORTING_FACTORS`] = (missingBreakoutRequirements[`${a.direction}:SUPPORTING_FACTORS`] ?? 0) + 1;
    }
    stages[evaluation.decision.stage]++;
    rows.push({ sourceChunkIndex: index, availableAt: c.receivedTimestamp, asOf: enriched.marketData.asOf,
      replayOnly: true, input: enriched.input, policy: enriched.policy, importantSR: p, ...evaluation });
  }
  const important = [...firstImportant.entries()].map(([id, info]) => ({ id, ...info }));
  return { rows, summary: { version: SR_PROMOTION_VERSION, classification: "DEVELOPMENT_REPLAY_NOT_HISTORICAL_LIVE_SIGNALS",
    sourceChunks: chunks.length, uniqueTrades: seenTrades.size, evaluations: rows.length, stages,
    importantCount: important.length, supportCount: important.filter(s => s.kind === "IMPORTANT_SUPPORT").length,
    resistanceCount: important.filter(s => s.kind === "IMPORTANT_RESISTANCE").length, factorDObservations,
    important, exclusions, missingBreakoutRequirements,
    firstRecognitionTimestamp: important.length ? Math.min(...important.map(s => s.recognitionTimestamp)) : null,
    firstReplayAvailableAt: important.length ? Math.min(...important.map(s => s.firstReplayAvailableAt)) : null,
    publicRequests: 0, executionConnected: false, independentTradeSamples: 0 } };
}

if (import.meta.main) {
  if (process.env.DRY_RUN !== "true" || process.env.MODEL !== "mock") throw Error("DRY_RUN=true / MODEL=mock required");
  if (Bun.argv[2] !== "--run" || !/^[a-z0-9-]+$/.test(Bun.argv[3] ?? "")) throw Error("Use --run <new-run-id>");
  const processedAt = Date.now(), sourcePath = resolve("data/market-data/143-" + MARKET.toLowerCase() + ".jsonl");
  const file = await open(sourcePath, "r");
  let snapshot: Buffer;
  try {
    const size = (await file.stat()).size;
    if (size > 64 * 1024 * 1024) throw Error("SOURCE_TOO_LARGE");
    snapshot = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const r = await file.read(snapshot, offset, size - offset, offset); if (!r.bytesRead) throw Error("SOURCE_TRUNCATED"); offset += r.bytesRead; }
  } finally { await file.close(); }
  const completeEnd = snapshot.lastIndexOf(10) + 1, fixed = snapshot.subarray(0, completeEnd);
  const chunks: SavedSRChunk[] = fixed.toString("utf8").trim().split("\n").map(s => JSON.parse(s));
  const result = replaySavedSR(chunks);
  const codeFiles = ["src/market-data/important-sr.ts", "src/market-data/important-sr-replay.ts", "src/market-data/phase-b.ts",
    "src/market-data/sr-candidates.ts", "src/market-data/sr-replay.ts", "src/market-data/adapter.ts", "src/market-data/candles.ts", "src/market-data/indicators.ts", "src/signals/engine.ts"];
  const implementation = await Promise.all(codeFiles.map(async path => ({ path, sha256: sha256(await readFile(path)) })));
  const manifest = { runId: Bun.argv[3], processedAt, sourcePath, sourceSha256: sha256(fixed), capturedBytes: snapshot.length,
    usedBytes: completeEnd, ignoredTailBytes: snapshot.length - completeEnd, recordCount: chunks.length,
    market: { venue: "Kuru", chainId: 143, marketType: "spot", base: "MON", quote: "USDC", contract: MARKET },
    eventRange: [chunks[0]!.fromTimestamp, chunks.at(-1)!.throughTimestamp],
    receiptRange: [chunks[0]!.receivedTimestamp, chunks.at(-1)!.receivedTimestamp],
    implementation, rule: "Existing Phase B validatedAt only; existing engine policy unchanged",
    originalProfitabilityRunUnchanged: true, originalObservationCadenceReproduced: false,
    replayClock: "Archived receipt groups; state is new research replay state, not reconstructed trader session",
    dryRun: true, model: "mock", publicRequests: 0 };
  const outputs: Record<string, Uint8Array | string> = { "source-snapshot.jsonl": fixed,
    "manifest.json": JSON.stringify(manifest, null, 2), "decisions.jsonl": result.rows.map(x => JSON.stringify(x)).join("\n") + "\n",
    "summary.json": JSON.stringify(result.summary, null, 2) };
  outputs["checksums.json"] = JSON.stringify(Object.fromEntries(Object.entries(outputs).map(([path, data]) => [path, sha256(data)])), null, 2);
  const bytes = Object.values(outputs).reduce((n, data) => n + Buffer.byteLength(data), 0);
  if (bytes > 128 * 1024 * 1024) throw Error("REPLAY_OUTPUT_CAPACITY");
  const parent = resolve("data/sr-integration"), directory = resolve(parent, Bun.argv[3]!);
  await mkdir(parent, { recursive: true }); await mkdir(directory); // exclusive run directory; no deletion
  for (const [path, data] of Object.entries(outputs)) {
    await writeFile(resolve(directory, path), data, { flag: "wx" });
    if (sha256(await readFile(resolve(directory, path))) !== sha256(data)) throw Error("OUTPUT_CHECKSUM");
  }
  const originalNow = await readFile(sourcePath);
  if (sha256(originalNow.subarray(0, completeEnd)) !== manifest.sourceSha256) throw Error("ORIGINAL_PREFIX_CHANGED");
  console.log(JSON.stringify({ directory, bytes, files: Object.keys(outputs).length, checksumFailures: 0, originalPrefixUnchanged: true, summary: result.summary }, null, 2));
}
