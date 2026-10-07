import { freshness } from "../signals/engine";
import type { BookObservation } from "../market-data/book-source";
import { MARKET } from "./config";

/** Static visible-depth arithmetic only: not a fill, order, size instruction or gas estimate. */
export function virtualSnapshot(book: BookObservation, side: "BUY" | "SELL", amount: number,
  unit: "USDC" | "MON", targetTimestamp: number, capturedAt: number) {
  if (!Number.isFinite(amount) || amount <= 0 || ![targetTimestamp, capturedAt].every(Number.isSafeInteger)) throw Error("INVALID_SNAPSHOT_REQUEST");
  const q = book.data;
  const reasons: string[] = [];
  if (q.source !== `monad:143:kuru:${MARKET.contract.toLowerCase()}:finalized-book`) reasons.push("MARKET_IDENTITY_MISMATCH");
  if (freshness(q, capturedAt).status !== "available" || !("value" in q)) reasons.push("BOOK_NOT_FRESH");
  if (q.sourceTimestamp === null || q.sourceTimestamp < targetTimestamp) reasons.push("PRE_TARGET_BOOK");
  if (!Number.isSafeInteger(q.receivedTimestamp) || q.receivedTimestamp > capturedAt || q.sourceTimestamp !== null && q.sourceTimestamp > q.receivedTimestamp) reasons.push("INVALID_RECEIPT_CLOCK");
  if (capturedAt < targetTimestamp) reasons.push("BEFORE_TARGET");
  const b = "value" in q ? q.value : null;
  const levels = b ? side === "BUY" ? b.levels.asks : b.levels.bids : [];
  if (levels.some(([p, s], i) => !Number.isFinite(p) || p <= 0 || !Number.isFinite(s) || s < 0 ||
      i > 0 && (side === "BUY" ? levels[i - 1]![0] >= p : levels[i - 1]![0] <= p))) reasons.push("INVALID_LEVELS");
  if (b && (!Number.isFinite(b.mid) || b.mid <= 0 || b.bid >= b.ask)) reasons.push("INVALID_QUOTE");
  // A truncated AMM ladder is not a proven executable inventory. Preserve snapshot for research.
  if (b?.vaultActive) reasons.push("ACTIVE_AMM_EXECUTABILITY_UNVERIFIED");
  let remaining = amount, quantity = 0, quote = 0;
  if (!reasons.length) for (const [price, size] of levels) {
    const take = Math.min(size, unit === "USDC" ? remaining / price : remaining);
    quantity += take; quote += take * price;
    remaining = Math.max(0, remaining - (unit === "USDC" ? take * price : take));
    if (remaining <= amount * Number.EPSILON * 8) { remaining = 0; break; }
  }
  const vwap = !reasons.length && quantity > 0 ? quote / quantity : null;
  return { mode: "VIRTUAL_STATIC_DEPTH_NOT_EXECUTED" as const, market: MARKET, side, requestedAmount: amount, requestedUnit: unit,
    targetTimestamp, capturedAt, snapshotTimestamp: q.sourceTimestamp, receivedTimestamp: q.receivedTimestamp,
    availableAt: capturedAt, ageMs: q.sourceTimestamp === null ? null : capturedAt - q.sourceTimestamp,
    delayMs: capturedAt - targetTimestamp, block: book.block, blockHash: book.blockHash,
    bestBid: b?.bid ?? null, bestAsk: b?.ask ?? null, mid: b?.mid ?? null, spreadBps: b?.spreadBps ?? null,
    depth: b?.depth ?? null, coverage: "TOP_5_LEVELS_ONLY" as const, levels,
    status: reasons.length ? "UNAVAILABLE" as const : quantity === 0 ? "UNFILLED" as const : remaining ? "PARTIAL" as const : "COMPLETE_VISIBLE_DEPTH" as const,
    reasons, virtualVwap: vwap, filledQuantity: reasons.length ? null : quantity,
    unfilledAmount: reasons.length ? null : remaining, unfilledUnit: unit, quoteAmount: reasons.length ? null : quote,
    priceImpactBps: vwap !== null && b ? (side === "BUY" ? vwap / b.mid - 1 : 1 - vwap / b.mid) * 10000 : null,
    priceBasis: "EXECUTION_INCLUDES_SPREAD_AND_VISIBLE_IMPACT", additionalSlippage: "UNKNOWN", fillEvidenceClass: "ASSUMED",
    orderConstraints: "UNVERIFIED_MIN_SIZE_TICK_FEE_QUEUE_LATENCY", profitabilityEligible: false };
}
export type VirtualSnapshot = ReturnType<typeof virtualSnapshot>;

export function gasContext(header: { number: string; hash: string; timestamp: string; baseFeePerGas?: string; gasUsed?: string; gasLimit?: string }, receivedTimestamp: number) {
  const quantity = (s: string | undefined) => s !== undefined && /^0x[0-9a-f]+$/i.test(s) ? BigInt(s).toString() : null;
  const seconds = quantity(header.timestamp), sourceTimestamp = seconds === null ? null : Number(seconds) * 1000;
  if (sourceTimestamp === null || !Number.isSafeInteger(sourceTimestamp) || sourceTimestamp > receivedTimestamp || !Number.isSafeInteger(receivedTimestamp)) throw Error("INVALID_GAS_CLOCK");
  return { block: quantity(header.number), blockHash: header.hash, sourceTimestamp, receivedTimestamp,
    availableAt: receivedTimestamp, baseFeePerGasWei: quantity(header.baseFeePerGas), blockGasUsed: quantity(header.gasUsed), blockGasLimit: quantity(header.gasLimit),
    contextClass: "POINT_IN_TIME", transactionGasLimit: null, transactionGasUsed: null, actualPaidGasCost: null,
    gasCostClass: "UNKNOWN", monadChargingBasis: "TRANSACTION_GAS_LIMIT_NOT_GAS_USED" };
}
