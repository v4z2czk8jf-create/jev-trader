import { appendFile, mkdir, stat } from "node:fs/promises";
import type { BlockEvent } from "../trader";
import { adaptObservation, captureObservation } from "./adapter";
import { DEFAULT_POLICY, evaluate } from "./engine";
import type { EngineState, Evaluation, MarketInput } from "./types";
import type { Enrichment, MarketDataSnapshot } from "../market-data/types";

export interface SignalRecord extends Evaluation {
  mode: "observation-only";
  dryRun: true;
  model: "mock";
  policy: typeof DEFAULT_POLICY;
  input: MarketInput;
  marketData?: MarketDataSnapshot;
}
export type SignalSink = (record: SignalRecord) => Promise<void>;
async function jsonlSink(record: SignalRecord): Promise<void> {
  await mkdir("data", { recursive: true });
  const path="data/4stage-signals.jsonl",line=JSON.stringify(record)+"\n";
  let size=0;try{size=(await stat(path)).size;}catch(e:any){if(e.code!=="ENOENT")throw e;}
  if(size+Buffer.byteLength(line)>128*1024*1024)throw Error("Observation JSONL capacity reached; existing data preserved");
  await appendFile(path, line);
}

/** Bounded, best-effort side channel: at most one write in flight, at most 1 Hz.
 * Failures disable only this observer. No order/model imports at runtime.
 * Optional enrichment performs isolated read-only I/O; the trading callback never awaits it.
 * State is session-local and deliberately starts afresh on restart.
 */
export function createSignalObserver(
  options: { market: string; dryRun: boolean; model: string; enrich?: (input: MarketInput) => Promise<Enrichment> },
  sink: SignalSink = jsonlSink,
) {
  let disabled = options.dryRun !== true || options.model !== "mock";
  let busy = false, lastObservedAt = -Infinity;
  let state: EngineState | undefined;
  let pending: Promise<void> = Promise.resolve();
  function observe(e: BlockEvent): void {
    if (disabled || busy || e.ts - lastObservedAt < 1000) return;
    try {
      const snapshot = captureObservation(e); // copy primitives, never retain mutable trader events
      lastObservedAt = e.ts;
      busy = true;
      pending = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
        const raw = adaptObservation(snapshot, options.market, Date.now());
        const enriched = options.enrich ? await options.enrich(raw) : undefined;
        const input = enriched?.input ?? raw, policy = enriched?.policy ?? DEFAULT_POLICY;
        const result = evaluate(input, state, policy);
        await sink({ mode: "observation-only", dryRun: true, model: "mock", policy, input, ...(enriched ? { marketData: enriched.marketData } : {}), ...result });
        state = result.state;
      }).catch(() => {
        disabled = true;
        console.warn("4Stage observer disabled after an observation/logging error; trading logic unchanged");
      }).finally(() => { busy = false; });
    } catch {
      disabled = true;
      console.warn("4Stage observer disabled after an observation capture error");
    }
  }
  return { observe, flush: () => pending };
}
