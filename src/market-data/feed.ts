import type { MarketInput } from "../signals/types";
import { enrich } from "./adapter";
import { KuruHistorySource } from "./rpc-source";
import { BookSource } from "./book-source";
import { observeSR,observeSRReplay } from "./phase-b";
import { attachImportantSR } from "./important-sr";

/** Constructed only for dry/mock observations. No timer or trading callback is owned here. */
export function createMarketDataFeed(market: string) {
  const source = new KuruHistorySource(market);
  const book = new BookSource(market);
  return async (input: MarketInput) => {
    await Promise.allSettled([source.refresh(),book.refresh()]);
    const result=enrich(input, source.history(), Date.now());
    const sr=observeSR(result.marketData);
    result.marketData.phaseB={mode:"observation-only-not-engine-evidence",book:book.snapshot(),sr,srReplay:observeSRReplay(result.marketData,sr),storage:source.storage(),storageError:source.history().error};
    return attachImportantSR(result);
  };
}
