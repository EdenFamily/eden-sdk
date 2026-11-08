/** On-chain reads: everything local mode and verify() need, straight from Elysium, trusting no server. */
import {
  BaseError, ContractFunctionRevertedError, decodeErrorResult, zeroAddress,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { edenBondingCurveAbi, edenFeeEscrowAbi, edenLaunchAndBuyAbi, edenLaunchFactoryAbi, edenMemeHookAbi } from "./abi/eden.ts";
import { erc20Abi, permit2Abi, universalRouterAbi } from "./abi/uniswap.ts";
import type { Deployment } from "./deployment.ts";
import { EdenError } from "./errors.ts";
import { readCurve, type CurveState } from "./curve.ts";
import { poolId, poolKey, readPool, type PoolKey, type PoolState } from "./pool.ts";
import type { TxRequest } from "./types.ts";

export type Phase = "curve" | "swept" | "pool" | "rescued";
const PHASES: Phase[] = ["curve", "swept", "pool", "rescued"];

export type LaunchInfo = {
  token: Address;
  curve: Address;
  /** The launching wallet. */
  deployer: Address;
  creatorFeeRecipient: Address;
  pairToken: Address;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: Phase;
  graduationThreshold: bigint;
};

export type { PoolKey };
export type PoolInfo = PoolState & { poolId: Hex; key: PoolKey; registered: boolean; creator: Address };
export type LaunchConfig = { supply: bigint; curveFeeBps: bigint; phantomQuote: bigint; graduationThreshold: bigint; enabled: boolean };

/** The reads verify() and the local builders depend on. createReader() implements it over a viem PublicClient. */
export interface EdenReader {
  readonly chainId: number;
  readonly deployment: Deployment;
  blockTimestamp(): Promise<bigint>;
  launch(token: Address): Promise<LaunchInfo | null>;
  curveState(curve: Address, recipient: Address): Promise<CurveState>;
  pool(token: Address): Promise<PoolInfo>;
  launchFee(): Promise<bigint>;
  launchConfig(id: bigint): Promise<LaunchConfig>;
  maxCreatorTaxBps(): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  permit2Allowance(owner: Address, token: Address, spender: Address): Promise<{ amount: bigint; expiration: bigint; nonce: bigint }>;
  escrowBalance(user: Address): Promise<bigint>;
  escrowTokenBalance(user: Address, token: Address): Promise<bigint>;
  curveFees(curve: Address): Promise<{ token: Address; deployer: Address; quoteFeeBalance: bigint; creatorTaxBalance: bigint; buybackQuoteBalance: bigint; protocolFeeShareBps: number; graduated: boolean }>;
  poolFees(token: Address): Promise<{ quote: bigint; tax: bigint; memecoin: bigint; buyback: bigint; protocolFeeShareBps: number }>;
  /** The hook's record of a pool: registered, the memecoin it trades, and its creator. */
  hookLaunch(poolId: Hex): Promise<{ registered: boolean; memecoin: Address; creator: Address }>;
  balance(owner: Address, token?: Address): Promise<bigint>;
  /** eth_call the transaction; throws EdenError("simulation") with the decoded revert. */
  simulate(tx: TxRequest): Promise<void>;
}

export const poolKeyFor = (token: Address, deployment: Deployment): PoolKey => poolKey(token, deployment.memeHook);
export const poolIdOf = (key: PoolKey): Hex => poolId(key);


/** Every ABI a revert from an Eden transaction may come from, to name the error. */
const REVERT_ABIS = [edenBondingCurveAbi, edenLaunchFactoryAbi, edenLaunchAndBuyAbi, edenFeeEscrowAbi, edenMemeHookAbi, universalRouterAbi] as unknown as Abi[];

export function describeRevert(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted?.data?.errorName) return `${reverted.data.errorName}(${(reverted.data.args ?? []).map(String).join(", ")})`;
    const withData = error.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
    const data = withData?.data;
    if (data && data.length >= 10) {
      for (const abi of REVERT_ABIS) {
        try {
          const d = decodeErrorResult({ abi, data });
          return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
        } catch { /* next */ }
      }
      return `revert ${data.slice(0, 10)}`;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createReader(client: PublicClient, deployment: Deployment): EdenReader {
  const d = deployment;
  const read = <T>(args: Parameters<PublicClient["readContract"]>[0]) => client.readContract(args) as Promise<T>;
  return {
    chainId: d.chainId,
    deployment: d,
    async blockTimestamp() { return (await client.getBlock({ blockTag: "latest" })).timestamp; },

    async launch(token) {
      const r = await read<{ token: Address; curve: Address; deployer: Address; creatorFeeRecipient: Address; pairToken: Address; graduationThreshold: bigint;
        creatorTaxBps: number; buybackEnabled: boolean; phase: number; exists: boolean }>({ address: d.factory, abi: edenLaunchFactoryAbi, functionName: "getLaunchedToken", args: [token] });
      if (!r.exists) return null;
      return { token: r.token, curve: r.curve, deployer: r.deployer, creatorFeeRecipient: r.creatorFeeRecipient, pairToken: r.pairToken,
        creatorTaxBps: Number(r.creatorTaxBps), buybackEnabled: r.buybackEnabled, phase: PHASES[r.phase] ?? "rescued", graduationThreshold: r.graduationThreshold };
    },

    curveState: (curve, recipient) => readCurve(client, curve, recipient),

    async pool(token) {
      const key = poolKeyFor(token, d);
      const id = poolIdOf(key);
      return { poolId: id, key, ...(await readPool(client, id, d)) };
    },

    launchFee: () => read<bigint>({ address: d.factory, abi: edenLaunchFactoryAbi, functionName: "launchFee" }),
    async launchConfig(id) {
      const r = await read<{ supply: bigint; curveFeeBps: bigint; phantomQuote: bigint; graduationThreshold: bigint; enabled: boolean }>(
        { address: d.factory, abi: edenLaunchFactoryAbi, functionName: "getLaunchConfig", args: [id] });
      return { supply: r.supply, curveFeeBps: r.curveFeeBps, phantomQuote: r.phantomQuote, graduationThreshold: r.graduationThreshold, enabled: r.enabled };
    },
    maxCreatorTaxBps: () => read<bigint>({ address: d.factory, abi: edenLaunchFactoryAbi, functionName: "maxCreatorTaxBps" }),
    allowance: (token, owner, spender) => read<bigint>({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }),
    async permit2Allowance(owner, token, spender) {
      const [amount, expiration, nonce] = await read<readonly [bigint, number, number]>({ address: d.permit2, abi: permit2Abi, functionName: "allowance", args: [owner, token, spender] });
      return { amount, expiration: BigInt(expiration), nonce: BigInt(nonce) };
    },
    escrowBalance: (user) => read<bigint>({ address: d.feeEscrow, abi: edenFeeEscrowAbi, functionName: "balanceOf", args: [user] }),
    escrowTokenBalance: (user, token) => read<bigint>({ address: d.feeEscrow, abi: edenFeeEscrowAbi, functionName: "balanceOfToken", args: [user, token] }),
    async curveFees(curve) {
      const c = (functionName: string) => read<any>({ address: curve, abi: edenBondingCurveAbi, functionName: functionName as any });
      const [token, deployer, quoteFeeBalance, creatorTaxBalance, buybackQuoteBalance, share, graduated] = await Promise.all([
        c("token"), c("deployer"), c("quoteFeeBalance"), c("creatorTaxBalance"), c("buybackQuoteBalance"), c("protocolFeeShareBps"), c("graduated")]);
      return { token, deployer, quoteFeeBalance, creatorTaxBalance, buybackQuoteBalance, protocolFeeShareBps: Number(share), graduated };
    },
    async poolFees(token) {
      const poolId = poolIdOf(poolKeyFor(token, d));
      const h = (functionName: "pendingFees" | "pendingCreatorTax" | "pendingBuyback", currency: Address) =>
        read<bigint>({ address: d.memeHook, abi: edenMemeHookAbi, functionName, args: [poolId, currency] });
      const [quote, tax, memeFee, memeTax, buyback, info] = await Promise.all([h("pendingFees", zeroAddress), h("pendingCreatorTax", zeroAddress),
        h("pendingFees", token), h("pendingCreatorTax", token), h("pendingBuyback", zeroAddress),
        read<readonly any[]>({ address: d.memeHook, abi: edenMemeHookAbi, functionName: "launches", args: [poolId] })]);
      return { quote, tax, memecoin: memeFee + memeTax, buyback, protocolFeeShareBps: Number(info[8]) };
    },
    async hookLaunch(poolId) {
      const info = await read<readonly any[]>({ address: d.memeHook, abi: edenMemeHookAbi, functionName: "launches", args: [poolId] });
      return { registered: Boolean(info[0]), memecoin: info[2] as Address, creator: info[4] as Address };
    },
    balance: (owner, token) => (token ? read<bigint>({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }) : client.getBalance({ address: owner })),
    async simulate(tx) {
      try {
        await client.call({ account: tx.from, to: tx.to, data: tx.data, value: tx.value });
      } catch (error) {
        throw new EdenError("simulation", `Simulating the transaction to ${tx.to} failed: ${describeRevert(error)}`, { to: tx.to }, { cause: error });
      }
    },
  };
}
