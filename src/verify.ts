/**
 * verify(): checks a transaction plan, whether it came from Eden's API or was built locally, against the caller's own
 * request and independent on-chain reads, before anything is signed. Any mismatch throws VerificationError.
 *
 * For every step:
 *   - chainId is the configured chain (99901 on mainnet) and `from` is the requesting wallet;
 *   - `to` is a known Eden address: a deployment contract, the token's own curve as registered in the factory, or
 *     the token itself (approvals only);
 *   - calldata decodes with the bundled ABIs to the one function that step kind allows, canonically (re-encoding
 *     gives the same bytes; only Eden's 6-byte marker may follow);
 *   - recipient, user, amount and value match the request;
 *   - the minimum out equals the quote's minOut and is no lower than the SDK's own quote (curve math or pool state
 *     read from the chain) less the requested slippage;
 *   - the step is simulated with eth_call (steps that depend on an earlier approval are simulated right before
 *     signing, by the executor).
 */
import { getAddress, isAddressEqual, verifyTypedData, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { permitTyped } from "./pool.ts";
import { edenBondingCurveAbi, edenFeeEscrowAbi, edenLaunchAndBuyAbi, edenLaunchFactoryAbi, edenMemeHookAbi } from "./abi/eden.ts";
import { erc20Abi, permit2Abi } from "./abi/uniswap.ts";
import { checkSlippage, initialBuyQuote, localQuote } from "./build.ts";
import { decodeStrict, decodeV4Swap, type Decoded, type TokenParams } from "./calldata.ts";
import { poolIdOf, poolKeyFor, type EdenReader } from "./chain.ts";
import { EdenError, VerificationError } from "./errors.ts";
import { minOutFor } from "./slippage.ts";
import { IPFS_LOGO, validateLaunchMetadata } from "./metadata.ts";
import type { ClaimPlan, ClaimRequest, GraduatePlan, GraduateRequest, LaunchPlan, LaunchRequest, Quote, Step, SwapPlan, SwapRequest } from "./types.ts";

export type VerifyOptions = {
  /** eth_call each step that can run now (default true). */
  simulate?: boolean;
  /** Allow slippage above 50% (default false). */
  allowHighSlippage?: boolean;
  /** Longest pool-swap deadline accepted, in seconds from now (default 3600). */
  maxDeadlineSeconds?: number;
};

export type StepCheck = { index: number; kind: Step["kind"]; to: Address; call: string; simulated: boolean | "deferred"; notes: string[] };
export type Verified<P> = { plan: P; steps: StepCheck[]; ownQuote?: Quote };

const fail = (code: string, message: string, step = -1, details?: Record<string, unknown>): never => {
  throw new VerificationError(code, message, step, details);
};
const same = (a: string, b: string) => isAddressEqual(a as Address, b as Address);

function decodeOrFail(abi: readonly unknown[], data: Hex, allowed: readonly string[], i: number): Decoded {
  const d = decodeStrict(abi, data, allowed);
  if ("error" in d) return fail("calldata", d.error, i);
  return d;
}

function checkCommon(plan: { chainId: number; steps: Step[] }, reader: EdenReader, user: Address): void {
  if (plan.chainId !== reader.chainId) fail("chain_id", `plan is for chain ${plan.chainId}, expected ${reader.chainId}`);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail("no_steps", "the plan has no steps");
  plan.steps.forEach((s, i) => {
    if (s.tx.chainId !== reader.chainId) fail("chain_id", `chainId ${s.tx.chainId}, expected ${reader.chainId}`, i);
    if (!same(s.tx.from, user)) fail("from", `from ${s.tx.from}, expected the requesting wallet ${user}`, i);
    if (typeof s.tx.value !== "bigint" || s.tx.value < 0n) fail("value", "value is not a non-negative amount", i);
  });
}

async function simulateSteps(reader: EdenReader, steps: Step[], dependsOnEarlier: (i: number) => boolean, checks: StepCheck[], simulate: boolean): Promise<void> {
  if (!simulate) return;
  for (let i = 0; i < steps.length; i++) {
    if (dependsOnEarlier(i)) { checks[i]!.simulated = "deferred"; continue; }
    try {
      await reader.simulate(steps[i]!.tx);
      checks[i]!.simulated = true;
    } catch (e) {
      fail("simulation", (e as Error).message, i);
    }
  }
}

/* =============================================================== swaps */

export async function verifySwap(reader: EdenReader, plan: SwapPlan, request: SwapRequest, options: VerifyOptions = {}): Promise<Verified<SwapPlan>> {
  const user = getAddress(request.user), token = getAddress(request.token), recipient = getAddress(request.recipient ?? request.user);
  const slippageBps = checkSlippage(request.slippageBps, options.allowHighSlippage);
  if (request.amount <= 0n) fail("amount", "the request amount must be greater than zero");
  checkCommon(plan, reader, user);
  const d = reader.deployment;

  const own = await localQuote(reader, { token, side: request.side, amount: request.amount, slippageBps, recipient, user });
  if (plan.route !== own.quote.route) fail("route", `plan routes through the ${plan.route}, but the token trades on the ${own.quote.route}`);
  const q = plan.quote;
  if (!q) fail("quote", "the plan has no quote");
  if (!same(q.token, token)) fail("quote", `quote is for ${q.token}, not ${token}`);
  if (q.side !== request.side) fail("quote", `quote is a ${q.side}, the request a ${request.side}`);
  if (q.route !== own.quote.route) fail("route", `quote routes through the ${q.route}, the token trades on the ${own.quote.route}`);
  if (q.amountIn !== request.amount && q.amountIn !== own.quote.amountIn) fail("amount", `quote amountIn ${q.amountIn}, requested ${request.amount}`);

  const floor = minOutFor(own.quote.expectedOut, slippageBps);
  const checks: StepCheck[] = plan.steps.map((s, i) => ({ index: i, kind: s.kind, to: s.tx.to, call: "", simulated: false, notes: [] }));
  const swapIndex = plan.steps.length - 1;
  let minOutSeen: bigint | undefined;
  let sawApprove = false, sawPermit = false;

  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]!, c = checks[i]!;
    if (i < swapIndex) {
      if (s.kind === "approve") {
        if (sawApprove || sawPermit) fail("unexpected_step", "approve must come first and only once", i);
        sawApprove = true;
        if (!same(s.tx.to, token)) fail("to", `approve is sent to ${s.tx.to}, not the token ${token}`, i);
        const dec = decodeOrFail(erc20Abi, s.tx.data, ["approve"], i);
        const [spender, amount] = dec.args as [Address, bigint];
        const expected = own.quote.route === "curve" ? own.launch.curve : d.permit2;
        if (request.side !== "sell") fail("unexpected_step", "a buy needs no approval", i);
        if (!same(spender, expected)) fail("spender", `approves ${spender}; must be ${own.quote.route === "curve" ? "the token's curve" : "Permit2"} ${expected}`, i);
        if (amount < request.amount) fail("amount", `approves ${amount}, less than the ${request.amount} being sold`, i);
        if (s.tx.value !== 0n) fail("value", `approve carries ${s.tx.value} wei`, i);
        c.call = `approve(${spender}, ${amount})`;
      } else if (s.kind === "permit2-approve") {
        if (sawPermit) fail("unexpected_step", "only one permit2-approve", i);
        sawPermit = true;
        if (own.quote.route !== "pool" || request.side !== "sell") fail("unexpected_step", "permit2-approve only belongs to a pool sell", i);
        if (!same(s.tx.to, d.permit2)) fail("to", `permit2-approve is sent to ${s.tx.to}, not Permit2 ${d.permit2}`, i);
        const dec = decodeOrFail(permit2Abi, s.tx.data, ["approve"], i);
        const [t, spender, amount, expiration] = dec.args as [Address, Address, bigint, number];
        if (!same(t, token)) fail("token", `Permit2 approval is for ${t}, not ${token}`, i);
        if (!same(spender, d.universalRouter)) fail("spender", `Permit2 approval is for ${spender}, not the Universal Router ${d.universalRouter}`, i);
        if (amount < request.amount) fail("amount", `Permit2 approval of ${amount} is less than the ${request.amount} being sold`, i);
        if (BigInt(expiration) <= (await reader.blockTimestamp())) fail("expiration", "Permit2 approval is already expired", i);
        if (s.tx.value !== 0n) fail("value", `permit2-approve carries ${s.tx.value} wei`, i);
        c.call = `Permit2.approve(${t}, ${spender}, ${amount}, ${expiration})`;
      } else {
        fail("unexpected_step", `unexpected ${s.kind} step before the swap`, i);
      }
      continue;
    }

    if (s.kind !== "swap") fail("missing_step", `the last step is ${s.kind}, expected the swap`, i);
    if (own.quote.route === "curve") {
      if (!same(s.tx.to, own.launch.curve)) fail("to", `swap is sent to ${s.tx.to}, not the token's curve ${own.launch.curve} (as registered in the factory)`, i);
      const fn = request.side === "buy" ? "buy" : "sell";
      const dec = decodeOrFail(edenBondingCurveAbi, s.tx.data, [fn], i);
      const [amount, minOut, to] = dec.args as [bigint, bigint, Address];
      if (amount !== request.amount) fail("amount", `${fn} amount ${amount}, requested ${request.amount}`, i);
      if (!same(to, recipient)) fail("recipient", `${fn} pays ${to}, not ${recipient}`, i);
      const value = request.side === "buy" ? request.amount : 0n;
      if (s.tx.value !== value) fail("value", `value ${s.tx.value}, expected ${value}`, i);
      minOutSeen = minOut;
      c.call = `${fn}(${amount}, ${minOut}, ${to})`;
    } else {
      if (!same(s.tx.to, d.universalRouter)) fail("to", `swap is sent to ${s.tx.to}, not the Universal Router ${d.universalRouter}`, i);
      const v = decodeV4Swap(s.tx.data);
      if ("error" in v) return fail("calldata", v.error, i);
      const key = poolKeyFor(token, d);
      const k = v.poolKey;
      if (!same(k.currency0, key.currency0) || !same(k.currency1, key.currency1) || k.fee !== key.fee || k.tickSpacing !== key.tickSpacing || !same(k.hooks, key.hooks)) {
        fail("pool_key", `swaps in pool ${JSON.stringify(k)}, not the token's Eden pool`, i);
      }
      if (poolIdOf(k as never) !== own.pool!.poolId) fail("pool_key", "pool id mismatch", i);
      if (v.zeroForOne !== (request.side === "buy")) fail("direction", `swap direction is ${v.zeroForOne ? "HYPE→token" : "token→HYPE"}, the request is a ${request.side}`, i);
      if (v.amountIn !== request.amount) fail("amount", `swap amountIn ${v.amountIn}, requested ${request.amount}`, i);
      if (v.minHopPriceX36 !== 0n) fail("calldata", "minHopPriceX36 must be 0", i);
      if (v.permit) {
        if (request.side !== "sell") fail("calldata", "a buy carries no Permit2 permit", i);
        if (sawPermit) fail("unexpected_step", "a signed permit and a permit2-approve step together", i);
        if (!same(v.permit.details.token, token)) fail("token", `the permit is for ${v.permit.details.token}, not ${token}`, i);
        if (!same(v.permit.spender, d.universalRouter)) fail("spender", `the permit lets ${v.permit.spender} spend, not the Universal Router`, i);
        if (v.permit.details.amount < request.amount) fail("amount", `the permit allows ${v.permit.details.amount}, less than the ${request.amount} being sold`, i);
        const ok = await verifyTypedData({ address: user, ...permitTyped({ details: v.permit.details, spender: v.permit.spender, sigDeadline: v.permit.sigDeadline }, reader.chainId, d.permit2), signature: v.permit.signature });
        if (!ok) fail("permit", "the Permit2 signature is not the user's", i);
        c.notes.push(`signed Permit2 permit for ${v.permit.details.amount}, expires ${v.permit.details.expiration}`);
      }
      if (v.hookData !== "0x") fail("calldata", "hookData must be empty", i);
      const [cIn, cOut] = request.side === "buy" ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
      if (!same(v.settle.currency, cIn) || v.settle.maxAmount !== request.amount) fail("amount", `settles ${v.settle.maxAmount} of ${v.settle.currency}, expected ${request.amount} of ${cIn}`, i);
      if (!same(v.take.currency, cOut)) fail("calldata", `takes ${v.take.currency}, expected ${cOut}`, i);
      if (v.take.recipient === "sender") {
        if (!same(recipient, user)) fail("recipient", `the output goes to the sender ${user}, the request's recipient is ${recipient}`, i);
        if (v.take.amount !== v.amountOutMinimum) fail("min_out", `TAKE_ALL minimum ${v.take.amount} differs from the swap's ${v.amountOutMinimum}`, i);
      } else {
        if (!same(v.take.recipient, recipient)) fail("recipient", `the output goes to ${v.take.recipient}, not ${recipient}`, i);
        if (v.take.amount !== 0n) fail("calldata", "TAKE must take the whole output (amount 0)", i);
      }
      const now = await reader.blockTimestamp();
      const wall = BigInt(Math.floor(Date.now() / 1000));
      const latest = (now > wall ? now : wall) + BigInt(options.maxDeadlineSeconds ?? 3600);
      if (v.deadline <= now) fail("deadline", `deadline ${v.deadline} has passed (chain time ${now})`, i);
      if (v.deadline > latest) fail("deadline", `deadline ${v.deadline} is more than ${options.maxDeadlineSeconds ?? 3600}s away`, i);
      const value = request.side === "buy" ? request.amount : 0n;
      if (s.tx.value !== value) fail("value", `value ${s.tx.value}, expected ${value}`, i);
      minOutSeen = v.amountOutMinimum;
      c.call = `execute(V4_SWAP ${request.side} ${v.amountIn} min ${v.amountOutMinimum} → ${v.take.recipient === "sender" ? user : v.take.recipient}, deadline ${v.deadline})`;
    }
  }

  if (minOutSeen === undefined) return fail("missing_step", "no swap step");
  if (minOutSeen !== q.minOut) fail("min_out", `the swap's minimum out ${minOutSeen} is not the quote's minOut ${q.minOut}`, swapIndex);
  if (minOutSeen === 0n) fail("min_out", "the swap has no minimum out", swapIndex);
  if (minOutSeen < floor) {
    fail("slippage", `minimum out ${minOutSeen} is below ${floor}: the SDK's own quote ${own.quote.expectedOut} less ${slippageBps} bps`, swapIndex,
      { ownExpectedOut: own.quote.expectedOut.toString(), floor: floor.toString() });
  }
  checks[swapIndex]!.notes.push(`own quote ${own.quote.expectedOut}, floor ${floor}, minOut ${minOutSeen}`);
  await simulateSteps(reader, plan.steps, (i) => i > 0 && plan.steps.slice(0, i).some((x) => x.kind === "approve" || x.kind === "permit2-approve"), checks, options.simulate ?? true);
  return { plan, steps: checks, ownQuote: own.quote };
}

/* =============================================================== launches */

export async function verifyLaunch(reader: EdenReader, plan: LaunchPlan, request: LaunchRequest, options: VerifyOptions = {}): Promise<Verified<LaunchPlan>> {
  const user = getAddress(request.user);
  checkCommon(plan, reader, user);
  const d = reader.deployment;
  const meta = validateLaunchMetadata({ ...request, image: undefined, initialBuy: request.initialBuy });
  const initialBuy = request.initialBuy ?? 0n;
  if (initialBuy < 0n) fail("amount", "initialBuy must not be negative");
  const slippageBps = checkSlippage(request.slippageBps, options.allowHighSlippage);
  const feeRecipient = getAddress(request.creatorFeeRecipient ?? request.user);
  if (plan.steps.length !== 1) fail("unexpected_step", `a launch is one transaction, the plan has ${plan.steps.length}`);
  const s = plan.steps[0]!;
  if (s.kind !== "launch") fail("unexpected_step", `step kind ${s.kind}, expected launch`, 0);
  if (!IPFS_LOGO.test(plan.logo)) fail("logo", `logo "${plan.logo}" is not an ipfs:// CID`);
  if (request.logo && request.logo !== plan.logo) fail("logo", `plan logo ${plan.logo} is not the requested ${request.logo}`);

  let params: TokenParams, exemptions: readonly Address[];
  const notes: string[] = [];
  if (initialBuy > 0n) {
    if (!same(s.tx.to, d.launchAndBuy)) fail("to", `launch with an initial buy is sent to ${s.tx.to}, not EdenLaunchAndBuy ${d.launchAndBuy}`, 0);
    const dec = decodeOrFail(edenLaunchAndBuyAbi, s.tx.data, ["launchAndBuy"], 0);
    const [p, configId, pair, quoteIn, minTokensOut, to, ex] = dec.args as [TokenParams, bigint, Address, bigint, bigint, Address, Address[]];
    params = p; exemptions = ex;
    if (configId !== 0n) fail("calldata", `launch config ${configId}, expected 0`, 0);
    if (!same(pair, zeroAddress)) fail("calldata", `pair token ${pair}, expected HYPE (0x0)`, 0);
    if (quoteIn !== initialBuy) fail("amount", `initial buy ${quoteIn}, requested ${initialBuy}`, 0);
    if (!same(to, user)) fail("recipient", `initial buy tokens go to ${to}, not ${user}`, 0);
    const { expected, minOut } = await initialBuyQuote(reader, initialBuy, meta.creatorFeeBps, slippageBps);
    if (minTokensOut === 0n) fail("min_out", "the initial buy has no minimum out", 0);
    if (minTokensOut < minOut) fail("slippage", `initial buy minimum ${minTokensOut} is below ${minOut} (own quote ${expected} less ${slippageBps} bps)`, 0);
    if (minTokensOut > expected) fail("min_out", `initial buy minimum ${minTokensOut} is above the expected ${expected}; the launch would revert`, 0);
    notes.push(`initial buy: own quote ${expected}, minimum ${minTokensOut}`);
  } else {
    if (!same(s.tx.to, d.factory)) fail("to", `launch is sent to ${s.tx.to}, not the factory ${d.factory}`, 0);
    const dec = decodeOrFail(edenLaunchFactoryAbi, s.tx.data, ["launchToken"], 0);
    if (dec.item.inputs.length !== 4) fail("calldata", "use launchToken(params, configId, pairToken, snipeTaxExemptions)", 0);
    const [p, configId, pair, ex] = dec.args as [TokenParams, bigint, Address, Address[]];
    params = p; exemptions = ex;
    if (configId !== 0n) fail("calldata", `launch config ${configId}, expected 0`, 0);
    if (!same(pair, zeroAddress)) fail("calldata", `pair token ${pair}, expected HYPE (0x0)`, 0);
  }
  const mismatch = (field: string, got: unknown, want: unknown) => fail("metadata", `${field} is ${JSON.stringify(got)}, requested ${JSON.stringify(want)}`, 0);
  if (params.name !== meta.name) mismatch("name", params.name, meta.name);
  if (params.symbol !== meta.symbol) mismatch("symbol", params.symbol, meta.symbol);
  if (params.description !== meta.description) mismatch("description", params.description, meta.description);
  for (const k of ["twitter", "telegram", "discord", "website", "farcaster"] as const) {
    if (params.socials[k] !== meta.socials[k]) mismatch(`socials.${k}`, params.socials[k], meta.socials[k]);
  }
  if (params.logo !== plan.logo) mismatch("logo", params.logo, plan.logo);
  if (!same(params.creatorFeeRecipient, feeRecipient)) fail("recipient", `creator fees go to ${params.creatorFeeRecipient}, not ${feeRecipient}`, 0);
  if (Number(params.creatorTaxBps) !== meta.creatorFeeBps) mismatch("creatorTaxBps", Number(params.creatorTaxBps), meta.creatorFeeBps);
  if (params.buybackEnabled !== meta.buyback) mismatch("buybackEnabled", params.buybackEnabled, meta.buyback);
  if (params.expectedEconomics !== zeroHash) notes.push(`expectedEconomics ${params.expectedEconomics} (checked by the factory)`);
  const want = new Set(meta.bundleWallets.map((a) => a.toLowerCase()));
  const got = new Set(exemptions.map((a) => a.toLowerCase()));
  if (want.size !== got.size || [...want].some((a) => !got.has(a))) fail("metadata", `snipe-tax exemptions [${[...got].join(", ")}] differ from the requested bundle wallets`, 0);

  const fee = await reader.launchFee();
  if (s.tx.value !== fee + initialBuy) fail("value", `value ${s.tx.value}, expected the launch fee ${fee} + initial buy ${initialBuy}`, 0);

  const checks: StepCheck[] = [{ index: 0, kind: "launch", to: s.tx.to, call: initialBuy > 0n ? "launchAndBuy" : "launchToken", simulated: false, notes }];
  await simulateSteps(reader, plan.steps, () => false, checks, options.simulate ?? true);
  return { plan, steps: checks };
}

/* =============================================================== fee claims */

export async function verifyClaim(reader: EdenReader, plan: ClaimPlan, request: ClaimRequest, options: VerifyOptions = {}): Promise<Verified<ClaimPlan>> {
  const user = getAddress(request.user);
  if (plan.steps.length === 0) return { plan, steps: [] }; // nothing to claim
  checkCommon(plan, reader, user);
  const d = reader.deployment;
  const token = request.token ? getAddress(request.token) : undefined;
  let sawClaim = false;
  const checks: StepCheck[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]!;
    const c: StepCheck = { index: i, kind: s.kind, to: s.tx.to, call: "", simulated: false, notes: [] };
    checks.push(c);
    if (s.tx.value !== 0n) fail("value", `a claim step carries ${s.tx.value} wei`, i);
    if (s.kind === "sweep-fees") {
      if (sawClaim) fail("unexpected_step", "sweeps must come before claims", i);
      if (same(s.tx.to, d.memeHook)) {
        const dec = decodeOrFail(edenMemeHookAbi, s.tx.data, ["sweepPoolFees"], i);
        const [poolId, a, b] = dec.args as [Hex, bigint, bigint];
        if (a !== 0n || b !== 0n) fail("calldata", "sweepPoolFees must not convert or buy back (minimums 0)", i);
        const h = await reader.hookLaunch(poolId);
        if (!h.registered || poolIdOf(poolKeyFor(h.memecoin, d)) !== poolId) fail("to", `pool ${poolId} is not an Eden pool`, i);
        if (!same(h.creator, user)) fail("recipient", `pool ${poolId} belongs to creator ${h.creator}, not ${user}`, i);
        if (token && !same(h.memecoin, token)) fail("token", `sweeps ${h.memecoin}'s pool, not the requested token's`, i);
        c.call = `hook.sweepPoolFees(${poolId}, 0, 0)`;
      } else {
        // A curve: it must be the curve Eden's factory registered for its token, and the user its fee recipient.
        const dec = decodeOrFail(edenBondingCurveAbi, s.tx.data, ["sweepFees"], i);
        if ((dec.args[0] as bigint) !== 0n) fail("calldata", "sweepFees must not execute a buyback (minBuybackTokensOut 0)", i);
        let f: Awaited<ReturnType<EdenReader["curveFees"]>>;
        try { f = await reader.curveFees(s.tx.to); } catch { return fail("to", `sweep is sent to ${s.tx.to}, which is not an Eden curve`, i); }
        const launch = await reader.launch(f.token);
        if (!launch || !same(launch.curve, s.tx.to)) fail("to", `${s.tx.to} is not the curve Eden's factory registered for ${f.token}`, i);
        if (!same(f.deployer, user)) fail("recipient", `the curve's fees go to ${f.deployer}, not ${user}`, i);
        if (token && !same(f.token, token)) fail("token", `sweeps ${f.token}'s curve, not the requested token's`, i);
        c.call = `curve(${f.token}).sweepFees(0)`;
      }
    } else if (s.kind === "claim") {
      sawClaim = true;
      if (!same(s.tx.to, d.feeEscrow)) fail("to", `claim is sent to ${s.tx.to}, not the fee escrow ${d.feeEscrow}`, i);
      const dec = decodeOrFail(edenFeeEscrowAbi, s.tx.data, ["claim", "claimToken"], i);
      if (dec.item.inputs.length !== (dec.functionName === "claim" ? 0 : 1)) fail("calldata", "claim the whole balance: claim() or claimToken(token)", i);
      if (dec.functionName === "claimToken" && (!token || !same(dec.args[0] as Address, token))) fail("token", `claims token ${String(dec.args[0])}, not the requested token`, i);
      c.call = dec.functionName === "claim" ? "escrow.claim()" : `escrow.claimToken(${String(dec.args[0])})`;
    } else fail("unexpected_step", `unexpected ${s.kind} step in a claim`, i);
  }
  await simulateSteps(reader, plan.steps, (i) => plan.steps.slice(0, i).some((x) => x.kind === "sweep-fees"), checks, options.simulate ?? true);
  return { plan, steps: checks };
}

/* =============================================================== graduation */

export async function verifyGraduate(reader: EdenReader, plan: GraduatePlan, request: GraduateRequest, options: VerifyOptions = {}): Promise<Verified<GraduatePlan>> {
  const user = getAddress(request.user), token = getAddress(request.token);
  checkCommon(plan, reader, user);
  const checks: StepCheck[] = plan.steps.map((s, i) => {
    if (s.kind !== "graduate") fail("unexpected_step", `unexpected ${s.kind} step`, i);
    if (!same(s.tx.to, reader.deployment.factory)) fail("to", `sent to ${s.tx.to}, not the factory`, i);
    if (s.tx.value !== 0n) fail("value", `carries ${s.tx.value} wei`, i);
    const dec = decodeOrFail(edenLaunchFactoryAbi, s.tx.data, ["graduate", "createGraduatedPool"], i);
    if (!same(dec.args[0] as Address, token)) fail("token", `graduates ${String(dec.args[0])}, not ${token}`, i);
    return { index: i, kind: s.kind, to: s.tx.to, call: `${dec.functionName}(${token})`, simulated: false, notes: [] };
  });
  await simulateSteps(reader, plan.steps, (i) => i > 0, checks, options.simulate ?? true);
  return { plan, steps: checks };
}

export type VerifyAction =
  | { action: "swap"; plan: SwapPlan; request: SwapRequest }
  | { action: "launch"; plan: LaunchPlan; request: LaunchRequest }
  | { action: "claim"; plan: ClaimPlan; request: ClaimRequest }
  | { action: "graduate"; plan: GraduatePlan; request: GraduateRequest };

/** Verifies any plan against its request. Throws VerificationError on the first mismatch. */
export async function verify(reader: EdenReader, v: VerifyAction, options: VerifyOptions = {}): Promise<Verified<SwapPlan | LaunchPlan | ClaimPlan | GraduatePlan>> {
  switch (v.action) {
    case "swap": return verifySwap(reader, v.plan, v.request, options);
    case "launch": return verifyLaunch(reader, v.plan, v.request, options);
    case "claim": return verifyClaim(reader, v.plan, v.request, options);
    case "graduate": return verifyGraduate(reader, v.plan, v.request, options);
    default: throw new EdenError("invalid:action", `Unknown action ${(v as { action: string }).action}.`);
  }
}
