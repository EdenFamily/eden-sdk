import { formatUnits, parseUnits } from "viem";
import { HYPE_DECIMALS, TOKEN_DECIMALS } from "./constants.ts";
import { EdenError } from "./errors.ts";

/**
 * Explicit unit helpers. Every amount the SDK takes or returns is a bigint in the smallest unit (wei): HYPE and every
 * Eden token have 18 decimals. Convert at the edges with these, never with floating point.
 */

function decimalString(value: string | number, what: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new EdenError("invalid:amount", `${what} must be a finite, non-negative number.`);
    // Numbers are converted through their shortest exact decimal form; pass a string for full control.
    return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 18 });
  }
  const s = value.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) throw new EdenError("invalid:amount", `${what} "${value}" is not a plain decimal amount (e.g. "0.5").`);
  return s;
}

/** "1.5" HYPE → 1500000000000000000n wei. Rejects more than 18 decimals instead of rounding. */
export function parseHype(value: string | number): bigint {
  const s = decimalString(value, "HYPE amount");
  if ((s.split(".")[1]?.length ?? 0) > HYPE_DECIMALS) throw new EdenError("invalid:amount", `HYPE has ${HYPE_DECIMALS} decimals; "${s}" has more.`);
  return parseUnits(s, HYPE_DECIMALS);
}

/** 1500000000000000000n wei → "1.5". */
export function formatHype(wei: bigint): string {
  return formatUnits(wei, HYPE_DECIMALS);
}

/** "1000" tokens → 1000 × 10^18 smallest units (every Eden token has 18 decimals). */
export function parseTokens(value: string | number): bigint {
  const s = decimalString(value, "Token amount");
  if ((s.split(".")[1]?.length ?? 0) > TOKEN_DECIMALS) throw new EdenError("invalid:amount", `Eden tokens have ${TOKEN_DECIMALS} decimals; "${s}" has more.`);
  return parseUnits(s, TOKEN_DECIMALS);
}

/** Smallest token units → "1000". */
export function formatTokens(units: bigint): string {
  return formatUnits(units, TOKEN_DECIMALS);
}

/** 3 (%) → 300 bps. Accepts up to two decimals (0.25% → 25 bps). */
export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new EdenError("invalid:slippage", `Slippage must be 0–100 percent, got ${percent}.`);
  const bps = Math.round(percent * 100);
  if (Math.abs(bps - percent * 100) > 1e-6) throw new EdenError("invalid:slippage", `Use at most two decimals of a percent, got ${percent}.`);
  return bps;
}

/** 300 bps → 3 (%). */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/** A price in wei of HYPE per whole token (1e18 units), as returned in quotes, → HYPE per token as a decimal string. */
export function formatPrice(weiPerToken: bigint): string {
  return formatUnits(weiPerToken, HYPE_DECIMALS);
}
