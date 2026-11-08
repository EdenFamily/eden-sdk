/**
 * Calldata for every Eden transaction, encoded and decoded with the bundled ABIs. Building and verification share
 * these functions, so what the SDK signs in local mode is exactly what verify() accepts.
 */
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, maxUint256, toFunctionSelector, zeroAddress,
  type Abi, type AbiFunction, type Address, type Hex,
} from "viem";
import { edenBondingCurveAbi, edenFeeEscrowAbi, edenLaunchAndBuyAbi, edenLaunchFactoryAbi, edenMemeHookAbi } from "./abi/eden.ts";
import { erc20Abi, exactInputSingleTuple, permit2Abi, universalRouterAbi } from "./abi/uniswap.ts";
import { EDEN_MARKER_PATTERN } from "./constants.ts";
import { swapCalldata, type Permit, type PoolKey } from "./pool.ts";

/* ---------- marker ---------- */

export function appendMarker(data: Hex, marker: string | false): Hex {
  if (!marker) return data;
  if (!/^[0-9a-f]{12}$/i.test(marker)) throw new Error(`Calldata marker must be 6 bytes of hex, got ${marker}.`);
  return `${data}${marker.toLowerCase()}` as Hex;
}

/** Splits an optional trailing Eden marker (4544454e + 2-byte version) off calldata. */
export function splitMarker(data: Hex): { call: Hex; marker?: string } {
  const lower = data.toLowerCase() as Hex;
  // A marker only counts when it sits past a whole number of 32-byte words after the selector.
  if (EDEN_MARKER_PATTERN.test(lower) && (lower.length - 2 - 8 - 12) % 64 === 0) {
    return { call: lower.slice(0, -12) as Hex, marker: lower.slice(-12) };
  }
  return { call: lower };
}

export type Decoded = { functionName: string; args: readonly unknown[]; item: AbiFunction; marker?: string };

/**
 * Decodes calldata against `abi`, allowing only `allowed` functions, and requires it to be canonical: re-encoding the
 * decoded arguments must give back exactly the same bytes (plus at most the Eden marker). Anything smuggled after
 * the arguments, or a non-standard encoding, is rejected.
 */
export function decodeStrict(abi: Abi | readonly unknown[], data: Hex, allowed: readonly string[]): Decoded | { error: string } {
  const { call, marker } = splitMarker(data);
  const selector = call.slice(0, 10);
  const item = (abi as readonly AbiFunction[]).find((x) => x.type === "function" && toFunctionSelector(x) === selector);
  if (!item) return { error: `selector ${selector} is not one of ${allowed.join(", ")}` };
  if (!allowed.includes(item.name)) return { error: `calls ${item.name}, expected ${allowed.join(" or ")}` };
  let args: readonly unknown[];
  try {
    args = (decodeFunctionData({ abi: [item], data: call }).args ?? []) as readonly unknown[];
  } catch (e) {
    return { error: `calldata does not decode as ${item.name}: ${(e as Error).message.split("\n")[0]}` };
  }
  const again = encodeFunctionData({ abi: [item], functionName: item.name, args } as never).toLowerCase();
  if (again !== call) return { error: `calldata for ${item.name} is not canonical (extra or malformed bytes)` };
  return { functionName: item.name, args, item, marker };
}

/* ---------- curve ---------- */

export const encodeCurveBuy = (quoteIn: bigint, minTokensOut: bigint, recipient: Address) =>
  encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [quoteIn, minTokensOut, recipient] });
export const encodeCurveSell = (tokensIn: bigint, minQuoteOut: bigint, recipient: Address) =>
  encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "sell", args: [tokensIn, minQuoteOut, recipient] });
export const encodeApprove = (spender: Address, amount: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
export const encodePermit2Approve = (token: Address, spender: Address, amount: bigint, expiration: number) =>
  encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, spender, amount, expiration] });

/* ---------- launch ---------- */

export type TokenParams = {
  name: string; symbol: string; logo: string; description: string;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string };
  creatorFeeRecipient: Address; creatorTaxBps: number; buybackEnabled: boolean; expectedEconomics: Hex; salt: Hex;
};

const LAUNCH_TOKEN_4 = (edenLaunchFactoryAbi as readonly AbiFunction[]).find((x) => x.type === "function" && x.name === "launchToken" && x.inputs.length === 4)!;

export const encodeLaunchToken = (params: TokenParams, exemptions: readonly Address[]) =>
  encodeFunctionData({ abi: [LAUNCH_TOKEN_4], functionName: "launchToken", args: [params, 0n, zeroAddress, exemptions] } as never) as Hex;
export const encodeLaunchAndBuy = (params: TokenParams, quoteIn: bigint, minTokensOut: bigint, recipient: Address, exemptions: readonly Address[]) =>
  encodeFunctionData({ abi: edenLaunchAndBuyAbi, functionName: "launchAndBuy", args: [params, 0n, zeroAddress, quoteIn, minTokensOut, recipient, exemptions] });

/* ---------- fees and graduation ---------- */

const CLAIM_0 = (edenFeeEscrowAbi as readonly AbiFunction[]).find((x) => x.type === "function" && x.name === "claim" && x.inputs.length === 0)!;
const CLAIM_TOKEN_1 = (edenFeeEscrowAbi as readonly AbiFunction[]).find((x) => x.type === "function" && x.name === "claimToken" && x.inputs.length === 1)!;
export const encodeClaim = () => encodeFunctionData({ abi: [CLAIM_0], functionName: "claim" } as never) as Hex;
export const encodeClaimToken = (token: Address) => encodeFunctionData({ abi: [CLAIM_TOKEN_1], functionName: "claimToken", args: [token] } as never) as Hex;
export const encodeCurveSweep = () => encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "sweepFees", args: [0n] });
export const encodePoolSweep = (poolId: Hex) => encodeFunctionData({ abi: edenMemeHookAbi, functionName: "sweepPoolFees", args: [poolId, 0n, 0n] });
export const encodeGraduate = (token: Address) => encodeFunctionData({ abi: edenLaunchFactoryAbi, functionName: "graduate", args: [token] });
export const encodeCreatePool = (token: Address) => encodeFunctionData({ abi: edenLaunchFactoryAbi, functionName: "createGraduatedPool", args: [token] });

/* ---------- Universal Router V4_SWAP ---------- */

const addrAmount = [{ type: "address" }, { type: "uint256" }] as const;
const takeParams = [{ type: "address" }, { type: "address" }, { type: "uint256" }] as const;

/** execute(V4_SWAP), the website's swapCalldata: TAKE_ALL to the sender, or TAKE to `recipient` when it is another wallet. */
export function encodeV4Swap(key: PoolKey, side: "buy" | "sell", amountIn: bigint, minOut: bigint, deadline: bigint, recipient?: Address,
  permit?: { permit: Permit; signature: Hex }): Hex {
  return swapCalldata(key, side, amountIn, minOut, deadline, permit, recipient);
}

export type DecodedV4Swap = {
  deadline: bigint;
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  minHopPriceX36: bigint;
  hookData: Hex;
  settle: { currency: Address; maxAmount: bigint };
  take: { currency: Address; recipient: "sender" | Address; amount: bigint };
  /** Present when the call starts with PERMIT2_PERMIT (commands 0x0a10), the website's signed-permit sell. */
  permit?: { details: { token: Address; amount: bigint; expiration: number; nonce: number }; spender: Address; sigDeadline: bigint; signature: Hex };
};

const permitSingleTuple = { type: "tuple", components: [
  { name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
  { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] } as const;

/** Decodes and strictly checks the shape of an Eden V4 swap (one V4_SWAP command, the three actions above). */
export function decodeV4Swap(data: Hex): DecodedV4Swap | { error: string } {
  const d = decodeStrict(universalRouterAbi as unknown as Abi, data, ["execute"]);
  if ("error" in d) return d;
  const [commands, inputs, deadline] = d.args as [Hex, Hex[], bigint];
  const withPermit = commands.toLowerCase() === "0x0a10";
  if (commands.toLowerCase() !== "0x10" && !withPermit) return { error: `router commands are ${commands}, expected V4_SWAP (0x10) or PERMIT2_PERMIT + V4_SWAP (0x0a10)` };
  if (inputs.length !== (withPermit ? 2 : 1)) return { error: `router has ${inputs.length} inputs, expected ${withPermit ? 2 : 1}` };
  try {
    let permit: DecodedV4Swap["permit"];
    if (withPermit) {
      const [p, signature] = decodeAbiParameters([permitSingleTuple, { type: "bytes" }], inputs[0]!);
      if (encodeAbiParameters([permitSingleTuple, { type: "bytes" }], [p, signature]).toLowerCase() !== inputs[0]!.toLowerCase()) return { error: "permit input is not canonical" };
      permit = { details: { token: p.details.token, amount: p.details.amount, expiration: Number(p.details.expiration), nonce: Number(p.details.nonce) }, spender: p.spender, sigDeadline: p.sigDeadline, signature };
    }
    const swapInput = inputs[inputs.length - 1]!;
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], swapInput) as [Hex, Hex[]];
    const takeAll = actions.toLowerCase() === "0x060c0f", takeTo = actions.toLowerCase() === "0x060c0e";
    if (!takeAll && !takeTo) return { error: `v4 actions are ${actions}, expected SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL/TAKE` };
    if (params.length !== 3) return { error: `v4 actions carry ${params.length} params, expected 3` };
    const [swap] = decodeAbiParameters([exactInputSingleTuple], params[0]!);
    if (encodeAbiParameters([exactInputSingleTuple], [swap]).toLowerCase() !== params[0]!.toLowerCase()) return { error: "swap params are not canonical" };
    const [sc, sa] = decodeAbiParameters(addrAmount, params[1]!);
    if (encodeAbiParameters(addrAmount, [sc, sa]).toLowerCase() !== params[1]!.toLowerCase()) return { error: "settle params are not canonical" };
    let take: DecodedV4Swap["take"];
    if (takeAll) {
      const [tc, ta] = decodeAbiParameters(addrAmount, params[2]!);
      if (encodeAbiParameters(addrAmount, [tc, ta]).toLowerCase() !== params[2]!.toLowerCase()) return { error: "take params are not canonical" };
      take = { currency: tc, recipient: "sender", amount: ta };
    } else {
      const [tc, tr, ta] = decodeAbiParameters(takeParams, params[2]!);
      if (encodeAbiParameters(takeParams, [tc, tr, ta]).toLowerCase() !== params[2]!.toLowerCase()) return { error: "take params are not canonical" };
      take = { currency: tc, recipient: tr, amount: ta };
    }
    const reencoded = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]).toLowerCase();
    if (reencoded !== swapInput.toLowerCase()) return { error: "router input is not canonical" };
    return { permit, deadline, poolKey: swap.poolKey as PoolKey, zeroForOne: swap.zeroForOne, amountIn: swap.amountIn, amountOutMinimum: swap.amountOutMinimum,
      minHopPriceX36: swap.minHopPriceX36, hookData: swap.hookData, settle: { currency: sc, maxAmount: sa }, take };
  } catch (e) {
    return { error: `router input does not decode: ${(e as Error).message.split("\n")[0]}` };
  }
}

export const MAX_UINT256 = maxUint256;
export const MAX_UINT160 = (1n << 160n) - 1n;
