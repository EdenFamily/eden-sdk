/**
 * verify() against hand-built API responses in the exact wire shape of POST /tx/swap, /tx/launch and /tx/claim, with a
 * stubbed chain reader: no chain, no server. Each tampered response must throw VerificationError with the right code.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, getAddress, maxUint256, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import {
  edenBondingCurveAbi, edenFeeEscrowAbi, edenLaunchAndBuyAbi, edenMemeHookAbi, encodeV4Swap, erc20Abi, MAINNET, minOutFor, parseClaimPlan, parseLaunchPlan, parseSwapPlan,
  permit2Abi, poolId, poolKey, quoteBuy, quotePool, quoteSell, verifyClaim, verifyLaunch, verifySwap, VerificationError, type CurveState, type EdenReader,
  type PoolState, type WireSwap,
} from "../../src/index.ts";

const USER = getAddress("0x00000000000000000000000000000000000000a1");
const THIEF = getAddress("0x00000000000000000000000000000000000000b2");
const TOKEN = getAddress("0x00000000000000000000000000000000000000c3");
const CURVE = getAddress("0x00000000000000000000000000000000000000d4");
const NOW = 1_800_000_000n;
const D = MAINNET;

const curveState: CurveState = { quote: 30n * 10n ** 18n, tokens: 900_000_000n * 10n ** 18n, feeBps: 100n, taxBps: 100n, snipeTaxBps: 0n,
  sellable: 600_000_000n * 10n ** 18n, graduated: false, readyToGraduate: false };
const poolState: PoolState = { sqrtPriceX96: 79228162514264337593543950336n * 4000n, liquidity: 10n ** 24n, hookFeeBps: 100, creatorTaxBps: 0 };

function stub(phase: "curve" | "pool" = "curve"): EdenReader & { simulated: number } {
  const r = {
    simulated: 0,
    chainId: 99901,
    deployment: D,
    blockTimestamp: async () => NOW,
    launch: async (t: Address) => (t === TOKEN ? { token: TOKEN, curve: CURVE, deployer: USER, creatorFeeRecipient: USER, pairToken: zeroAddress,
      creatorTaxBps: 100, buybackEnabled: false, phase, graduationThreshold: 190n * 10n ** 18n } : null),
    curveState: async () => curveState,
    pool: async (t: Address) => ({ ...poolState, poolId: poolId(poolKey(t, D.memeHook)), key: poolKey(t, D.memeHook), registered: true, creator: USER }),
    launchFee: async () => 500_000_000_000_000n,
    launchConfig: async () => ({ supply: 10n ** 27n, curveFeeBps: 100n, phantomQuote: 76_048_300_000_000_000_000n, graduationThreshold: 190n * 10n ** 18n, enabled: true }),
    maxCreatorTaxBps: async () => 1000n,
    allowance: async () => 0n,
    permit2Allowance: async () => ({ amount: 0n, expiration: 0n, nonce: 0n }),
    escrowBalance: async () => 10n ** 17n,
    escrowTokenBalance: async () => 0n,
    curveFees: async (c: Address) => {
      if (c !== CURVE) throw new Error("not a curve");
      return { token: TOKEN, deployer: USER, quoteFeeBalance: 10n, creatorTaxBalance: 0n, buybackQuoteBalance: 0n, protocolFeeShareBps: 3000, graduated: false };
    },
    poolFees: async () => ({ quote: 0n, tax: 0n, memecoin: 0n, buyback: 0n, protocolFeeShareBps: 3000 }),
    hookLaunch: async () => ({ registered: true, memecoin: TOKEN, creator: USER }),
    balance: async () => 0n,
    simulate: async () => { r.simulated += 1; },
  };
  return r;
}

const MARK = "4544454e0001";
const tx = (to: Address, data: Hex, value: bigint) => ({ to, data: `${data}${MARK}`, value: value.toString(), chainId: 99901, from: USER });
const AMOUNT = 10n ** 18n;

/** A hand-built POST /tx/swap response for a 1 HYPE curve buy at 3% slippage. */
function curveBuyWire(): WireSwap {
  const q = quoteBuy(curveState, AMOUNT), minOut = minOutFor(q.out, 300);
  return {
    chainId: 99901, route: "curve",
    quote: { token: TOKEN, side: "buy", route: "curve", amountIn: AMOUNT.toString(), expectedOut: q.out.toString(), minOut: minOut.toString(), priceImpactBps: q.impactBps,
      fee: q.fee.toString(), tax: q.tax.toString(), priceBefore: q.priceBefore.toString(), priceAfter: q.priceAfter.toString(), graduates: false },
    steps: [{ kind: "swap", description: "Buy on the bonding curve", tx: tx(CURVE, encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [AMOUNT, minOut, USER] }), AMOUNT) }],
  };
}
const buyReq = { token: TOKEN, side: "buy" as const, amount: AMOUNT, user: USER, slippageBps: 300 };

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof VerificationError, String(e));
    assert.equal((e as VerificationError).code, code, (e as Error).message);
    return true;
  });
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("honest curve buy passes and is simulated", async () => {
  const r = stub();
  const v = await verifySwap(r, parseSwapPlan(curveBuyWire(), 300), buyReq);
  assert.equal(r.simulated, 1);
  assert.equal(v.steps[0]!.simulated, true);
});

test("tampered curve buy responses are rejected", async () => {
  const minOut = BigInt(curveBuyWire().quote.minOut);
  const cases: Array<[string, (w: WireSwap) => void]> = [
    ["to", (w) => { w.steps[0]!.tx.to = THIEF; }],
    ["chain_id", (w) => { w.steps[0]!.tx.chainId = 998; }],
    ["chain_id", (w) => { w.chainId = 42161; }],
    ["value", (w) => { w.steps[0]!.tx.value = (AMOUNT + 1n).toString(); }],
    ["from", (w) => { w.steps[0]!.tx.from = THIEF; }],
    ["recipient", (w) => { w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [AMOUNT, minOut, THIEF] }); }],
    ["amount", (w) => { w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [AMOUNT * 2n, minOut, USER] }); }],
    ["min_out", (w) => { w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [AMOUNT, minOut - 1n, USER] }); }],
    ["slippage", (w) => { w.quote.minOut = "1"; w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [AMOUNT, 1n, USER] }); }],
    ["calldata", (w) => { w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "sell", args: [AMOUNT, minOut, USER] }); }],
    ["calldata", (w) => { w.steps[0]!.tx.data += "ff"; }],
    ["calldata", (w) => { w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "sweepFees", args: [0n] }); }],
    ["route", (w) => { w.route = "pool"; }],
    ["quote", (w) => { w.quote.token = THIEF; }],
    ["to", (w) => { w.steps.unshift({ kind: "approve", description: "", tx: tx(CURVE, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [THIEF, maxUint256] }), 0n) as never }); }],
    ["missing_step", (w) => { w.steps[0]!.kind = "launch"; }],
  ];
  for (const [code, f] of cases) {
    const w = clone(curveBuyWire());
    f(w);
    await expectCode(verifySwap(stub(), parseSwapPlan(w, 300), buyReq), code);
  }
});

test("requested slippage is enforced against the SDK's own quote, not the server's", async () => {
  const w = clone(curveBuyWire());
  // The server claims a worse expectedOut so its minOut looks like "3%": still below the SDK's own floor.
  const low = (BigInt(w.quote.expectedOut) * 90n) / 100n, lowMin = minOutFor(low, 300);
  w.quote.expectedOut = low.toString(); w.quote.minOut = lowMin.toString();
  w.steps[0]!.tx.data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [AMOUNT, lowMin, USER] });
  await expectCode(verifySwap(stub(), parseSwapPlan(w, 300), buyReq), "slippage");
});

test("curve sell: approve must target the token's curve for at least the amount", async () => {
  const q = quoteSell(curveState, AMOUNT), minOut = minOutFor(q.out, 300);
  const wire = (spender: Address, approveAmount: bigint, approveTo: Address = TOKEN): WireSwap => ({
    chainId: 99901, route: "curve",
    quote: { token: TOKEN, side: "sell", route: "curve", amountIn: AMOUNT.toString(), expectedOut: q.out.toString(), minOut: minOut.toString(), priceImpactBps: 0,
      fee: "0", tax: "0", priceBefore: "0", priceAfter: "0", graduates: false },
    steps: [
      { kind: "approve", description: "", tx: tx(approveTo, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, approveAmount] }), 0n) as never },
      { kind: "swap", description: "", tx: tx(CURVE, encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "sell", args: [AMOUNT, minOut, USER] }), 0n) as never },
    ],
  });
  const req = { ...buyReq, side: "sell" as const };
  const r = stub();
  const v = await verifySwap(r, parseSwapPlan(wire(CURVE, AMOUNT), 300), req);
  assert.equal(v.steps[1]!.simulated, "deferred", "the sell is simulated after the approval is mined");
  await expectCode(verifySwap(stub(), parseSwapPlan(wire(THIEF, AMOUNT), 300), req), "spender");
  await expectCode(verifySwap(stub(), parseSwapPlan(wire(CURVE, AMOUNT - 1n), 300), req), "amount");
  await expectCode(verifySwap(stub(), parseSwapPlan(wire(CURVE, AMOUNT, THIEF), 300), req), "to");
});

test("pool sell: approve → Permit2.approve → V4_SWAP, and tampering each part", async () => {
  const key = poolKey(TOKEN, D.memeHook);
  const q = quotePool(poolState, "sell", AMOUNT), minOut = minOutFor(q.out, 300);
  const deadline = NOW + 600n;
  const wire = (o: { spender?: Address; p2spender?: Address; swap?: Hex; value?: bigint } = {}): WireSwap => ({
    chainId: 99901, route: "pool",
    quote: { token: TOKEN, side: "sell", route: "pool", amountIn: AMOUNT.toString(), expectedOut: q.out.toString(), minOut: minOut.toString(), priceImpactBps: 0,
      fee: "0", tax: "0", priceBefore: "0", priceAfter: "0", graduates: false },
    steps: [
      { kind: "approve", description: "", tx: tx(TOKEN, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [o.spender ?? D.permit2, AMOUNT] }), 0n) as never },
      { kind: "permit2-approve", description: "", tx: tx(D.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [TOKEN, o.p2spender ?? D.universalRouter, AMOUNT, Number(NOW + 1800n)] }), 0n) as never },
      { kind: "swap", description: "", tx: tx(D.universalRouter, o.swap ?? encodeV4Swap(key, "sell", AMOUNT, minOut, deadline), o.value ?? 0n) as never },
    ],
  });
  const req = { token: TOKEN, side: "sell" as const, amount: AMOUNT, user: USER, slippageBps: 300 };
  await verifySwap(stub("pool"), parseSwapPlan(wire(), 300), req);
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ spender: THIEF }), 300), req), "spender");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ p2spender: THIEF }), 300), req), "spender");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ value: 1n }), 300), req), "value");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ swap: encodeV4Swap({ ...key, hooks: THIEF }, "sell", AMOUNT, minOut, deadline) }), 300), req), "pool_key");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ swap: encodeV4Swap(key, "sell", AMOUNT, minOut, deadline, THIEF) }), 300), req), "recipient");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ swap: encodeV4Swap(key, "sell", AMOUNT, minOut, NOW - 1n) }), 300), req), "deadline");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ swap: encodeV4Swap(key, "sell", AMOUNT, minOut - 1n, deadline) }), 300), req), "min_out");
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire({ swap: encodeV4Swap(key, "buy", AMOUNT, minOut, deadline) }), 300), req), "direction");
});

test("pool sell with a signed permit: signature must recover to the user", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { permitTyped, encodeV4Swap: enc } = await import("../../src/index.ts");
  const me = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil key 0 (public test key)
  const key = poolKey(TOKEN, D.memeHook);
  const q = quotePool(poolState, "sell", AMOUNT), minOut = minOutFor(q.out, 300);
  const permit = { details: { token: TOKEN, amount: AMOUNT, expiration: Number(NOW + 3600n), nonce: 0 }, spender: D.universalRouter, sigDeadline: NOW + 1800n };
  const sign = async (p: typeof permit) => me.signTypedData(permitTyped(p, 99901, D.permit2));
  const wire = (data: Hex) => ({ chainId: 99901, route: "pool", quote: { token: TOKEN, side: "sell", route: "pool", amountIn: AMOUNT.toString(), expectedOut: q.out.toString(),
    minOut: minOut.toString(), priceImpactBps: 0, fee: "0", tax: "0", priceBefore: "0", priceAfter: "0", graduates: false },
    steps: [{ kind: "swap", description: "", tx: { ...tx(D.universalRouter, data, 0n), from: me.address } }] });
  const req = { token: TOKEN, side: "sell" as const, amount: AMOUNT, user: me.address, slippageBps: 300 };
  await verifySwap(stub("pool"), parseSwapPlan(wire(enc(key, "sell", AMOUNT, minOut, NOW + 600n, undefined, { permit, signature: await sign(permit) })) as never, 300), req);
  const evil = { ...permit, spender: THIEF };
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire(enc(key, "sell", AMOUNT, minOut, NOW + 600n, undefined, { permit: evil, signature: await sign(evil) })) as never, 300), req), "spender");
  const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil key 1
  await expectCode(verifySwap(stub("pool"), parseSwapPlan(wire(enc(key, "sell", AMOUNT, minOut, NOW + 600n, undefined, { permit, signature: await other.signTypedData(permitTyped(permit, 99901, D.permit2)) })) as never, 300), req), "permit");
});

test("launch responses: metadata, recipients, value and logo must match the request", async () => {
  const params = { name: "Frog", symbol: "FROG", logo: "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", description: "green",
    socials: { twitter: "https://x.com/frog", telegram: "", discord: "", website: "", farcaster: "" }, creatorFeeRecipient: USER, creatorTaxBps: 100,
    buybackEnabled: true, expectedEconomics: zeroHash, salt: `0x${"11".repeat(32)}` as Hex };
  const buy = 10n ** 18n;
  const expected = 76_048_300_000_000_000_000n; // phantom, from the stub's launch config
  const out = (buy * 99n / 100n) * 10n ** 27n / (expected + buy * 99n / 100n);
  const minOut = minOutFor(out, 300);
  const wire = (p = params, o: { value?: bigint; recipient?: Address; logo?: string; min?: bigint } = {}) => ({
    chainId: 99901, logo: o.logo ?? params.logo,
    steps: [{ kind: "launch", description: "", tx: tx(D.launchAndBuy, encodeFunctionData({ abi: edenLaunchAndBuyAbi, functionName: "launchAndBuy",
      args: [p, 0n, zeroAddress, buy, o.min ?? minOut, o.recipient ?? USER, []] }), o.value ?? 500_000_000_000_000n + buy) }],
  });
  const req = { user: USER, name: " Frog ", symbol: "frog", description: "green", socials: { x: "@frog" }, initialBuy: buy };
  await verifyLaunch(stub(), parseLaunchPlan(wire() as never), req);
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire({ ...params, name: "Fr0g" }) as never), req), "metadata");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire({ ...params, creatorFeeRecipient: THIEF }) as never), req), "recipient");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire({ ...params, creatorTaxBps: 1000 }) as never), req), "metadata");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire(params, { recipient: THIEF }) as never), req), "recipient");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire(params, { value: 2n * buy }) as never), req), "value");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire(params, { min: 1n }) as never), req), "slippage");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire(params, { logo: "https://example.com/x.png" }) as never), req), "logo");
  await expectCode(verifyLaunch(stub(), parseLaunchPlan(wire({ ...params, logo: "ipfs://QmTc2iW6WzStLN16XNsmXKfXfcrNpf4fXpCkhokGbAZvW1" }) as never), req), "metadata");
});

test("claim responses: only the escrow's claim, or the user's own sweep", async () => {
  const CL = [{ kind: "fee_escrow", asset: "HYPE", amount: "100", how: "claim", note: "" }] as never;
  const sweepCurve = { kind: "sweep-fees", description: "", tx: tx(CURVE, encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "sweepFees", args: [0n] }), 0n) };
  const sweepPool = { kind: "sweep-fees", description: "", tx: tx(D.memeHook, encodeFunctionData({ abi: edenMemeHookAbi, functionName: "sweepPoolFees", args: [poolId(poolKey(TOKEN, D.memeHook)), 0n, 0n] }), 0n) };
  const claim = { kind: "claim", description: "", tx: tx(D.feeEscrow, encodeFunctionData({ abi: [edenFeeEscrowAbi.find((x) => x.type === "function" && x.name === "claim" && x.inputs.length === 0)!], functionName: "claim" } as never), 0n) };
  await verifyClaim(stub(), parseClaimPlan({ chainId: 99901, claimable: CL, steps: [claim] as never }), { user: USER });
  await expectCode(verifyClaim(stub(), parseClaimPlan({ chainId: 99901, claimable: CL, steps: [{ ...claim, tx: { ...claim.tx, to: THIEF } }] as never }), { user: USER }), "to");
  await expectCode(verifyClaim(stub(), parseClaimPlan({ chainId: 99901, claimable: CL, steps: [{ ...claim, tx: { ...claim.tx, value: "5" } }] as never }), { user: USER }), "value");
  const transfer = { ...claim, tx: { ...claim.tx, data: `${encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [THIEF, 1n] })}${MARK}` } };
  await expectCode(verifyClaim(stub(), parseClaimPlan({ chainId: 99901, claimable: CL, steps: [transfer] as never }), { user: USER }), "calldata");
  // Sweeps of the user's own curve and pool pass, the claim after them is deferred; someone else's curve does not.
  const r = stub();
  const v = await verifyClaim(r, parseClaimPlan({ chainId: 99901, claimable: CL, steps: [sweepCurve, sweepPool, claim] as never }), { user: USER });
  assert.deepEqual(v.steps.map((x) => x.simulated), [true, "deferred", "deferred"]);
  await expectCode(verifyClaim(stub(), parseClaimPlan({ chainId: 99901, claimable: CL, steps: [{ ...sweepCurve, tx: { ...sweepCurve.tx, to: THIEF } }, claim] as never }), { user: USER }), "to");
  await expectCode(verifyClaim(stub(), parseClaimPlan({ chainId: 99901, claimable: CL, steps: [claim, sweepCurve] as never }), { user: USER }), "unexpected_step");
  const notMine = { ...stub(), hookLaunch: async () => ({ registered: true, memecoin: TOKEN, creator: THIEF }) };
  await expectCode(verifyClaim(notMine, parseClaimPlan({ chainId: 99901, claimable: CL, steps: [sweepPool, claim] as never }), { user: USER }), "recipient");
});
