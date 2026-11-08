/**
 * Local mode, end to end on the local anvil chain (chain 99901, Eden deployed; never mainnet):
 * launch (logo pinned through the mock Pinata) with an initial buy → curve buy and sell with exact amounts → verify()
 * rejecting tampered steps → buy to graduation → create the pool → pool buy and Permit2 sell through the Universal
 * Router with exact amounts → tampered pool steps rejected → claim the creator's fees.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getAddress, parseEther, type Address, type Hex } from "viem";
import {
  createReader, EdenClient, encodeV4Swap, initialBuyQuote, parseHype, poolKey, verifySwap, VerificationError, type SwapPlan, type SwapRequest,
} from "../../src/index.ts";
import { edenLauncherTokenAbi } from "../../src/abi/eden.ts";
import { startMockApi, type MockApi } from "../support/mock-api.ts";
import { account, chainUp, deployment, fund, publicClient, RPC, tinyPng, warp } from "../support/env.ts";

const creator = account(60), trader = account(61), other = account(62);
let api: MockApi;
const reader = createReader(publicClient, deployment);
const client = (acct = trader, extra: Record<string, unknown> = {}) =>
  new EdenClient({ rpcUrl: RPC, deployment, account: acct, mode: "local", sendVia: "rpc", sendRpcUrl: RPC, apiUrl: api.url, publicClient, ...extra });

let token: Address, curve: Address;

/** A deep copy of a plan with one change. */
function tamper(plan: SwapPlan, f: (p: SwapPlan) => void): SwapPlan {
  const p: SwapPlan = { ...plan, quote: { ...plan.quote }, steps: plan.steps.map((s) => ({ ...s, tx: { ...s.tx } })) };
  f(p);
  return p;
}
async function rejects(plan: SwapPlan, req: SwapRequest, code: string) {
  await assert.rejects(verifySwap(reader, plan, req), (e: unknown) => {
    assert.ok(e instanceof VerificationError, `expected VerificationError, got ${String(e)}`);
    assert.equal((e as VerificationError).code, code, (e as Error).message);
    return true;
  });
}

describe("local mode lifecycle on anvil", { skip: false }, () => {
  before(async () => {
    if (!(await chainUp())) throw new Error(`No Eden chain at ${RPC}`);
    for (const a of [creator, trader, other]) await fund(a.address, "5000");
    api = await startMockApi();
  });
  after(async () => { await api?.close(); });

  test("launch with an initial buy: logo pinned, metadata on chain, exact tokens", async () => {
    const eden = client(creator, { skipQuotaCheck: false });
    const symbol = `SDK${Date.now() % 100000}`;
    const initialBuy = parseHype("1");
    const { expected } = await initialBuyQuote(reader, initialBuy, 200, 300);
    const r = await eden.launch({ name: "Eden SDK Test", symbol: symbol.toLowerCase(), description: "  launched by the SDK e2e test  ", image: tinyPng(4, 2),
      socials: { x: "@EdenOnElysium", website: "https://edenfamily.xyz" }, initialBuy, creatorFeeBps: 200, buyback: false });
    token = r.token; curve = r.curve;
    assert.match(r.logo, /^ipfs:\/\/Qm/);
    assert.equal(r.initialBuy?.tokensOut, expected, "initial buy tokens = own quote");
    assert.equal(r.initialBuy?.quoteIn, initialBuy);
    assert.ok(r.warnings.some((w) => w.includes("4×2")), "non-square image warning");
    const [name, sym, logo, description] = await Promise.all(["name", "symbol", "logo", "description"].map((f) =>
      publicClient.readContract({ address: token, abi: edenLauncherTokenAbi, functionName: f as "name" })));
    assert.deepEqual([name, sym, logo, description], ["Eden SDK Test", symbol, r.logo, "launched by the SDK e2e test"]);
    const socials = await publicClient.readContract({ address: token, abi: edenLauncherTokenAbi, functionName: "socials" });
    assert.equal(socials[0], "https://x.com/EdenOnElysium");
    assert.equal(await reader.balance(creator.address, token), expected);
    await warp(600); // past the snipe-tax window
  });

  test("curve buy: received = quote, fee = quote", async () => {
    const eden = client();
    const amount = parseHype("2.345");
    const q = await eden.quote(token, "buy", amount);
    assert.equal(q.route, "curve");
    const before = await reader.balance(trader.address, token);
    const fill = await eden.buy(token, amount);
    assert.equal(fill.route, "curve");
    assert.equal(fill.amountOut, q.expectedOut);
    assert.equal(fill.fee, q.fee);
    assert.equal(fill.tax, q.tax);
    assert.equal(fill.amountIn, amount);
    assert.equal((await reader.balance(trader.address, token)) - before, q.expectedOut);
    assert.ok(fill.receipt.status === "success");
  });

  test("curve sell with an exact approval: received = quote", async () => {
    const eden = client();
    const held = await reader.balance(trader.address, token);
    const amount = held / 3n;
    const plan = await eden.buildSell(token, amount);
    assert.deepEqual(plan.steps.map((s) => s.kind), ["approve", "swap"]);
    const hypeBefore = await reader.balance(trader.address);
    const fill = await eden.executeSwap(plan, { token, side: "sell", amount, user: trader.address });
    assert.equal(fill.amountOut, plan.quote.expectedOut);
    let gas = 0n;
    for (const h of fill.hashes) { const r = await publicClient.getTransactionReceipt({ hash: h }); gas += r.gasUsed * r.effectiveGasPrice; }
    assert.equal((await reader.balance(trader.address)) - hypeBefore + gas, plan.quote.expectedOut);
  });

  test("verify() rejects tampered curve steps", async () => {
    const eden = client();
    const req: SwapRequest = { token, side: "buy", amount: parseHype("1"), user: trader.address, slippageBps: 300 };
    const plan = await eden.buildSwap(req);
    await verifySwap(reader, plan, req); // the honest plan passes
    const swap = plan.steps.length - 1;
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.to = deployment.factory; }), req, "to");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.chainId = 1; }), req, "chain_id");
    await rejects(tamper(plan, (p) => { p.chainId = 1; }), req, "chain_id");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.value += 1n; }), req, "value");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.from = other.address; }), req, "from");
    const { encodeCurveBuy, appendMarker } = await import("../../src/calldata.ts");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.data = appendMarker(encodeCurveBuy(req.amount, p.quote.minOut, other.address), "4544454e0001"); }), req, "recipient");
    const lowered = plan.quote.minOut / 2n;
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.data = encodeCurveBuy(req.amount, lowered, trader.address); p.quote.minOut = lowered; }), req, "slippage");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.data = encodeCurveBuy(req.amount, lowered, trader.address); }), req, "min_out");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.data = `${p.steps[swap]!.tx.data}deadbeef` as Hex; }), req, "calldata");
    await rejects(tamper(plan, (p) => { p.steps[swap]!.tx.data = encodeCurveBuy(req.amount + 1n, p.quote.minOut, trader.address); }), req, "amount");
    await rejects(tamper(plan, (p) => { p.route = "pool"; }), req, "route");
  });

  test("buy to graduation: clamped final buy refunds the rest, graduates, pool created", async () => {
    const eden = client();
    const amount = parseHype("200");
    const q = await eden.quote(token, "buy", amount);
    assert.ok(q.graduates, "quote says this buy completes the curve");
    assert.ok(q.amountSpent! < amount, "clamped: spends less than offered");
    const fill = await eden.buy(token, amount);
    assert.equal(fill.amountOut, q.expectedOut);
    assert.equal(fill.amountIn, q.amountSpent);
    assert.ok(fill.graduated);
    const launch = await reader.launch(token);
    assert.ok(launch?.phase === "swept" || launch?.phase === "pool");
    if (launch?.phase === "swept") {
      await assert.rejects(eden.quote(token, "buy", parseHype("1")), /graduat/i);
      const g = await eden.graduate(token);
      assert.ok(g.positionId !== undefined);
    }
    assert.equal((await reader.launch(token))?.phase, "pool");
  });

  test("pool buy through the Universal Router: received = quote", async () => {
    const eden = client();
    const amount = parseHype("1.5");
    const q = await eden.quote(token, "buy", amount);
    assert.equal(q.route, "pool");
    const before = await reader.balance(trader.address, token);
    const fill = await eden.buy(token, amount);
    assert.equal(fill.route, "pool");
    assert.equal(fill.amountOut, q.expectedOut);
    assert.equal(fill.fee, q.fee);
    assert.equal(fill.feeCurrency, token);
    assert.equal((await reader.balance(trader.address, token)) - before, q.expectedOut);
  });

  test("pool sell with Permit2 (approve, permit2-approve, swap): received = quote", async () => {
    const eden = client();
    const amount = (await reader.balance(trader.address, token)) / 4n;
    const plan = await eden.buildSell(token, amount);
    assert.deepEqual(plan.steps.map((s) => s.kind), ["approve", "permit2-approve", "swap"]);
    const fill = await eden.executeSwap(plan, { token, side: "sell", amount, user: trader.address });
    assert.equal(fill.amountOut, plan.quote.expectedOut);
    assert.equal(fill.feeCurrency, "HYPE");
  });

  test("pool buy to another recipient (TAKE)", async () => {
    const eden = client();
    const before = await reader.balance(other.address, token);
    const fill = await eden.buy(token, parseHype("0.25"), { recipient: other.address });
    assert.equal((await reader.balance(other.address, token)) - before, fill.amountOut);
    assert.equal(fill.amountOut, fill.expectedOut);
  });

  test("verify() rejects tampered pool steps", async () => {
    const eden = client();
    const req: SwapRequest = { token, side: "buy", amount: parseHype("1"), user: trader.address, slippageBps: 300 };
    const plan = await eden.buildSwap(req);
    await verifySwap(reader, plan, req);
    const now = (await publicClient.getBlock()).timestamp + 600n;
    const key = poolKey(token, deployment.memeHook);
    const set = (data: Hex) => (p: SwapPlan) => { p.steps[0]!.tx.data = data; };
    await rejects(tamper(plan, set(encodeV4Swap({ ...key, hooks: deployment.factory }, "buy", req.amount, plan.quote.minOut, now))), req, "pool_key");
    await rejects(tamper(plan, set(encodeV4Swap(key, "buy", req.amount, plan.quote.minOut, now, other.address))), req, "recipient");
    await rejects(tamper(plan, (p) => { set(encodeV4Swap(key, "buy", req.amount, 1n, now))(p); p.quote.minOut = 1n; }), req, "slippage");
    await rejects(tamper(plan, set(encodeV4Swap(key, "buy", req.amount, plan.quote.minOut, now + 86_400n))), req, "deadline");
    await rejects(tamper(plan, set(encodeV4Swap(key, "sell", req.amount, plan.quote.minOut, now))), req, "direction");
    await rejects(tamper(plan, (p) => { p.steps[0]!.tx.to = getAddress(deployment.permit2); }), req, "to");
    await rejects(tamper(plan, (p) => { p.steps[0]!.tx.value = parseEther("2"); }), req, "value");
  });

  test("pool sell with a signed Permit2 permit (website flow: approve, then PERMIT2_PERMIT + V4_SWAP)", async () => {
    const seller = account(66);
    await fund(seller.address, "100");
    const eden = client(seller, { permit2: "signature", approval: "unlimited" });
    await eden.buy(token, parseHype("1"));
    const amount = (await reader.balance(seller.address, token)) / 2n;
    const plan = await eden.buildSell(token, amount);
    assert.deepEqual(plan.steps.map((s) => s.kind), ["approve", "swap"]);
    assert.ok(plan.steps[1]!.tx.data.startsWith("0x3593564c"), "execute(bytes,bytes[],uint256)");
    const { decodeV4Swap } = await import("../../src/calldata.ts");
    const v = decodeV4Swap(plan.steps[1]!.tx.data);
    assert.ok(!("error" in v) && v.permit, "the swap carries the signed permit");
    const fill = await eden.executeSwap(plan, { token, side: "sell", amount, user: seller.address });
    assert.equal(fill.amountOut, plan.quote.expectedOut);
    const again = await eden.buildSell(token, amount / 2n);
    assert.deepEqual(again.steps.map((s) => s.kind), ["swap"], "later sells are just the swap");
    assert.ok(again.steps[0]!.tx.data.length < plan.steps[1]!.tx.data.length, "no permit needed the second time");
  });

  test("claim creator fees from the escrow", async () => {
    const eden = client(creator);
    const before = await reader.escrowBalance(creator.address);
    assert.ok(before > 0n, "graduation credited the creator's curve fees");
    const r = await eden.claimFees({ token });
    assert.equal(r.claimed, before + r.swept);
    assert.equal(await reader.escrowBalance(creator.address), 0n);
    const again = await eden.claimFees({ token });
    assert.equal(again.hashes.length, 0, "nothing left to claim");
  });
});
