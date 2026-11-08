/**
 * API mode against the real Eden server (EDEN_REAL_API, default http://127.0.0.1:8796) indexing the local chain:
 * every plan comes from POST /tx/*, is verified against the SDK's own chain reads, signed locally and relayed by
 * POST /tx/send. Skipped when no server answers.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { encodeFunctionData, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createReader, EdenApiError, initialBuyQuote, EdenClient, edenBondingCurveAbi, localQuote, parseHype, parseSwapPlan, verifySwap, VerificationError, type SwapRequest,
} from "../../src/index.ts";
import { account, chainUp, deployment, fund, publicClient, RPC, tinyPng, warp } from "../support/env.ts";

const API = process.env.EDEN_REAL_API ?? "http://127.0.0.1:8796";
let up = false;
try { up = (await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })).ok && (await chainUp()); } catch { /* down */ }

const creator = privateKeyToAccount(generatePrivateKey()); // fresh each run: the server's launch quota is real
const trader = account(68);
const reader = createReader(publicClient, deployment);
const client = (acct: typeof trader | typeof creator) => new EdenClient({ apiUrl: API, rpcUrl: RPC, deployment, publicClient, account: acct, mode: "api" });
let token: Address;

async function until<T>(what: string, f: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const indexedPhase = (phase: string) => until(`token phase ${phase}`, async () => (await client(trader).token(token)).phase === phase);

describe(`API mode against the real server (${API})`, { skip: !up }, () => {
  before(async () => { await fund(creator.address, "200"); await fund(trader.address, "5000"); });

  test("launch: POST /tx/launch (logo squared and pinned by the server), verified, relayed; tokens = predicted", async () => {
    const eden = client(creator);
    const { plan } = await eden.buildLaunch({ user: creator.address, name: "Server Proof", symbol: `SRV${Date.now() % 10000}`, image: tinyPng(6, 3),
      socials: { x: "@EdenOnElysium" }, initialBuy: parseHype("1"), buyback: false });
    assert.match(plan.logo, /^ipfs:\/\//);
    const own = await initialBuyQuote(reader, parseHype("1"), 100, 300);
    assert.equal(plan.predicted?.initialBuyTokensOut, own.expected, "server's simulated tokens = SDK's launch-config math");
    assert.equal(plan.predicted?.minTokensOut, own.minOut);
    const r = await eden.launch({ name: "Server Proof 2", symbol: `SRW${Date.now() % 10000}`, image: tinyPng(6, 3), initialBuy: parseHype("1"), buyback: false });
    token = r.token;
    assert.ok(r.initialBuy && r.initialBuy.tokensOut > 0n);
    await indexedPhase("curve");
    await warp(600);
  });

  test("quotes: the API's quote equals the SDK's own (curve)", async () => {
    const api = await client(trader).quote(token, "buy", parseHype("2"));
    const own = (await localQuote(reader, { token, side: "buy", amount: parseHype("2"), slippageBps: 300, recipient: trader.address })).quote;
    assert.deepEqual([api.expectedOut, api.minOut, api.fee, api.tax, api.route], [own.expectedOut, own.minOut, own.fee, own.tax, own.route]);
  });

  test("curve buy and sell through the API: received = quote", async () => {
    const eden = client(trader);
    const q = await eden.quote(token, "buy", parseHype("2"));
    const fill = await eden.buy(token, parseHype("2"));
    assert.equal(fill.amountOut, q.expectedOut);
    const sell = await eden.sell(token, fill.amountOut / 2n);
    assert.equal(sell.amountOut, sell.expectedOut);
  });

  test("real API responses, tampered, are refused", async () => {
    const eden = client(trader);
    const req: SwapRequest = { token, side: "buy", amount: parseHype("1"), user: trader.address, slippageBps: 300 };
    const wire = await eden.api.txSwap({ ...req, slippageBps: 300 });
    await verifySwap(reader, parseSwapPlan(wire, 300), req);
    const t = (f: (w: typeof wire) => void) => { const w = JSON.parse(JSON.stringify(wire)); f(w); return parseSwapPlan(w, 300); };
    const evil = account(69).address;
    const refuse = async (plan: ReturnType<typeof parseSwapPlan>, code: string) =>
      assert.rejects(verifySwap(reader, plan, req), (e: unknown) => e instanceof VerificationError && e.code === code);
    await refuse(t((w) => { w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [req.amount, BigInt(w.quote.minOut), evil] }); }), "recipient");
    await refuse(t((w) => { w.quote.minOut = "1"; w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [req.amount, 1n, trader.address] }); }), "slippage");
    await refuse(t((w) => { w.steps[0]!.tx.to = evil; }), "to");
    await refuse(t((w) => { w.steps[0]!.tx.chainId = 1; }), "chain_id");
    await refuse(t((w) => { w.steps[0]!.tx.value = parseEther("2").toString(); }), "value");
  });

  test("/tx/send relays only Eden calls", async () => {
    const signed = await trader.signTransaction({ chainId: deployment.chainId, nonce: 0, to: trader.address, value: 1n, gas: 21_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n, type: "eip1559" });
    await assert.rejects(client(trader).api.txSend(signed), (e: unknown) => e instanceof EdenApiError && e.code === "tx:not_eden");
  });

  test("buy to graduation, graduate, then pool buy and Permit2 sell through the API (API quote = own quote = fill)", async () => {
    const eden = client(trader);
    const fill = await eden.buy(token, parseHype("300"));
    assert.ok(fill.graduated);
    if ((await reader.launch(token))?.phase === "swept") await eden.graduate(token);
    await indexedPhase("pool");
    const api = await eden.quote(token, "buy", parseHype("1.5"));
    const own = (await localQuote(reader, { token, side: "buy", amount: parseHype("1.5"), slippageBps: 300, recipient: trader.address })).quote;
    assert.deepEqual([api.route, api.expectedOut, api.minOut], ["pool", own.expectedOut, own.minOut]);
    const buy = await eden.buy(token, parseHype("1.5"));
    assert.equal(buy.amountOut, api.expectedOut);
    const plan = await eden.buildSell(token, buy.amountOut / 3n);
    assert.deepEqual(plan.steps.map((s) => s.kind), ["approve", "permit2-approve", "swap"]);
    const sell = await eden.executeSwap(plan, { token, side: "sell", amount: buy.amountOut / 3n, user: trader.address });
    assert.equal(sell.amountOut, plan.quote.expectedOut);
  });

  test("claim through POST /tx/claim (claimable entries, verified)", async () => {
    const eden = client(creator);
    const plan = await eden.buildClaim({ user: creator.address });
    assert.ok(plan.claimable.some((c) => c.kind === "fee_escrow" && c.amount > 0n), JSON.stringify(plan.claimable, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const r = await eden.claimFees();
    assert.ok(r.claimed > 0n);
    assert.equal(await reader.escrowBalance(creator.address), 0n);
  });
});
