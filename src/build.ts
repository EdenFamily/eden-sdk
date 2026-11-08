/**
 * Local mode: builds the same transaction plans as POST /tx/* entirely from on-chain reads, so no trust in Eden's
 * server is needed. Every builder returns steps in signing order.
 */
import { getAddress, keccak256, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import {
  appendMarker, encodeApprove, encodeClaim, encodeClaimToken, encodeCreatePool, encodeCurveBuy, encodeCurveSell, encodeCurveSweep, encodeGraduate,
  encodeLaunchAndBuy, encodeLaunchToken, encodePermit2Approve, encodePoolSweep, encodeV4Swap, MAX_UINT160, MAX_UINT256, type TokenParams,
} from "./calldata.ts";
import { poolIdOf, poolKeyFor, type EdenReader, type LaunchInfo, type PoolInfo } from "./chain.ts";
import { DEFAULT_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS } from "./constants.ts";
import { initialBuyTokens, quoteBuy, quoteSell, type CurveQuote } from "./curve.ts";
import { PERMIT_AMOUNT, PERMIT_SECONDS, permitTyped, quotePool, type Permit, type PoolQuote } from "./pool.ts";
import { minOutFor } from "./slippage.ts";
import { EdenError, NotTradableError } from "./errors.ts";
import { IPFS_LOGO, type NormalizedMetadata } from "./metadata.ts";
import type { Claimable, ClaimPlan, ClaimRequest, GraduatePlan, GraduateRequest, LaunchPlan, Quote, Step, SwapPlan, SwapRequest } from "./types.ts";

export type BuildOptions = {
  /** Calldata marker appended to every transaction (default: Eden's 4544454e0001); false for none. */
  marker: string | false;
  /**
   * "unlimited" (default, as the website and Eden's API: maxUint256 to the curve or Permit2, Permit2 maxUint160 to the
   * router for a year) or "exact" (approve only the amount being sold, Permit2 for 30 minutes).
   */
  approval?: "exact" | "unlimited";
  /** Seconds a pool swap stays valid (default 600). */
  deadlineSeconds?: number;
  /**
   * Pool sells: authorize the router with a signed Permit2 permit inside the swap (the website's flow: no gas for the
   * permit) when given a signer for EIP-712 data; otherwise with an on-chain Permit2.approve step (the API's flow).
   */
  signPermit?: (typed: ReturnType<typeof permitTyped>) => Promise<Hex>;
};

/** Slippage in bps, checked: an integer from 0 to 5000 (50%) unless `allowHigh`. */
export function checkSlippage(bps: number | undefined, allowHigh = false): number {
  const v = bps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(v) || v < 0 || v >= 10_000) throw new EdenError("invalid:slippage", `slippageBps must be an integer from 0 to 9999, got ${v}.`);
  if (v > MAX_SLIPPAGE_BPS && !allowHigh) throw new EdenError("invalid:slippage", `slippageBps ${v} is above ${MAX_SLIPPAGE_BPS} (50%). Pass allowHighSlippage to use it.`);
  return v;
}

export type LocalQuote = { quote: Quote; launch: LaunchInfo; pool?: PoolInfo; trade: CurveQuote | PoolQuote };

/** The SDK's own quote, from chain state only (curve math or the v4 pool's state). */
export async function localQuote(reader: EdenReader, r: { token: Address; side: "buy" | "sell"; amount: bigint; slippageBps?: number; recipient?: Address; user?: Address }): Promise<LocalQuote> {
  if (r.amount <= 0n) throw new EdenError("invalid:amount", "Amount must be greater than zero.");
  const slippageBps = checkSlippage(r.slippageBps, true);
  const token = getAddress(r.token);
  const launch = await reader.launch(token);
  if (!launch) throw new NotTradableError("token_not_found", `${token} is not an Eden token (the factory has no launch for it).`);
  if (launch.pairToken !== zeroAddress) throw new NotTradableError("unsupported_pair", "This token is paired with an ERC-20, not HYPE; the SDK trades HYPE pairs only.");
  const make = (route: "curve" | "pool", t: CurveQuote | PoolQuote, pool?: PoolInfo): LocalQuote => {
    if (t.out <= 0n) throw new EdenError("quote", "Amount too small: the trade would receive nothing.");
    return { launch, pool, trade: t,
      quote: { token, side: r.side, route, amountIn: r.amount, expectedOut: t.out, minOut: minOutFor(t.out, slippageBps), slippageBps,
        priceImpactBps: t.impactBps, fee: t.fee, tax: t.tax, priceBefore: t.priceBefore, priceAfter: t.priceAfter, graduates: "graduates" in t ? t.graduates : false,
        ...("spent" in t ? { ...(r.side === "buy" ? { amountSpent: t.spent } : {}), refund: t.refund, snipeTax: t.snipeTax } : {}),
        feeAsset: route === "pool" && r.side === "buy" ? "token" : "HYPE" } };
  };
  const wrap = <T>(f: () => T): T => { try { return f(); } catch (e) { throw new EdenError("quote", (e as Error).message); } };
  if (launch.phase === "curve") {
    const recipient = r.recipient ?? r.user ?? zeroAddress;
    const s = await reader.curveState(launch.curve, recipient);
    if (r.side === "sell" && s.readyToGraduate) {
      throw new NotTradableError("graduating", "The curve is sold out and waiting to graduate. Call graduate(token) (anyone may), then trade in the pool.");
    }
    return make("curve", wrap(() => (r.side === "buy" ? quoteBuy(s, r.amount) : quoteSell(s, r.amount))));
  }
  if (launch.phase === "swept") {
    throw new NotTradableError("graduating", "The token graduated but its Uniswap pool is not created yet. Call graduate(token) (anyone may), then trade.");
  }
  if (launch.phase === "rescued") throw new NotTradableError("rescued", "This launch's graduation was rescued by the owner; it has no Eden pool to trade.");
  const pool = await reader.pool(token);
  if (!pool.registered || pool.sqrtPriceX96 === 0n) throw new NotTradableError("no_pool", "The token's Eden pool is not registered with the hook.");
  return make("pool", wrap(() => quotePool(pool, r.side, r.amount)), pool);
}

const step = (kind: Step["kind"], description: string, to: Address, data: Hex, value: bigint, chainId: number, from: Address, marker: string | false): Step =>
  ({ kind, description, tx: { to, data: appendMarker(data, marker), value, chainId, from } });

/** max(latest block timestamp, local clock) + seconds, as the website does (a dev chain's clock may run ahead). */
async function deadlineFrom(reader: EdenReader, seconds: number): Promise<bigint> {
  const block = await reader.blockTimestamp(), wall = BigInt(Math.floor(Date.now() / 1000));
  return (block > wall ? block : wall) + BigInt(seconds);
}

export async function buildSwapLocal(reader: EdenReader, r: SwapRequest, o: BuildOptions): Promise<SwapPlan> {
  const user = getAddress(r.user), token = getAddress(r.token), recipient = getAddress(r.recipient ?? r.user);
  const { quote, launch } = await localQuote(reader, { ...r, token, user, recipient });
  const chainId = reader.chainId, d = reader.deployment, steps: Step[] = [];
  const unlimited = (o.approval ?? "unlimited") === "unlimited";
  if (quote.route === "curve") {
    if (r.side === "buy") {
      steps.push(step("swap", "Buy on the bonding curve", launch.curve, encodeCurveBuy(r.amount, quote.minOut, recipient), r.amount, chainId, user, o.marker));
    } else {
      if ((await reader.allowance(token, user, launch.curve)) < r.amount) {
        steps.push(step("approve", "Approve the bonding curve to take the tokens", token, encodeApprove(launch.curve, unlimited ? MAX_UINT256 : r.amount), 0n, chainId, user, o.marker));
      }
      steps.push(step("swap", "Sell on the bonding curve", launch.curve, encodeCurveSell(r.amount, quote.minOut, recipient), 0n, chainId, user, o.marker));
    }
  } else {
    const deadline = await deadlineFrom(reader, o.deadlineSeconds ?? 600);
    let signed: { permit: Permit; signature: Hex } | undefined;
    if (r.side === "sell") {
      if ((await reader.allowance(token, user, d.permit2)) < r.amount) {
        steps.push(step("approve", "Approve Permit2 to move the tokens", token, encodeApprove(d.permit2, unlimited ? MAX_UINT256 : r.amount), 0n, chainId, user, o.marker));
      }
      const p = await reader.permit2Allowance(user, token, d.universalRouter);
      if ((p.amount < r.amount || p.expiration < deadline + 300n) && o.signPermit) {
        const permit: Permit = { details: { token, amount: unlimited ? PERMIT_AMOUNT : r.amount, expiration: Number(deadline) + (unlimited ? PERMIT_SECONDS : 1_800),
          nonce: Number(p.nonce) }, spender: d.universalRouter, sigDeadline: deadline + 1800n };
        signed = { permit, signature: await o.signPermit(permitTyped(permit, chainId, d.permit2)) };
      } else if (p.amount < r.amount || p.expiration < deadline + 300n) {
        const expiration = Number(deadline + (unlimited ? 365n * 86_400n : 1_800n));
        steps.push(step("permit2-approve", "Allow the Universal Router to spend the tokens through Permit2", d.permit2,
          encodePermit2Approve(token, d.universalRouter, unlimited ? MAX_UINT160 : r.amount, expiration), 0n, chainId, user, o.marker));
      }
    }
    const key = poolKeyFor(token, d);
    const data = encodeV4Swap(key, r.side, r.amount, quote.minOut, deadline, recipient === user ? undefined : recipient, signed);
    steps.push(step("swap", `${r.side === "buy" ? "Buy" : "Sell"} in the Uniswap v4 pool`, d.universalRouter, data, r.side === "buy" ? r.amount : 0n, chainId, user, o.marker));
  }
  return { chainId, route: quote.route, quote, steps };
}

export type LaunchBuild = { meta: NormalizedMetadata; logo: string; user: Address; initialBuy: bigint; creatorFeeRecipient: Address; slippageBps: number; salt?: Hex };

/** The tokens the initial buy should get and its minimum, from the launch config (fresh curve, recipient exempt). */
export async function initialBuyQuote(reader: EdenReader, initialBuy: bigint, creatorTaxBps: number, slippageBps: number): Promise<{ expected: bigint; minOut: bigint }> {
  if (initialBuy === 0n) return { expected: 0n, minOut: 0n };
  const cfg = await reader.launchConfig(0n);
  const expected = initialBuyTokens(initialBuy, cfg.phantomQuote, cfg.supply, cfg.curveFeeBps, BigInt(creatorTaxBps));
  return { expected, minOut: minOutFor(expected, slippageBps) };
}

export async function buildLaunchLocal(reader: EdenReader, b: LaunchBuild, o: BuildOptions): Promise<LaunchPlan> {
  if (!IPFS_LOGO.test(b.logo)) throw new EdenError("invalid:logo", `Local mode needs a logo pinned to IPFS (ipfs://<cid>), got "${b.logo}".`);
  const fee = await reader.launchFee();
  const params: TokenParams = {
    name: b.meta.name, symbol: b.meta.symbol, logo: b.logo, description: b.meta.description, socials: b.meta.socials,
    creatorFeeRecipient: b.creatorFeeRecipient, creatorTaxBps: b.meta.creatorFeeBps, buybackEnabled: b.meta.buyback, expectedEconomics: zeroHash,
    salt: b.salt ?? keccak256(toHex(`${b.user}:${b.meta.symbol}:${Date.now()}:${Math.random()}`)),
  };
  const chainId = reader.chainId, d = reader.deployment;
  let s: Step;
  if (b.initialBuy > 0n) {
    const { minOut } = await initialBuyQuote(reader, b.initialBuy, b.meta.creatorFeeBps, b.slippageBps);
    s = step("launch", `Launch $${b.meta.symbol} and buy with ${b.initialBuy} wei of HYPE`, d.launchAndBuy,
      encodeLaunchAndBuy(params, b.initialBuy, minOut, b.user, b.meta.bundleWallets), fee + b.initialBuy, chainId, b.user, o.marker);
  } else {
    s = step("launch", `Launch $${b.meta.symbol}`, d.factory, encodeLaunchToken(params, b.meta.bundleWallets), fee, chainId, b.user, o.marker);
  }
  return { chainId, logo: b.logo, steps: [s] };
}

/**
 * Claim steps, as POST /tx/claim builds them: sweep-fees for a curve or pool whose creator is `user` and whose fees
 * need no operator swap, then claim() from the escrow. Without `token`, local mode only claims the escrow balance
 * (finding every token a wallet created needs Eden's index; the API does that).
 */
export async function buildClaimLocal(reader: EdenReader, r: ClaimRequest, o: BuildOptions): Promise<ClaimPlan> {
  const user = getAddress(r.user), chainId = reader.chainId, d = reader.deployment, steps: Step[] = [];
  const claimable: Claimable[] = [];
  let sweeping = false;
  if (r.token) {
    const token = getAddress(r.token);
    const launch = await reader.launch(token);
    if (!launch) throw new EdenError("token_not_found", `${token} is not an Eden token.`);
    if (launch.phase === "curve") {
      const f = await reader.curveFees(launch.curve);
      if (f.deployer === user && !f.graduated && f.quoteFeeBalance + f.creatorTaxBalance > 0n) {
        const amount = f.quoteFeeBalance - (f.quoteFeeBalance * BigInt(f.protocolFeeShareBps)) / 10_000n + f.creatorTaxBalance;
        // A creator may sweep a curve's fees into the escrow when no buyback swap is pending (that needs Eden's operator).
        if (f.buybackQuoteBalance === 0n) {
          claimable.push({ kind: "curve_fees", token, asset: "HYPE", amount, how: "sweep_then_claim", note: "Creator fees and creator tax pending on the bonding curve." });
          steps.push(step("sweep-fees", `Sweep ${token}'s pending curve fees: your share is credited to Eden's fee escrow.`, launch.curve, encodeCurveSweep(), 0n, chainId, user, o.marker));
          sweeping = true;
        } else {
          claimable.push({ kind: "curve_fees", token, asset: "HYPE", amount, how: "operator_sweep", note: "Part of these fees is earmarked for buyback: Eden's fee operator sweeps them." });
        }
      }
    } else if (launch.phase === "pool") {
      const pool = await reader.pool(token);
      const f = await reader.poolFees(token);
      if (pool.creator === user && f.quote + f.tax + f.memecoin > 0n) {
        const amount = f.quote - (f.quote * BigInt(f.protocolFeeShareBps)) / 10_000n - f.buyback + f.tax;
        if (f.memecoin === 0n && f.buyback === 0n) {
          claimable.push({ kind: "pool_fees", token, asset: "HYPE", amount, how: "sweep_then_claim", note: "Creator fees pending in the pool's hook." });
          steps.push(step("sweep-fees", `Sweep the pending fees of ${token}'s pool: your share is credited to Eden's fee escrow.`, d.memeHook, encodePoolSweep(poolIdOf(pool.key)), 0n, chainId, user, o.marker));
          sweeping = true;
        } else {
          claimable.push({ kind: "pool_fees", token, asset: "HYPE", amount, how: "operator_sweep", note: "Pool fees that need a conversion or buyback swap, which only Eden's fee operator runs." });
        }
      }
    }
    if ((await reader.escrowTokenBalance(user, token)) > 0n) {
      steps.push(step("claim", "Claim token-denominated fees from the escrow", d.feeEscrow, encodeClaimToken(token), 0n, chainId, user, o.marker));
    }
  }
  const escrow = await reader.escrowBalance(user);
  if (escrow > 0n) claimable.unshift({ kind: "fee_escrow", asset: "HYPE", amount: escrow, how: "claim", note: "Creator fees already credited to you in Eden's fee escrow." });
  if (escrow > 0n || sweeping) steps.push(step("claim", "Claim your whole HYPE balance from Eden's fee escrow to your wallet.", d.feeEscrow, encodeClaim(), 0n, chainId, user, o.marker));
  return { chainId, claimable, steps };
}

export async function buildGraduateLocal(reader: EdenReader, r: GraduateRequest, o: BuildOptions): Promise<GraduatePlan> {
  const user = getAddress(r.user), token = getAddress(r.token), chainId = reader.chainId, d = reader.deployment;
  const launch = await reader.launch(token);
  if (!launch) throw new EdenError("token_not_found", `${token} is not an Eden token.`);
  const steps: Step[] = [];
  if (launch.phase === "curve") {
    const s = await reader.curveState(launch.curve, user);
    if (!s.readyToGraduate) throw new NotTradableError("not_ready", "The curve is not sold out yet; it graduates when its last sellable tokens are bought.");
    steps.push(step("graduate", "Graduate the curve (sweep its reserves to the factory)", d.factory, encodeGraduate(token), 0n, chainId, user, o.marker));
  }
  if (launch.phase === "curve" || launch.phase === "swept") {
    steps.push(step("graduate", "Create the token's Uniswap v4 pool", d.factory, encodeCreatePool(token), 0n, chainId, user, o.marker));
  }
  if (steps.length === 0) throw new NotTradableError("already_graduated", "The token already trades in its pool.");
  return { chainId, steps };
}
