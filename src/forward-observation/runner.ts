import { readFile, readdir, mkdir, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { ForwardController } from "./controller";
import { MinuteSource } from "./minute-source";
import { ForwardCollector, rawProof, recoverRaw, reusableRaw, type RawProof } from "./collector";
import { CampaignJournal, campaignLock, exclusiveVerified, footprint, type JournalRecord } from "./journal";
import { manifest, MARKET, PLAN, hash, verifyFrozenRules, type Manifest } from "./config";
import { publicRpc, type Rpc } from "../market-data/rpc-source";
import { RawHasher } from "./raw-storage";
import { STORAGE } from "./storage-policy";
import { forwardPreflight } from "./provenance";

export const WRITE_RESERVE = STORAGE.reserveBytes; // raw512 + checkpoint old/new64 + batch32; no pruning
export interface RuntimeCheckpoint {
  manifest: Manifest; controller: ReturnType<ForwardController["checkpoint"]>;
  minute: ReturnType<MinuteSource["checkpoint"]> | null; cacheGeneration: string; raw: RawProof | null;
  lastCompletedAcquisition: number | null; lastCommittedAt: number; sessionStatus: "RUNNING" | "PAUSED" | "ENDED";
  lastDecision: number | null; reason: string; totalRpc: number; totalResponseBytes: number;
}
export interface SessionOptions {
  parent: string; campaignId: string; resume: boolean; mode: "smoke" | "forward" | "capacity";
  approval: string; seconds: number; maxRpc: number; dryRun: boolean; model: string; noEnvFile: boolean;
}
export function validateSession(o: SessionOptions) {
  if (!o.dryRun || o.model !== "mock" || !o.noEnvFile || !/^[a-z0-9-]+$/.test(o.campaignId)) throw Error("OBSERVATION_SAFETY_REQUIRED");
  if (!["smoke", "forward", "capacity"].includes(o.mode) || o.approval !== (o.mode === "smoke" ? "PUBLIC_READ_ONLY_SMOKE" : o.mode === "capacity" ? "PUBLIC_CAPACITY_MEASUREMENT" : "START_OR_RESUME_7D_FORWARD")) throw Error("EXPLICIT_APPROVAL_REQUIRED");
  if (!Number.isSafeInteger(o.seconds) || o.seconds < 10 || o.seconds > (o.mode === "smoke" ? 300 : o.mode === "capacity" ? 900 : 172 * 3600) ||
    !Number.isSafeInteger(o.maxRpc) || o.maxRpc < 1 || o.maxRpc > (o.mode === "smoke" ? 200 : o.mode === "capacity" ? 4000 : 1_000_000)) throw Error("INVALID_SESSION_BOUND");
}
export function capacityGuard(bytes: number, limit: number, freeBytes: number) {
  if (bytes + WRITE_RESERVE > limit || freeBytes < WRITE_RESERVE) throw Error("CAPACITY_RESERVE_STOP_DATA_PRESERVED");
}
async function exists(path: string) { try { await stat(path); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } }
async function bytesAt(path: string) { try { return (await stat(path)).size; } catch (e: any) { if (e.code === "ENOENT") return 0; throw e; } }
export async function buildFingerprint() {
  const files: Record<string, string> = {};
  for (const name of (await readdir(import.meta.dir)).sort()) if (/\.(ts|json)$/.test(name)) files[name] = hash(await readFile(join(import.meta.dir, name)));
  for(const name of ["rpc-source.ts","history-store.ts"]) files[`../market-data/${name}`]=hash(await readFile(join(import.meta.dir,"../market-data",name)));
  return { hash: hash(JSON.stringify(files)), files };
}
export async function storageSmoke(directory: string, journal?: CampaignJournal<unknown>) {
  const file = join(directory, `storage-smoke-${randomUUID()}.json`), text = JSON.stringify({ synthetic: true, purpose: "storage-only", createdAt: Date.now() });
  if(journal)await journal.writeArtifact(file.slice(directory.length+1),text);else await exclusiveVerified(file,text);
  return { path: file, sha256: hash(text), bytes: Buffer.byteLength(text), checksum: "PASS", sync: true };
}

/** One foreground session. Explicit manual resume only; no scheduler/service/process spawning. */
export async function runSession(o: SessionOptions, injectedRpc?: Rpc) {
  const began = Date.now(), mono = performance.now(), cpuStart = process.cpuUsage();
  validateSession(o); verifyFrozenRules();
  const runtimeCodeCommit = o.mode === "forward" ? forwardPreflight() : null;
  let pause = false, reason = "SESSION_TIME_LIMIT", peakRss = process.memoryUsage().rss, responseBytes = 0;
  const stop = () => { pause = true; reason = "GRACEFUL_USER_STOP"; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  let release: (() => Promise<void>) | undefined, directory: string | undefined;
  let journal: CampaignJournal<RuntimeCheckpoint> | undefined, controller: ForwardController | undefined;
  let minute: MinuteSource | null = null, collector: ForwardCollector | undefined, state: RuntimeCheckpoint | undefined;
  let lastBook = -Infinity, lastHistory = -Infinity, lastLoop = began, sessionRpcStart = 0;
  const sessionId = randomUUID();
  let firstHistory = true, steadyCycles = 0;
  const remaining = () => o.seconds * 1000 - (performance.now() - mono);
  try {
    directory = resolve(o.parent, o.campaignId);
    if (o.resume) {
      if (!(await exists(directory))) throw Error("CAMPAIGN_MISSING");
      release = await campaignLock(directory);
      journal = await CampaignJournal.resume<RuntimeCheckpoint>(directory);
      const loaded = journal.checkpoint(); if (!loaded) throw Error("CHECKPOINT_MISSING"); state = loaded;
      if (state.manifest.campaignId !== o.campaignId || state.sessionStatus === "ENDED") throw Error("CAMPAIGN_ENDED_OR_MISMATCH");
      if (o.mode === "forward") forwardPreflight(state.manifest);
      controller = ForwardController.restore(state.manifest, state.controller);
      const fixed = JSON.parse(await readFile(join(directory, "run-manifest.json"), "utf8"));
      if (fixed.mode !== o.mode || JSON.stringify(fixed.manifest) !== JSON.stringify(state.manifest) || fixed.implementation.hash !== (await buildFingerprint()).hash) throw Error("IMPLEMENTATION_OR_MANIFEST_CHANGED");
    } else {
      journal = await CampaignJournal.create<RuntimeCheckpoint>(o.parent, o.campaignId); directory = journal.directory;
      release = await campaignLock(directory);
      const m = manifest(o.campaignId, began, o, runtimeCodeCommit); controller = new ForwardController(m);
      await journal.writeArtifact("run-manifest.json", JSON.stringify({ manifest: m, implementation: await buildFingerprint(),
        mode: o.mode, startedAt: began, researchClassification: o.mode !== "forward" ? "READINESS_NOT_FORWARD_OOS" : "FORWARD_OBSERVATION",
        sessionApproval: o.approval, portsOpened: [], automaticRestart: false, endpoint: "https://rpc.monad.xyz" }));
      state = { manifest: m, controller: controller.checkpoint(), minute: null, cacheGeneration: "cache-0001", raw: null,
        lastCompletedAcquisition: null, lastCommittedAt: began, sessionStatus: "RUNNING", lastDecision: null, reason: "CREATED", totalRpc: 0, totalResponseBytes: 0 };
      await mkdir(join(directory, state.cacheGeneration));
      await journal.commit([{ stream: "health", id: `created:${sessionId}`, value: { at: began, observationOnly: true } }], state);
    }
    const storage = await footprint(directory), fs = await statfs(directory);
    if(!o.resume&&Number(fs.bavail)*Number(fs.bsize)<STORAGE.diskStartBytes)throw Error("PREFLIGHT_DISK_BELOW_10GIB");
    capacityGuard(storage.bytes, PLAN.capacityBytes, Number(fs.bavail) * Number(fs.bsize));
    const smoke = await storageSmoke(directory,journal);
    if (o.mode === "forward") {
      const saved = JSON.parse(await readFile(join(directory, "run-manifest.json"), "utf8"));
      if (JSON.stringify(saved.manifest) !== JSON.stringify(state.manifest)) throw Error("SAVED_MANIFEST_MISMATCH");
      forwardPreflight(saved.manifest); // Saved provenance/actual HEAD/clean tree before any transport.
    }
    let recovery: unknown = null;
    if (o.resume) {
      const oldPath = join(directory, state.cacheGeneration, `143-${MARKET.contract.toLowerCase()}.jsonl`);
      if (await reusableRaw(join(directory, state.cacheGeneration), state.raw)) recovery = { mode: "VERIFIED_RAW_REUSE", copiedBytes: 0, rawProof: state.raw,
        historicalTradesRecoverable: true, missedSignalAndExecutionBooksRecoverable: false };
      else { const generation = `cache-${sessionId}`;
        recovery = { mode: "PRESERVED_ABNORMAL_RECOVERY", ...await recoverRaw(oldPath, join(directory, generation), state.raw,
          Math.min(STORAGE.rawBytes,PLAN.capacityBytes-(await journal.status()).bytes-96*1024**2)) }; state.cacheGeneration = generation; }
    }
    const cache = join(directory, state.cacheGeneration);
    const rawPath = join(cache, `143-${MARKET.contract.toLowerCase()}.jsonl`);
    const rawHasher=new RawHasher(rawPath);
    minute = state.minute ? MinuteSource.restore(rawPath, state.minute) : new MinuteSource(rawPath);
    let responseTotal = state.totalResponseBytes;
    const transport = async (url: string, init: RequestInit): Promise<Response> => {
      const response = await fetch(url, init), reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (!reader) throw Error("EMPTY_HTTP_BODY");
      try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; responseBytes += r.value.length;
        if (size > 4 * 1024 ** 2) throw Error("PUBLIC_RESPONSE_SIZE_CAP"); chunks.push(r.value); } }
      finally { await reader.cancel(); }
      return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: { "content-type": "application/json" } });
    };
    const guard = () => {
      if (pause) throw Error("GRACEFUL_STOP_REQUESTED");
      if (remaining() < 8500 || Date.now() + 8500 > state!.manifest.tailEnd) throw Error("REQUEST_WOULD_EXCEED_DEADLINE");
      if ((collector?.metrics.length ?? 0) >= o.maxRpc) throw Error("SESSION_RPC_CAP");
    };
    collector = new ForwardCollector(cache, guard, injectedRpc ?? publicRpc("https://rpc.monad.xyz", transport));
    const envelope = (r: JournalRecord): JournalRecord => ({ ...r, value: { data: r.value, market: MARKET,
      availableAt: Date.now(), ruleCommit: state!.manifest.codeCommit, configHash: state!.manifest.configHash,
      ruleSourceCommit: state!.manifest.ruleSourceCommit, runtimeCodeCommit: state!.manifest.runtimeCodeCommit,
      policyVersion: "4stage-v1", srPromotionVersion: state!.manifest.config.srPromotion } });
    const save = async (rows: JournalRecord[], status: RuntimeCheckpoint["sessionStatus"], why: string) => {
      await collector!.syncFiles();
      const now = Date.now();
      state = { ...state!, controller: controller!.checkpoint(), minute: minute!.checkpoint(), raw: await rawHasher.proof(),
        lastCommittedAt: now, sessionStatus: status, reason: why, lastDecision: controller!.checkpoint().lastDecision,
        totalRpc: state!.totalRpc + collector!.metrics.length - sessionRpcStart, totalResponseBytes: responseTotal + responseBytes };
      sessionRpcStart = collector!.metrics.length;
      await journal!.commit(rows.map(envelope), state);
    };
    await save([{ stream: "health", id: `session:${sessionId}`, value: { at: Date.now(), smoke, recovery,
      missingInterval: o.resume ? { from: state.lastCommittedAt, to: Date.now(), status: "OBSERVATION_GAP",
        historicalTradeBackfillPossible: true, signalAndBookReconstruction: false } : null,
      preservedPendingFiles: journal.recoveredPending, resumed: o.resume, pid: process.pid, sessionSeconds: o.seconds, maxRpc: o.maxRpc } }], "RUNNING", "SESSION_START");
    while (!pause) {
      const now = Date.now(), records: JournalRecord[] = [];
      if (now < lastLoop) { reason = "WALL_CLOCK_REVERSED"; break; }
      if (now - lastLoop > 10000) records.push({ stream: "quality", id: `gap:${lastLoop}:${now}`,
        value: { from: lastLoop, to: now, reason: "SLEEP_OR_PROCESS_STALL_POSSIBLE", bookAndSignalUnavailable: true } });
      lastLoop = now;
      if (now >= state.manifest.tailEnd) { reason = "FIXED_TAIL_END"; await save(controller.finish(now), "ENDED", reason); break; }
      if (remaining() < 9000 || collector.metrics.length >= o.maxRpc) { reason = "SESSION_BUDGET_PAUSE"; break; }
      if (await exists(join(directory, "STOP_REQUESTED"))) { reason = "GRACEFUL_STOP_FILE"; break; }
      const due = controller.dueBook(now), wantHistory = now - lastHistory >= PLAN.decisionIntervalMs;
      const wantBook = due ? now - lastBook >= PLAN.dueBookIntervalMs : now - lastBook >= PLAN.baselineBookIntervalMs;
      if (wantHistory || wantBook) {
        const footprintBefore = await journal.status(), free = await statfs(directory);
        capacityGuard(footprintBefore.bytes, PLAN.capacityBytes, Number(free.bavail) * Number(free.bsize));
        if (wantHistory) {
          const initialBackfill = o.mode === "capacity" && firstHistory && !o.resume;
          const beganAcquire = Date.now(), rawBefore = await bytesAt(rawPath);
          const sourceCheckpointPath = rawPath.replace(/\.jsonl$/, ".checkpoint.json"), checkpointBytesBefore = await bytesAt(sourceCheckpointPath);
          await collector.history.refresh(initialBackfill ? 1200 : 8); lastHistory = Date.now(); firstHistory = false;
          const h = collector.history.history();
          const caughtUp = !h.error && Math.floor(h.throughTimestamp / 60000) === Math.floor(lastHistory / 60000);
          if (!initialBackfill && caughtUp) steadyCycles++; else steadyCycles = 0;
          records.push({ stream: "quality", id: `history:${beganAcquire}`, value: { from: h.fromTimestamp, through: h.throughTimestamp,
            receivedTimestamp: h.receivedTimestamp, error: h.error, rawStorage: collector.history.storage(),
            purpose: initialBackfill ? "INITIAL_BACKFILL" : caughtUp ? "CURRENT_INCREMENT" : "BACKFILL_INCOMPLETE",
            rawBytesBefore: rawBefore, acquisitionStartedAt: beganAcquire, completedAt: lastHistory,
            checkpointBytesBefore, checkpointBytesAfter: await bytesAt(sourceCheckpointPath),
            transportCaughtUp: caughtUp, indicatorReadiness: "SEE_UNCHANGED_SIGNAL_INPUT_QUALITY" } });
          if (!h.error) {
            const result = await minute.read();
            if (result.pendingBytes) throw Error("RAW_PARTIAL_AFTER_SUCCESSFUL_ACQUISITION");
            if (result.history) {
              const rows = controller.observe(h, Date.now(), [result.sourceRecordId], result.history); records.push(...rows);
              const end = controller.checkpoint().lastMinuteEnd;
              if (end !== null && end >= (result.history.rawFromTimestamp ?? result.history.fromTimestamp)) minute.acknowledge(end);
            }
            state.lastCompletedAcquisition = Date.now();
          } else {
            // Never use stale-success after an acquisition error; preserve an unavailable decision.
            records.push(...controller.observe(h, Date.now(), [`failed-history:${beganAcquire}`]));
            if (/capacity|checkpoint|mismatch|changed|recovery|raw cache|ENOENT|EACCES|EPERM/i.test(h.error)) {
              reason = `SOURCE_REVIEW_REQUIRED:${h.error}`; pause = true;
            }
          }
        }
        if (!pause && (wantBook || controller.dueBook(Date.now())) && remaining() >= 9000 && collector.metrics.length < o.maxRpc) {
          await collector.book.refresh(); lastBook = Date.now(); const book = collector.book.snapshot(lastBook), id = `book:${lastBook}`;
          records.push({ stream: "book", id, value: book });
          records.push(...controller.book(book, Date.now(), id));
        }
        records.push(...collector.drain());
        records.push({ stream: "health", id: `cycle:${Date.now()}:${sessionId}`, value: { at: Date.now(), metrics: collector.metrics.slice(sessionRpcStart),
          phase: controller.phase(Date.now()), storageBefore: footprintBefore, warning80: footprintBefore.bytes >= PLAN.capacityBytes * .8,
          pendingExits: controller.state().jobs.filter(j => !j.done), responseBytes, cpu: process.cpuUsage(cpuStart), memory: process.memoryUsage() } });
        await save(records, "RUNNING", "ACQUISITION_COMPLETE");
        if (o.mode === "capacity" && steadyCycles >= 4) { reason = "PLANNED_CAPACITY_SAMPLE_COMPLETE"; break; }
      } else if (records.length) await save(records, "RUNNING", "GAP_RECORDED");
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      await Bun.sleep(Math.min(250, Math.max(0, remaining() - 8500)));
    }
    if (state.sessionStatus !== "ENDED") await save([{ stream: "health", id: `pause:${sessionId}`, value: { reason, at: Date.now(),
      syntheticResolution: false, remainingJobs: controller.state().jobs.filter(j => !j.done), restart: "EXPLICIT_MANUAL_RESUME_ONLY" } }], "PAUSED", reason);
    const verified = await CampaignJournal.resume<RuntimeCheckpoint>(directory);
    const durationMs = performance.now() - mono, cpu = process.cpuUsage(cpuStart), storageFinal = await verified.status();
    const result = { campaignId: o.campaignId, sessionId, directory, began, endedAt: Date.now(), durationMs, reason,
      observationEnd: state.manifest.observationEnd, tailEnd: state.manifest.tailEnd, phase: controller.phase(Date.now()),
      rpc: collector.metrics, rpcCount: collector.metrics.length, responseBytes, rpcPerMinute: collector.metrics.length / durationMs * 60000,
      storage: storageFinal, sessionGrowthBytes: storageFinal.bytes - storage.bytes, sessionGrowthFiles: storageFinal.files - storage.files,
      bytesPerMinute: (storageFinal.bytes - storage.bytes) / durationMs * 60000, filesPerMinute: (storageFinal.files - storage.files) / durationMs * 60000,
      cpuMs: (cpu.user + cpu.system) / 1000, cpuPercentOneCore: (cpu.user + cpu.system) / (durationMs * 10), logicalCpus: cpus().length,
      peakRss, memory: process.memoryUsage(), checkpoint: { hash: storageFinal.headHash, sequence: storageFinal.sequence, status: state.sessionStatus },
      controller: controller.state(), checksumFailures: 0, saveFailures: 0, scope: "READINESS_ONLY_UNLESS_SEPARATELY_APPROVED_FORWARD", recovery };
    await journal.writeArtifact(`session-summary-${sessionId}.json`, JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    // A failed batch must not be checkpointed with mutated in-memory state. Last committed
    // batch remains authoritative; stderr is required when storage cannot accept health.
    console.error(JSON.stringify({ event: "FORWARD_SAFE_STOP", at: Date.now(), directory, reason: e instanceof Error ? e.message : "UNKNOWN_ERROR",
      lastCommittedCheckpointPreserved: true, automaticResume: false })); throw e;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    if (release) await release();
  }
}

if (import.meta.main) {
  const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i < 0 ? undefined : a[i + 1]; };
  const allowed = new Set(["--campaign", "--mode", "--approval", "--seconds", "--max-rpc", "--resume"]);
  if (a.some(x => x.startsWith("--") && !allowed.has(x))) throw Error("UNKNOWN_ARGUMENT");
  if (["PRIVATE_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].some(k => !!process.env[k])) throw Error("SECRET_ENVIRONMENT_REFUSED_WITHOUT_DISPLAY");
  const result = await runSession({ parent: resolve("data/kuru-forward"), campaignId: get("--campaign") ?? "",
    mode: get("--mode") as SessionOptions["mode"], approval: get("--approval") ?? "", resume: a.includes("--resume"),
    seconds: Number(get("--seconds")), maxRpc: Number(get("--max-rpc")), dryRun: process.env.DRY_RUN === "true", model: process.env.MODEL ?? "",
    noEnvFile: process.execArgv.includes("--no-env-file") });
  console.log(JSON.stringify(result, null, 2));
}
