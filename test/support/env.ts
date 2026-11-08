/** Test environment: the local anvil chain with Eden deployed (never mainnet). */
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { createPublicClient, http, parseEther, toHex, type Address, type PublicClient } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { elysiumChain, loadDeployment, type Deployment } from "../../src/index.ts";

export const RPC = process.env.EDEN_TEST_RPC ?? "http://127.0.0.1:8590";
export const PINATA = process.env.EDEN_TEST_PINATA ?? "http://127.0.0.1:8593";
/** A running Eden server indexing the same chain, for read endpoints (optional). */
export const UPSTREAM_API = process.env.EDEN_TEST_API ?? "http://127.0.0.1:8791";
/** The deployment record of the local test chain (JSON with the contract addresses). Required for the e2e suites. */
export const DEPLOYMENT_FILE = process.env.EDEN_DEPLOYMENT ?? "";
const missing = () => { throw new Error("set EDEN_DEPLOYMENT to the local test chain's deployment record (needed by the e2e suites)"); };
export const deployment: Deployment = DEPLOYMENT_FILE
  ? loadDeployment(JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")))
  : new Proxy({} as Deployment, { get: missing });
export const CHAIN_ID = DEPLOYMENT_FILE ? deployment.chainId : 99901;

/** anvil's well-known test mnemonic (public; never holds real funds). Index 60 and up, to stay clear of other tests. */
const MNEMONIC = "test test test test test test test test test test test junk";
export const account = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

export const publicClient = createPublicClient({ chain: elysiumChain(RPC, CHAIN_ID), transport: http(RPC), pollingInterval: 50 }) as PublicClient;

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}
export const fund = (a: Address, hype = "5000") => rpc("anvil_setBalance", [a, toHex(parseEther(hype))]);
export async function warp(seconds: number) { await rpc("evm_increaseTime", [seconds]); await rpc("evm_mine"); }

export async function chainUp(): Promise<boolean> {
  try { return Number(await rpc<string>("eth_chainId")) === CHAIN_ID; } catch { return false; }
}
export async function upstreamUp(): Promise<boolean> {
  try { return (await fetch(`${UPSTREAM_API}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

/** A tiny PNG (2×1, so not square) built in memory. */
export function tinyPng(width = 2, height = 1): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x7f);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
