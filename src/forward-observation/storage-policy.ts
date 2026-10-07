/** Forward-only storage policy. Not imported by Phase A/B/C defaults. */
export const STORAGE = Object.freeze({ campaignBytes: 4 * 1024 ** 3, warningRatio: .8,
  rawBytes: 512 * 1024 ** 2, reserveBytes: 608 * 1024 ** 2, diskStartBytes: 10 * 1024 ** 3,
  readChunkBytes: 64 * 1024, maxLineBytes: 8 * 1024 ** 2, retainedPrints: 200_000,
  retainedTradeBytes: 32 * 1024 ** 2 });
