/**
 * Signs and sends verified steps one by one: simulate (eth_call) → estimate gas → sign locally → send (through Eden's
 * POST /tx/send by default, or a caller-supplied RPC) → wait for the receipt → require status success.
 */
import { keccak256, type Account, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import type { EdenReader } from "./chain.ts";
import { ConfigError, TransactionError, VerificationError } from "./errors.ts";
import type { EdenApi } from "./http.ts";
import type { Step } from "./types.ts";

export type Sender = {
  /** Reads, gas, nonce, fees and receipts. */
  publicClient: PublicClient;
  reader: EdenReader;
  /** "api": POST /tx/send (default). "rpc": eth_sendRawTransaction on `sendClient` (a caller-supplied RPC). */
  via: "api" | "rpc";
  api: EdenApi;
  sendClient?: PublicClient;
  account?: Account;
  /** Alternative to a local account: a wallet that signs and broadcasts itself (e.g. a browser wallet). */
  walletClient?: WalletClient;
  /** Multiplier on estimated gas, in percent (default 120). */
  gasBufferPercent?: number;
  receiptTimeoutMs?: number;
  onStep?: (event: { index: number; step: Step; stage: "simulated" | "signed" | "sent" | "confirmed"; hash?: Hex }) => void;
};

export async function executeSteps(steps: Step[], s: Sender): Promise<TransactionReceipt[]> {
  const receipts: TransactionReceipt[] = [];
  const from = s.account?.address ?? s.walletClient?.account?.address;
  if (!from) throw new ConfigError("No account: pass `account` (a viem LocalAccount, e.g. privateKeyToAccount(key)) or a `walletClient` to the EdenClient.");
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.tx.from.toLowerCase() !== from.toLowerCase()) throw new VerificationError("from", `step is for ${step.tx.from}, the signer is ${from}`, i);
    // Simulated right before signing, after earlier steps (approvals) are mined.
    try {
      await s.reader.simulate(step.tx);
    } catch (e) {
      throw new VerificationError("simulation", (e as Error).message, i);
    }
    s.onStep?.({ index: i, step, stage: "simulated" });
    const estimate = await s.publicClient.estimateGas({ account: from, to: step.tx.to, data: step.tx.data, value: step.tx.value });
    const gas = (estimate * BigInt(s.gasBufferPercent ?? 120)) / 100n;
    let hash: Hex;
    if (s.account && typeof (s.account as { signTransaction?: unknown }).signTransaction === "function") {
      const nonce = await s.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      let fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };
      try {
        const f = await s.publicClient.estimateFeesPerGas();
        fees = { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas! };
      } catch {
        fees = { gasPrice: await s.publicClient.getGasPrice() };
      }
      const signed = await (s.account as { signTransaction: (tx: any) => Promise<Hex> }).signTransaction({
        chainId: step.tx.chainId, nonce, to: step.tx.to, data: step.tx.data, value: step.tx.value, gas,
        ...("gasPrice" in fees ? { type: "legacy", gasPrice: fees.gasPrice } : { type: "eip1559", ...fees }),
      });
      s.onStep?.({ index: i, step, stage: "signed" });
      const local = keccak256(signed);
      if (s.via === "rpc") {
        if (!s.sendClient) throw new ConfigError("sendVia \"rpc\" needs sendRpcUrl.");
        hash = await s.sendClient.sendRawTransaction({ serializedTransaction: signed });
      } else {
        const sent = await s.api.txSend(signed);
        if (sent.from && sent.from.toLowerCase() !== from.toLowerCase()) {
          throw new TransactionError("from_mismatch", `POST /tx/send says the transaction is from ${sent.from}, but it was signed by ${from}.`, local);
        }
        hash = sent.hash;
      }
      if (hash.toLowerCase() !== local.toLowerCase()) {
        throw new TransactionError("hash_mismatch", `The send endpoint returned ${hash}, but the signed transaction's hash is ${local}.`, local);
      }
    } else if (s.walletClient) {
      hash = await s.walletClient.sendTransaction({ account: s.walletClient.account!, chain: s.walletClient.chain ?? null, to: step.tx.to, data: step.tx.data, value: step.tx.value, gas });
    } else {
      throw new ConfigError("The account cannot sign transactions locally; pass a LocalAccount or a walletClient.");
    }
    s.onStep?.({ index: i, step, stage: "sent", hash });
    let receipt: TransactionReceipt;
    try {
      receipt = await s.publicClient.waitForTransactionReceipt({ hash, timeout: s.receiptTimeoutMs ?? 120_000 });
    } catch (cause) {
      throw new TransactionError("unconfirmed", `No receipt for ${hash} yet: ${(cause as Error).message.split("\n")[0]}. Check it before retrying.`, hash, { cause });
    }
    if (receipt.status !== "success") throw new TransactionError("reverted", `Transaction ${hash} (step ${i}, ${step.kind}) reverted on chain.`, hash);
    receipts.push(receipt);
    s.onStep?.({ index: i, step, stage: "confirmed", hash });
  }
  return receipts;
}
