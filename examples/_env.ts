/**
 * Shared setup for the examples. In your own project, import from "@edenfamily/eden-sdk" instead of "../src/index.ts".
 *
 *   EDEN_PRIVATE_KEY  the signing wallet's key (never commit it, never print it)
 *   EDEN_RPC_URL      reads (default Elysium's public RPC)
 *   EDEN_SEND_RPC     optional: an RPC that accepts sends; without it, transactions go through Eden's POST /tx/send
 *   EDEN_MODE         "api" (default) or "local"
 *   EDEN_API_URL      default https://edenfamily.xyz/api
 *   EDEN_DEPLOYMENT   optional: a deployment record JSON (local or forked chain)
 */
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EdenClient, loadDeployment, MAINNET } from "../src/index.ts";

export function eden(needsWallet = true): EdenClient {
  const key = process.env.EDEN_PRIVATE_KEY as Hex | undefined;
  if (needsWallet && !key) throw new Error("Set EDEN_PRIVATE_KEY (the wallet that signs).");
  return new EdenClient({
    account: key ? privateKeyToAccount(key) : undefined,
    rpcUrl: process.env.EDEN_RPC_URL,
    apiUrl: process.env.EDEN_API_URL,
    mode: (process.env.EDEN_MODE as "api" | "local" | undefined) ?? "api",
    ...(process.env.EDEN_SEND_RPC ? { sendVia: "rpc" as const, sendRpcUrl: process.env.EDEN_SEND_RPC } : {}),
    deployment: process.env.EDEN_DEPLOYMENT ? loadDeployment(JSON.parse(readFileSync(process.env.EDEN_DEPLOYMENT, "utf8"))) : MAINNET,
  });
}

export const show = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
