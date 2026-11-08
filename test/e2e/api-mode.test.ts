/**
 * API mode end to end: the client asks the (mock) Eden API for plans over HTTP, verifies them against its own chain
 * reads, signs locally and sends through POST /tx/send. Then the server turns dishonest: every tampered response must
 * be rejected before anything is signed or sent.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encodeFunctionData, type Address } from "viem";
import { createReader, EdenClient, LaunchQuotaError, parseHype, VerificationError } from "../../src/index.ts";
import { edenBondingCurveAbi } from "../../src/abi/eden.ts";
import { startMockApi, type MockApi } from "../support/mock-api.ts";
import { account, chainUp, deployment, fund, publicClient, RPC, tinyPng, warp } from "../support/env.ts";

const creator = account(63), trader = account(64), thief = account(65);
const reader = createReader(publicClient, deployment);
let api: MockApi, token: Address, curve: Address;
const client = (acct = trader) => new EdenClient({ rpcUrl: RPC, deployment, account: acct, mode: "api", apiUrl: api.url, publicClient });

async function refused(f: () => Promise<unknown>, code: string) {
  const sentBefore = api.sent.length;
  const nonce = await publicClient.getTransactionCount({ address: trader.address });
  await assert.rejects(f(), (e: unknown) => {
    assert.ok(e instanceof VerificationError, `expected VerificationError, got ${String(e)}`);
    assert.equal((e as VerificationError).code, code, (e as Error).message);
    return true;
  });
  assert.equal(api.sent.length, sentBefore, "nothing was sent");
  assert.equal(await publicClient.getTransactionCount({ address: trader.address }), nonce, "nonce unchanged: nothing signed and mined");
}

describe("API mode against the developer-endpoint contract", () => {
  before(async () => {
    if (!(await chainUp())) throw new Error(`No Eden chain at ${RPC}`);
    for (const a of [creator, trader, thief]) await fund(a.address, "5000");
    api = await startMockApi();
  });
  after(async () => { await api?.close(); });

  test("launch through POST /tx/launch (data: URI image), verified, sent through POST /tx/send", async () => {
    const r = await client(creator).launch({ name: "API Mode", symbol: `API${Date.now() % 10000}`, image: tinyPng(3, 3), initialBuy: parseHype("0.5"), buyback: false });
    token = r.token; curve = r.curve;
    assert.ok(api.requests.includes("POST /tx/launch") && api.requests.includes("POST /tx/send"));
    assert.ok(r.initialBuy && r.initialBuy.tokensOut > 0n);
    assert.equal(r.warnings.length, 0, "square image: no warning");
    await warp(600);
  });

  test("launch limits: the third launch of the day is a LaunchQuotaError (no retry)", async () => {
    await client(creator).launch({ name: "Second", symbol: "SECOND", image: tinyPng(2, 2) });
    await assert.rejects(client(creator).launch({ name: "Third", symbol: "THIRD", image: tinyPng(2, 2) }), (e: unknown) => e instanceof LaunchQuotaError && e.scope === "daily");
  });

  test("GET quote and an honest buy and sell", async () => {
    const eden = client();
    const q = await eden.quote(token, "buy", parseHype("3"));
    const fill = await eden.buy(token, parseHype("3"));
    assert.equal(fill.amountOut, q.expectedOut);
    const sell = await eden.sell(token, fill.amountOut / 2n);
    assert.equal(sell.amountOut, sell.expectedOut);
  });

  test("a dishonest server is refused before signing", async () => {
    const eden = client();
    const buy = () => eden.buy(token, parseHype("1"));
    const lastStep = (f: (s: any, b: any) => void) => (path: string, b: any) => { if (path === "/tx/swap") f(b.steps[b.steps.length - 1], b); return b; };
    const cases: Array<[string, (path: string, b: any) => any]> = [
      ["to", lastStep((s) => { s.tx.to = thief.address; })],
      ["chain_id", lastStep((s) => { s.tx.chainId = 1; })],
      ["value", lastStep((s) => { s.tx.value = (BigInt(s.tx.value) + 1n).toString(); })],
      ["from", lastStep((s) => { s.tx.from = thief.address; })],
      ["recipient", lastStep((s, b) => { s.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [parseHype("1"), BigInt(b.quote.minOut), thief.address] }); })],
      ["slippage", lastStep((s, b) => { b.quote.minOut = "1"; s.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [parseHype("1"), 1n, trader.address] }); })],
      ["min_out", lastStep((s) => { s.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [parseHype("1"), 1n, trader.address] }); })],
      ["calldata", lastStep((s) => { s.tx.data = `${s.tx.data}00`; })],
      ["route", (path, b) => { if (path === "/tx/swap") { b.route = "pool"; } return b; }],
      ["to", (path, b) => { if (path === "/tx/swap") b.steps.unshift({ ...b.steps[0], kind: "approve" }); return b; }],
    ];
    for (const [code, t] of cases) {
      api.tamper = t;
      await refused(buy, code);
    }
    api.tamper = (path, b) => {
      if (path === "/tx/swap") b.steps.unshift({ kind: "approve", description: "", tx: { ...b.steps[0].tx, to: token,
        data: encodeFunctionData({ abi: [{ type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" }], functionName: "approve", args: [thief.address, 10n ** 30n] }), value: "0" } });
      return b;
    };
    await refused(() => eden.sell(token, 10n ** 18n), "spender");
    api.tamper = (path, b) => { if (path === "/tx/launch") b.logo = "https://evil.example/logo.png"; return b; };
    await assert.rejects(client(thief).launch({ name: "Evil", symbol: "EVIL", image: tinyPng(2, 2) }), (e: unknown) => e instanceof VerificationError && e.code === "logo");
    api.tamper = (path, b) => { if (path === "/tx/launch") b.steps[0].tx.value = (BigInt(b.steps[0].tx.value) + 10n ** 18n).toString(); return b; };
    await assert.rejects(client(thief).launch({ name: "Evil", symbol: "EVIL", image: tinyPng(2, 2) }), (e: unknown) => e instanceof VerificationError && e.code === "value");
    api.tamper = undefined;
    assert.ok(curve);
  });

  test("POST /tx/send returning another hash is caught", async () => {
    api.tamper = (path, b) => { if (path === "/tx/send") b.hash = `0x${"ab".repeat(32)}`; return b; };
    await assert.rejects(client().buy(token, parseHype("0.1")), (e: unknown) => (e as { code?: string }).code === "hash_mismatch");
    api.tamper = undefined;
  });

  test("claim through POST /tx/claim", async () => {
    const r = await client(creator).claimFees({ token });
    assert.ok(r.swept + r.claimed > 0n, "the creator swept and claimed curve fees");
    assert.equal(await reader.escrowBalance(creator.address), 0n);
  });
});
