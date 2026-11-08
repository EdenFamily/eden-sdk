/**
 * Eden's contracts on Elysium. Ported from the website (eden-web/src/lib/deployment.ts) with the same names, plus a
 * typed Deployment (every address the SDK talks to) and a loader for other chains (a local fork, a testnet).
 */
import { defineChain, getAddress, type Address, type Chain } from "viem";
import { DEFAULT_RPC_URL, ELYSIUM_CHAIN_ID } from "./constants.ts";

/** Pool shape of every graduated Eden token: native HYPE is currency0, LP fee 0, tick spacing 200, Eden's hook. */
export const POOL_FEE = 0;
export const POOL_TICK_SPACING = 200;

export type Deployment = Readonly<{
  chainId: number;
  factory: Address;
  launchAndBuy: Address;
  feeEscrow: Address;
  memeHook: Address;
  locker: Address;
  buybackVault: Address;
  graduationExecutor: Address;
  graduationGuard: Address;
  launchDeployer: Address;
  poolManager: Address;
  positionManager: Address;
  permit2: Address;
  /** Uniswap Universal Router (v2.2.0) that graduated tokens trade through. */
  universalRouter: Address;
  startBlock?: number;
}>;

/**
 * Eden on Elysium mainnet, from the production deployment record (elysium-launchpad/records/mainnet-deployment.json,
 * identical to eden-contracts/deployments/elysium-mainnet.json).
 */
export const MAINNET: Deployment = Object.freeze({
  chainId: ELYSIUM_CHAIN_ID,
  factory: getAddress("0x7260894d5f782844a60ec3689c001cd8ac65f4b1"),
  launchAndBuy: getAddress("0x50f7cd75af1e8f98649e5fa12ecddc3a4f240f4c"),
  feeEscrow: getAddress("0xc66b848a79676b39c0e51f3d6e43596beab868e9"),
  memeHook: getAddress("0x6132342bDdd14e6A0d1cbCAA3a7b6299AC2D2044"),
  locker: getAddress("0x9baa4bd69cb93f01e1b4a4632bd7a882bbab989f"),
  buybackVault: getAddress("0x5b734cb2412e3ed5acca8869719593642c20b833"),
  graduationExecutor: getAddress("0xfc3754655e2622a4c396c0d9868c193f4c636d3a"),
  graduationGuard: getAddress("0x3d0EF994C5478B253a3BdBDD4E7a6f84bFe101E4"),
  launchDeployer: getAddress("0xa36163be33e7795387c7e40c0a9505e27072aa1a"),
  poolManager: getAddress("0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1"),
  positionManager: getAddress("0x1d1C51b9d07fD27d36412A2b66CC23D19Eb3E518"),
  permit2: getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3"),
  universalRouter: getAddress("0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a"),
  startBlock: 2277954,
});

const KEYS = ["factory", "launchAndBuy", "feeEscrow", "memeHook", "locker", "buybackVault", "graduationExecutor", "graduationGuard",
  "launchDeployer", "poolManager", "positionManager", "permit2", "universalRouter"] as const;

/**
 * A deployment from a record in the elysium-launchpad / eden-contracts JSON format (any missing Uniswap address falls
 * back to mainnet's), with optional overrides. Use it for a local or forked chain.
 */
export function loadDeployment(record: Record<string, unknown>, overrides: Partial<Deployment> = {}): Deployment {
  const out: Record<string, unknown> = { chainId: Number(record.chainId ?? overrides.chainId ?? ELYSIUM_CHAIN_ID) };
  for (const key of KEYS) {
    const value = overrides[key] ?? record[key] ?? (["poolManager", "positionManager", "permit2", "universalRouter"].includes(key) ? MAINNET[key] : undefined);
    if (typeof value !== "string") throw new Error(`Deployment record has no ${key}.`);
    out[key] = getAddress(value);
  }
  if (typeof record.startBlock === "number") out.startBlock = record.startBlock;
  return Object.freeze(out) as Deployment;
}

/** The Elysium chain for viem. */
export function elysiumChain(rpcUrl: string = DEFAULT_RPC_URL, chainId: number = ELYSIUM_CHAIN_ID): Chain {
  return defineChain({
    id: chainId,
    name: "Elysium",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
}

/** Uniswap on Elysium: V4 PoolManager, Permit2, and the Universal Router v2.2.0 that graduated tokens trade through. */
export const UNISWAP = {
  poolManager: MAINNET.poolManager,
  permit2: MAINNET.permit2,
  universalRouter: MAINNET.universalRouter,
} as const satisfies Record<string, Address>;

/** The docs table: what each contract does. */
export const CONTRACT_ROWS: [string, Address][] = [
  ["Launch factory", MAINNET.factory],
  ["Launch and buy", MAINNET.launchAndBuy],
  ["Creator fee escrow", MAINNET.feeEscrow],
  ["Uniswap V4 hook (pool fees)", MAINNET.memeHook],
  ["Liquidity locker", MAINNET.locker],
  ["Buyback vault", MAINNET.buybackVault],
  ["Graduation executor", MAINNET.graduationExecutor],
  ["Graduation guard", MAINNET.graduationGuard],
  ["Launch deployer", MAINNET.launchDeployer],
];

/** Launch config 0 on mainnet: the curve's virtual HYPE reserve and the HYPE raised at graduation (71.4% of supply sold). */
export const PHANTOM_HYPE = 76.0483;
export const GRADUATION_HYPE = 190.12075;
/** How config 0 splits the supply at graduation (r = graduation / phantom): sold on the curve, seeded into the pool, locked. */
const R = GRADUATION_HYPE / PHANTOM_HYPE;
export const SUPPLY_SPLIT = { sold: R / (1 + R), pool: R / (1 + R) ** 2, locked: 1 - R / (1 + R) - R / (1 + R) ** 2 };

export const SOURCE_URL = "https://github.com/EdenFamily/eden-contracts";
export const DEPLOYMENT_JSON_URL = "https://github.com/EdenFamily/eden-contracts/blob/main/deployments/elysium-mainnet.json";
