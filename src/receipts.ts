/** Decodes Eden's events from receipts into the amounts that actually moved. */
import { decodeEventLog, getAddress, isAddressEqual, type Abi, type Address, type Hex, type Log, type TransactionReceipt } from "viem";
import { edenBondingCurveAbi, edenFeeEscrowAbi, edenLaunchAndBuyAbi, edenLaunchFactoryAbi, edenMemeHookAbi } from "./abi/eden.ts";
import { erc20Abi, poolManagerAbi } from "./abi/uniswap.ts";
import type { Deployment } from "./deployment.ts";
import { TransactionError } from "./errors.ts";

export type DecodedEvent = { address: Address; eventName: string; args: Record<string, any>; logIndex: number };

/** Every log in the receipt that decodes with `abi`, from `address` if given. */
export function eventsOf(receipt: TransactionReceipt, abi: Abi | readonly unknown[], address?: Address): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const log of receipt.logs as Log[]) {
    if (address && !isAddressEqual(log.address, address)) continue;
    try {
      const d = decodeEventLog({ abi: abi as Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({ address: getAddress(log.address), eventName: String(d.eventName), args: d.args as Record<string, any>, logIndex: log.logIndex ?? 0 });
    } catch { /* not this ABI */ }
  }
  return out;
}

const need = <T>(v: T | undefined, receipt: TransactionReceipt, what: string): T => {
  if (v === undefined) throw new TransactionError("missing_event", `Transaction ${receipt.transactionHash} succeeded but has no ${what} event.`, receipt.transactionHash);
  return v;
};

export function curveTrade(receipt: TransactionReceipt, curve: Address, side: "buy" | "sell") {
  const e = need(eventsOf(receipt, edenBondingCurveAbi, curve).find((x) => x.eventName === (side === "buy" ? "CurveBuy" : "CurveSell")), receipt, side === "buy" ? "CurveBuy" : "CurveSell");
  const graduated = eventsOf(receipt, edenLaunchFactoryAbi).some((x) => x.eventName === "LaunchSwept");
  return side === "buy"
    ? { amountIn: e.args.quoteIn as bigint, amountOut: e.args.tokensOut as bigint, fee: e.args.fee as bigint, tax: e.args.tax as bigint, recipient: e.args.recipient as Address, graduated }
    : { amountIn: e.args.tokensIn as bigint, amountOut: e.args.quoteOut as bigint, fee: e.args.fee as bigint, tax: e.args.tax as bigint, recipient: e.args.recipient as Address, graduated };
}

/**
 * A pool swap: PoolManager's Swap (amounts from the swapper's side, before the hook) and the hook's HookFeeCollected
 * (fee and tax taken from the output). What the trader receives is the pool output less fee and tax; for a buy it is
 * also checked against the token's Transfer to the recipient.
 */
export function poolTrade(receipt: TransactionReceipt, d: Deployment, poolId: Hex, token: Address, side: "buy" | "sell", recipient: Address) {
  const swap = need(eventsOf(receipt, poolManagerAbi, d.poolManager).find((x) => x.eventName === "Swap" && x.args.id === poolId), receipt, "PoolManager Swap");
  const fee = eventsOf(receipt, edenMemeHookAbi, d.memeHook).find((x) => x.eventName === "HookFeeCollected" && x.args.poolId === poolId);
  const a0 = swap.args.amount0 as bigint, a1 = swap.args.amount1 as bigint;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const feeAmount = (fee?.args.feeAmount as bigint | undefined) ?? 0n, taxAmount = (fee?.args.taxAmount as bigint | undefined) ?? 0n;
  const amountIn = side === "buy" ? abs(a0) : abs(a1);
  const grossOut = side === "buy" ? abs(a1) : abs(a0);
  const amountOut = grossOut - feeAmount - taxAmount;
  if (side === "buy") {
    const received = eventsOf(receipt, erc20Abi, token).filter((x) => x.eventName === "Transfer" && isAddressEqual(x.args.to, recipient))
      .reduce((n, x) => n + (x.args.value as bigint), 0n);
    if (received !== amountOut) {
      throw new TransactionError("amount_mismatch", `Pool buy: the hook-adjusted output ${amountOut} differs from the ${received} tokens transferred to ${recipient}.`, receipt.transactionHash);
    }
  }
  return { amountIn, amountOut, fee: feeAmount, tax: taxAmount, feeCurrency: (fee ? (isAddressEqual(fee.args.currency, token) ? token : "HYPE") : (side === "buy" ? token : "HYPE")) as "HYPE" | Address };
}

export function launchEvents(receipt: TransactionReceipt, d: Deployment) {
  const launched = need(eventsOf(receipt, edenLaunchFactoryAbi, d.factory).find((x) => x.eventName === "TokenLaunched"), receipt, "TokenLaunched");
  const token = getAddress(launched.args.token), curve = getAddress(launched.args.curve);
  const buy = eventsOf(receipt, edenBondingCurveAbi, curve).find((x) => x.eventName === "CurveBuy");
  const router = eventsOf(receipt, edenLaunchAndBuyAbi, d.launchAndBuy).find((x) => x.eventName === "Launched");
  return { token, curve, deployer: getAddress(launched.args.deployer), initialBuy: buy ? { quoteIn: buy.args.quoteIn as bigint, tokensOut: buy.args.tokensOut as bigint, fee: buy.args.fee as bigint, tax: buy.args.tax as bigint } : undefined, routerEvent: router };
}

export function claimEvents(receipts: TransactionReceipt[], d: Deployment, user: Address) {
  let claimed = 0n, swept = 0n;
  const tokens: Array<{ token: Address; amount: bigint }> = [];
  for (const r of receipts) {
    for (const e of eventsOf(r, edenFeeEscrowAbi, d.feeEscrow)) {
      if (e.eventName === "Claimed" && isAddressEqual(e.args.recipient, user)) claimed += e.args.amount as bigint;
      if (e.eventName === "ClaimedToken" && isAddressEqual(e.args.recipient, user)) tokens.push({ token: getAddress(e.args.token), amount: e.args.amount as bigint });
      if (e.eventName === "Credited" && isAddressEqual(e.args.recipient, user)) swept += e.args.amount as bigint;
    }
  }
  return { claimed, claimedTokens: tokens, swept };
}

export function graduationEvents(receipts: TransactionReceipt[], d: Deployment) {
  for (const r of receipts) {
    const g = eventsOf(r, edenLaunchFactoryAbi, d.factory).find((x) => x.eventName === "PoolGraduated");
    if (g) return { positionId: g.args.positionId as bigint };
  }
  return {};
}
