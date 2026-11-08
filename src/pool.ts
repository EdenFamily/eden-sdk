/**
 * Graduated tokens trade in their Uniswap V4 pool: native HYPE (currency0) against the token, fee 0, tick spacing 200,
 * Eden's hook. The hook takes its fee and the creator tax from the swap's output (afterSwapReturnDelta). Trades go
 * through the Universal Router.
 *
 * Ported from the website (eden-web/src/lib/pool.ts) with the same names and shapes. Differences: the hook's fee and
 * tax are floored separately, exactly as EdenMemeHook does, so quotes equal fills to the wei; swapCalldata can pay a
 * recipient other than the sender; sells may use Permit2's on-chain approve instead of a signed permit.
 */
import {
  encodeAbiParameters, encodeFunctionData, encodePacked, hexToBigInt, keccak256, maxUint160, parseAbi, toFunctionSelector, zeroAddress,
  type Address, type Hex, type PublicClient,
} from "viem";
import { edenMemeHookAbi } from "./abi/eden.ts";
import { exactInputSingleTuple, poolKeyTuple, poolManagerAbi, universalRouterAbi } from "./abi/uniswap.ts";
import { MAINNET, POOL_FEE, POOL_TICK_SPACING } from "./deployment.ts";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type PoolState = { sqrtPriceX96: bigint; liquidity: bigint; hookFeeBps: number; creatorTaxBps: number };

export type PoolQuote = {
  out: bigint;
  impactBps: number;
  /** Pool output before the hook's cut. */
  gross: bigint;
  fee: bigint;
  tax: bigint;
  sqrtPriceAfter: bigint;
  /** Wei of HYPE per whole token, before and after. */
  priceBefore: bigint;
  priceAfter: bigint;
};

const Q96 = 1n << 96n;
const POOLS_SLOT = 6n, LIQUIDITY_OFFSET = 3n;
const BPS = 10_000n;

export const poolKey = (token: Address, hooks: Address = MAINNET.memeHook): PoolKey =>
  ({ currency0: zeroAddress, currency1: token, fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks });
export const poolId = (key: PoolKey): Hex => keccak256(encodeAbiParameters([poolKeyTuple], [key]));

const slot = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** Price, liquidity (PoolManager storage, as v4's StateLibrary reads it) and the hook's fee and tax for one pool. */
export async function readPool(client: PublicClient, id: Hex, contracts: { poolManager: Address; memeHook: Address } = MAINNET, blockNumber?: bigint)
  : Promise<PoolState & { registered: boolean; creator: Address }> {
  const state = hexToBigInt(keccak256(encodePacked(["bytes32", "bytes32"], [id, slot(POOLS_SLOT)])));
  const bn = blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const [slot0, liq, info] = await Promise.all([
    client.readContract({ address: contracts.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot(state)], blockNumber: bn }),
    client.readContract({ address: contracts.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot(state + LIQUIDITY_OFFSET)], blockNumber: bn }),
    client.readContract({ address: contracts.memeHook, abi: edenMemeHookAbi, functionName: "launches", args: [id], blockNumber: bn }) as Promise<readonly any[]>,
  ]);
  return { sqrtPriceX96: hexToBigInt(slot0 as Hex) & ((1n << 160n) - 1n), liquidity: hexToBigInt(liq as Hex) & ((1n << 128n) - 1n),
    hookFeeBps: Number(info[10]), creatorTaxBps: Number(info[7]), registered: Boolean(info[0]), creator: info[4] as Address };
}

/** HYPE (wei) per whole token at a pool price: sqrtP² = token / HYPE. */
export function poolPrice(sqrtPriceX96: bigint): bigint {
  return sqrtPriceX96 === 0n ? 0n : ((1n << 192n) * 10n ** 18n) / (sqrtPriceX96 * sqrtPriceX96);
}
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Exact-input quote on the pool's full-range liquidity (v4's SqrtPriceMath, fee tier 0), less the hook's cut of the
 * output. `buy` = HYPE in, token out.
 */
export function quotePool(s: PoolState, side: "buy" | "sell", amountIn: bigint): PoolQuote {
  const L = s.liquidity, P = s.sqrtPriceX96;
  if (L === 0n || P === 0n || amountIn <= 0n) return { out: 0n, impactBps: 0, gross: 0n, fee: 0n, tax: 0n, sqrtPriceAfter: P, priceBefore: poolPrice(P), priceAfter: poolPrice(P) };
  let gross: bigint, spotOut: number, next: bigint;
  if (side === "buy") {
    next = ceilDiv(L * Q96 * P, L * Q96 + amountIn * P);
    gross = (L * (P - next)) / Q96;
    spotOut = Number(amountIn) * Number(P) ** 2 / 2 ** 192;
  } else {
    next = P + (amountIn * Q96) / L;
    gross = ((L * Q96 * (next - P)) / next) / P;
    spotOut = Number(amountIn) * 2 ** 192 / Number(P) ** 2;
  }
  const fee = (gross * BigInt(s.hookFeeBps)) / BPS, tax = (gross * BigInt(s.creatorTaxBps)) / BPS;
  return { out: gross - fee - tax, impactBps: Math.max(0, Math.round((1 - Number(gross) / spotOut) * 10_000)), gross, fee, tax, sqrtPriceAfter: next,
    priceBefore: poolPrice(P), priceAfter: poolPrice(next) };
}

/* ---------- Universal Router calldata ---------- */

const V4_SWAP = "10", PERMIT2_PERMIT = "0a";
const ACTIONS_TAKE_ALL = "0x060c0f" as const; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
const ACTIONS_TAKE = "0x060c0e" as const; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE (to a recipient)
const permitSingle = { type: "tuple", components: [
  { name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
  { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] } as const;

export type Permit = { details: { token: Address; amount: bigint; expiration: number; nonce: number }; spender: Address; sigDeadline: bigint };

/**
 * execute(V4_SWAP) for an exact-input single-pool swap, optionally preceded by PERMIT2_PERMIT. With `recipient`, the
 * output goes there through TAKE (amount 0 = all of it); the swap's own amountOutMinimum still enforces minOut.
 */
export function swapCalldata(key: PoolKey, side: "buy" | "sell", amountIn: bigint, minOut: bigint, deadline: bigint,
  permit?: { permit: Permit; signature: Hex }, recipient?: Address): Hex {
  const zeroForOne = side === "buy";
  const [cIn, cOut] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
  const params = [
    encodeAbiParameters([exactInputSingleTuple], [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [cIn, amountIn]),
    recipient
      ? encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [cOut, recipient, 0n])
      : encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [cOut, minOut]),
  ];
  const swap = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [recipient ? ACTIONS_TAKE : ACTIONS_TAKE_ALL, params]);
  const commands: Hex = `0x${permit ? PERMIT2_PERMIT : ""}${V4_SWAP}`;
  const inputs = permit ? [encodeAbiParameters([permitSingle, { type: "bytes" }], [permit.permit, permit.signature]), swap] : [swap];
  return encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline] });
}

/** Router deadline: 10 minutes from the later of the chain's last block and the local clock (as the website does). */
export async function swapDeadline(client: PublicClient, seconds = 600): Promise<bigint> {
  const last = (await client.getBlock({ blockTag: "latest" })).timestamp, now = BigInt(Math.floor(Date.now() / 1000));
  return (last > now ? last : now) + BigInt(seconds);
}

/* ---------- Permit2 ---------- */

export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** The EIP-712 permit that lets the router spend the token through Permit2 (website flow). */
export function permitTyped(permit: Permit, chainId: number, permit2: Address = MAINNET.permit2) {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: permit2 },
    types: {
      PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
      PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
    },
    primaryType: "PermitSingle" as const,
    message: permit,
  };
}
export const PERMIT_AMOUNT = maxUint160;
export const PERMIT_SECONDS = 365 * 24 * 3600;

/** Reverts that mean "the price moved past your slippage": nothing was traded. */
export const SLIPPAGE_SELECTORS = ["V4TooLittleReceived(uint256,uint256)", "SlippageExceeded(uint256,uint256)", "InsufficientOutputAmount()"].map((s) => toFunctionSelector(s));
