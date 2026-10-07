import type { Candle } from "./types";

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** SMA seed followed by standard EMA. Indexes are aligned to the original series. */
export function ema(xs: number[], period: number): (number | null)[] {
  const out: (number | null)[] = Array(xs.length).fill(null);
  if (xs.length < period) return out;
  let v = mean(xs.slice(0, period)); out[period - 1] = v;
  for (let i = period; i < xs.length; i++) { v += 2 / (period + 1) * (xs[i]! - v); out[i] = v; }
  return out;
}
export function rsi(xs: number[], period: number): number | null {
  if (xs.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = xs[i]! - xs[i - 1]!; gain += Math.max(d, 0) / period; loss += Math.max(-d, 0) / period; }
  for (let i = period + 1; i < xs.length; i++) { const d = xs[i]! - xs[i - 1]!; gain = (gain * (period - 1) + Math.max(d, 0)) / period; loss = (loss * (period - 1) + Math.max(-d, 0)) / period; }
  return gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
export function trueRanges(cs: Candle[]): number[] {
  return cs.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - cs[i]!.close), Math.abs(c.low - cs[i]!.close)));
}
export function atr(cs: Candle[], period: number): number | null {
  const tr = trueRanges(cs);
  if (tr.length < period) return null;
  let value = mean(tr.slice(0, period));
  for (const n of tr.slice(period)) value = (value * (period - 1) + n) / period;
  return value;
}
export function macd(xs: number[], fast: number, slow: number, signal: number) {
  if (xs.length < slow + signal) return null; // includes previous histogram
  const f = ema(xs, fast), s = ema(xs, slow);
  const line = xs.slice(slow - 1).map((_, i) => f[i + slow - 1]! - s[i + slow - 1]!);
  const sig = ema(line, signal);
  return { line: line.at(-1)!, signal: sig.at(-1)!, histogram: line.at(-1)! - sig.at(-1)!, previousHistogram: line.at(-2)! - sig.at(-2)! };
}
