/** Slippage, as on the website (eden-web/src/lib/slippage.ts): percent presets, a 3% default, minimumOut. */
export const SLIPPAGE_PRESETS = [0.5, 1, 3, 5] as const;
export const DEFAULT_SLIPPAGE = 3;
export const MIN_SLIPPAGE = 0.1, MAX_SLIPPAGE = 50;

/** The least a trader accepts for a quoted `out`: out × (1 − slippage). `pct` in percent (website form). */
export function minimumOut(out: bigint, pct: number): bigint {
  return (out * BigInt(Math.round((100 - pct) * 100))) / 10_000n;
}

/** Same, with slippage in basis points (the SDK's form): floor(out × (10000 − bps) / 10000). */
export function minOutFor(out: bigint, slippageBps: number): bigint {
  return (out * (10_000n - BigInt(slippageBps))) / 10_000n;
}
