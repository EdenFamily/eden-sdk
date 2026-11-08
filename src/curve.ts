/**
 * Bonding-curve quotes, ported from the website (eden-web/src/lib/curve.ts) with the same names and shapes, so the site
 * can import them from here. The integer math follows EdenBondingCurve.buy/sell exactly (fee and creator tax floored
 * separately, the snipe tax, and the clamped final buy that crosses graduation), so a quote equals the on-chain fill.
 */
import type { Address, PublicClient } from "viem";
import { edenBondingCurveAbi } from "./abi/eden.ts";

/** Live curve state read from the chain (constant product over the curve's tradeable quote and token reserves). */
export type CurveState = {
  quote: bigint;
  tokens: bigint;
  feeBps: bigint;
  taxBps: bigint;
  /** Snipe tax the buy's recipient pays right now (currentSnipeTaxBps); 0 after the launch window. */
  snipeTaxBps?: bigint;
  /** Tokens still buyable before graduation (sellableTokens). Unset: unlimited. */
  sellable?: bigint;
  graduated?: boolean;
  readyToGraduate?: boolean;
};

export type CurveQuote = {
  /** Tokens out for a buy, HYPE out for a sell, after fees. */
  out: bigint;
  /** Execution price against spot, as the website shows it (fees included). */
  impactBps: number;
  /** HYPE actually spent (a clamped final buy spends less than offered) or tokens sold. */
  spent: bigint;
  /** Eden's fee, snipe tax included (as the CurveBuy event reports it). */
  fee: bigint;
  tax: bigint;
  snipeTax: bigint;
  refund: bigint;
  /** Spot price before and after, in wei of HYPE per whole token. */
  priceBefore: bigint;
  priceAfter: bigint;
  /** The buy takes the last sellable tokens: the curve graduates in the same transaction. */
  graduates: boolean;
};

const BPS = 10_000n;
const ONE = 10n ** 18n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const price = (quote: bigint, tokens: bigint) => (tokens === 0n ? 0n : (quote * ONE) / tokens);

export async function readCurve(client: PublicClient, curve: Address, recipient?: Address, blockNumber?: bigint): Promise<CurveState> {
  const bn = blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const c = (functionName: string, args: unknown[] = []) => client.readContract({ address: curve, abi: edenBondingCurveAbi, functionName: functionName as never, args: args as never, blockNumber: bn }) as Promise<any>;
  const [[quote, tokens], feeBps, taxBps, sellable, graduated, readyToGraduate, snipeTaxBps] = await Promise.all([
    c("getReserves"), c("feeBps"), c("creatorTaxBps"), c("sellableTokens"), c("graduated"), c("readyToGraduate"),
    recipient ? c("currentSnipeTaxBps", [recipient]) : Promise.resolve(0n)]);
  return { quote, tokens, feeBps, taxBps, snipeTaxBps, sellable, graduated, readyToGraduate };
}

/** EdenBondingCurveMath._amountOut with fee 0. */
function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const inWithFee = amountIn * BPS;
  return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
}
/** EdenBondingCurveMath.getAmountIn with fee 0. */
function amountInFor(out: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (out * reserveIn * BPS) / ((reserveOut - out) * BPS) + 1n;
}

/** Tokens out for a HYPE amount in: fees come off the input first. Throws where the contract reverts. */
export function quoteBuy(s: CurveState, quoteIn: bigint): CurveQuote {
  if (s.graduated || s.sellable === 0n) throw new RangeError("The curve has graduated.");
  if (quoteIn <= 0n) throw new RangeError("Amount must be greater than zero.");
  let snipeBps = s.snipeTaxBps ?? 0n;
  if (snipeBps !== 0n) {
    const max = BPS - s.feeBps - s.taxBps - 100n;
    if (snipeBps > max) snipeBps = max;
  }
  let spent = quoteIn;
  let fee = (spent * s.feeBps) / BPS, tax = (spent * s.taxBps) / BPS, snipe = (spent * snipeBps) / BPS;
  let out = amountOut(spent - fee - tax - snipe, s.quote, s.tokens);
  if (out === 0n) throw new RangeError("Amount too small: it buys zero tokens.");
  let clamped = false;
  if (s.sellable !== undefined && out > s.sellable) {
    clamped = true;
    out = s.sellable;
    const net = amountInFor(s.sellable, s.quote, s.tokens);
    const gross = ceilDiv(net * BPS, BPS - s.feeBps - s.taxBps - snipeBps);
    spent = gross < quoteIn ? gross : quoteIn;
    fee = (spent * s.feeBps) / BPS; tax = (spent * s.taxBps) / BPS; snipe = (spent * snipeBps) / BPS;
  }
  const net = spent - fee - tax - snipe;
  const spot = Number(s.quote) / Number(s.tokens), exec = Number(spent) / Math.max(1, Number(out));
  return { out, impactBps: Math.max(0, Math.round((exec / spot - 1) * 10_000)), spent, fee: fee + snipe, tax, snipeTax: snipe, refund: quoteIn - spent,
    priceBefore: price(s.quote, s.tokens), priceAfter: price(s.quote + net, s.tokens - out), graduates: clamped || (s.sellable !== undefined && out === s.sellable) };
}

/** HYPE out for tokens in: fees come off the output. Throws where the contract reverts. */
export function quoteSell(s: CurveState, tokensIn: bigint): CurveQuote {
  if (s.graduated || s.readyToGraduate) throw new RangeError("The curve has graduated.");
  if (tokensIn <= 0n) throw new RangeError("Amount must be greater than zero.");
  const gross = amountOut(tokensIn, s.tokens, s.quote);
  if (gross === 0n) throw new RangeError("Amount too small: it sells for zero HYPE.");
  const fee = (gross * s.feeBps) / BPS, tax = (gross * s.taxBps) / BPS;
  const spot = Number(s.quote) / Number(s.tokens), exec = Number(gross) / Math.max(1, Number(tokensIn));
  return { out: gross - fee - tax, impactBps: Math.max(0, Math.round((1 - exec / spot) * 10_000)), spent: tokensIn, fee, tax, snipeTax: 0n, refund: 0n,
    priceBefore: price(s.quote, s.tokens), priceAfter: price(s.quote - gross, s.tokens + tokensIn), graduates: false };
}

/** Share of supply an initial buy of `hypeIn` gets on a fresh curve (website helper; floating point, for display). */
export function initialBuyShare(hypeIn: number, feeBps = 100, taxBps = 0, phantom = 76.0483): number {
  const net = hypeIn * (1 - (feeBps + taxBps) / 10_000);
  return net > 0 ? 1 - phantom / (phantom + net) : 0;
}

/** Exact tokens a creator's initial buy gets on a fresh curve (phantom HYPE reserve, full supply; recipient exempt from snipe tax). */
export function initialBuyTokens(quoteIn: bigint, phantomQuote: bigint, supply: bigint, curveFeeBps: bigint, creatorTaxBps: bigint): bigint {
  const fee = (quoteIn * curveFeeBps) / BPS, tax = (quoteIn * creatorTaxBps) / BPS;
  return amountOut(quoteIn - fee - tax, phantomQuote, supply);
}
