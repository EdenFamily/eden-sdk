import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData } from "viem";
import {
  EdenApi, EdenApiError, edenBondingCurveAbi, formatHype, imageSize, inspectImage, LaunchQuotaError, minimumOut, minOutFor, normalizeSocials, parseHype,
  parseTokens, percentToBps, quoteBuy, quoteSell, sniffImage, splitMarker, validateLaunchMetadata, ValidationError, type CurveState,
} from "../../src/index.ts";
import { tinyPng } from "../support/env.ts";

test("units: parse/format HYPE and tokens exactly", () => {
  assert.equal(parseHype("1.5"), 1_500_000_000_000_000_000n);
  assert.equal(parseHype(0.1), 100_000_000_000_000_000n);
  assert.equal(formatHype(1_500_000_000_000_000_000n), "1.5");
  assert.equal(parseTokens("1000"), 10n ** 21n);
  assert.throws(() => parseHype("1e5"));
  assert.throws(() => parseHype("0.0000000000000000001"));
  assert.equal(percentToBps(3), 300);
  assert.equal(percentToBps(0.25), 25);
});

test("slippage: minimumOut (percent, website) equals minOutFor (bps)", () => {
  for (const out of [1n, 999n, 123456789012345678901n]) for (const pct of [0.5, 1, 3, 5, 50]) assert.equal(minimumOut(out, pct), minOutFor(out, Math.round(pct * 100)));
});

const s: CurveState = { quote: 76_048_300_000_000_000_000n, tokens: 10n ** 27n, feeBps: 100n, taxBps: 200n, snipeTaxBps: 0n, sellable: 714n * 10n ** 24n };

test("curve math follows the contract: fee and tax floored separately", () => {
  const q = quoteBuy(s, 1_000_000_000_000_000_001n);
  const fee = 1_000_000_000_000_000_001n * 100n / 10_000n, tax = 1_000_000_000_000_000_001n * 200n / 10_000n;
  const net = 1_000_000_000_000_000_001n - fee - tax;
  assert.equal(q.fee, fee);
  assert.equal(q.out, (net * 10_000n * s.tokens) / (s.quote * 10_000n + net * 10_000n));
  const sell = quoteSell(s, 10n ** 24n);
  const gross = (10n ** 24n * 10_000n * s.quote) / (s.tokens * 10_000n + 10n ** 24n * 10_000n);
  assert.equal(sell.out, gross - gross / 100n - (gross * 200n) / 10_000n);
});

test("curve math: the clamped final buy spends less, takes exactly the sellable rest, and graduates", () => {
  const q = quoteBuy({ ...s, sellable: 10n ** 24n }, parseHype("100"));
  assert.equal(q.out, 10n ** 24n);
  assert.ok(q.spent < parseHype("100") && q.refund === parseHype("100") - q.spent && q.graduates);
});

test("curve math: snipe tax is capped so the buyer nets at least 1%", () => {
  const q = quoteBuy({ ...s, snipeTaxBps: 9900n }, parseHype("1"));
  assert.equal(q.snipeTax, parseHype("1") * (10_000n - 100n - 200n - 100n) / 10_000n);
});

test("metadata: the website's rules", () => {
  const m = validateLaunchMetadata({ name: "  Aether  ", symbol: "aeth", description: " hi ", socials: { x: "@aether_x", telegram: "aether_tg", website: "https://aether.xyz" } });
  assert.deepEqual([m.name, m.symbol, m.description, m.creatorFeeBps, m.buyback], ["Aether", "AETH", "hi", 100, true]);
  assert.deepEqual(m.socials, { twitter: "https://x.com/aether_x", telegram: "https://t.me/aether_tg", discord: "", website: "https://aether.xyz", farcaster: "" });
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ name: "", symbol: "A" }, "name"], [{ name: "x".repeat(33), symbol: "A" }, "name"], [{ name: "A", symbol: "" }, "symbol"],
    [{ name: "A", symbol: "$PEPE" }, "symbol"], [{ name: "A", symbol: "ABCDEFGHIJK" }, "symbol"], [{ name: "A", symbol: "A", description: "d".repeat(257) }, "description"],
    [{ name: "A", symbol: "A", socials: { x: "https://evil.com/x" } }, "socials.x"], [{ name: "A", symbol: "A", socials: { website: "ftp://a.b" } }, "socials.website"],
    [{ name: "A", symbol: "A", creatorFeeBps: 1001 }, "creatorFeeBps"], [{ name: "A", symbol: "A", creatorFeeBps: 1.5 }, "creatorFeeBps"],
    [{ name: "A", symbol: "A", bundleWallets: Array(33).fill("0x" + "1".repeat(40)) }, "bundleWallets"],
    [{ name: "A", symbol: "A", initialBuy: 1n, bundleWallets: Array(32).fill("0x" + "1".repeat(40)) }, "bundleWallets"],
    [{ name: "A\u0007", symbol: "A" }, "name"], [{ name: "A", symbol: "A", description: "a\u0000b" }, "description"],
    [{ name: "A", symbol: "A", image: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]) }, "image"], [{ name: "A", symbol: "A", image: "http://insecure/x.png" }, "image"],
  ];
  for (const [input, field] of bad) assert.throws(() => validateLaunchMetadata(input as never), (e: unknown) => e instanceof ValidationError && e.field === field, field);
  assert.equal(validateLaunchMetadata({ name: "x".repeat(32), symbol: "ABCDEFGHIJ" }).name.length, 32);
});

test("images: type from bytes, size limit, dimensions, non-square warning", () => {
  const png = tinyPng(16, 9);
  assert.equal(sniffImage(png), "image/png");
  assert.deepEqual(imageSize(png, "image/png"), { width: 16, height: 9 });
  const m = validateLaunchMetadata({ name: "A", symbol: "A", image: png });
  assert.match(m.warnings[0]!, /16×9.*centred 9×9/);
  assert.throws(() => inspectImage(png, 10), ValidationError);
  const gif = new Uint8Array([...Buffer.from("GIF89a"), 3, 0, 2, 0, 0, 0, 0]);
  assert.deepEqual(inspectImage(gif), { type: "image/gif", bytes: 13, width: 3, height: 2, square: false });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg, "image/jpeg"), { width: 30, height: 20 });
  assert.deepEqual(normalizeSocials({}), { twitter: "", telegram: "", website: "" });
});

test("marker: split only a trailing, word-aligned Eden marker", () => {
  const data = encodeFunctionData({ abi: edenBondingCurveAbi, functionName: "buy", args: [1n, 2n, "0x00000000000000000000000000000000000000a1"] });
  assert.deepEqual(splitMarker(`${data}4544454e0001`), { call: data, marker: "4544454e0001" });
  assert.deepEqual(splitMarker(data), { call: data });
  assert.deepEqual(splitMarker(`${data}004544454e0001`), { call: `${data}004544454e0001` });
});

test("http: error mapping and wire parsing", async () => {
  const fake = (status: number, body: unknown) => async () => ({ ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
  await assert.rejects(new EdenApi({ fetch: fake(404, { error: "token_not_found" }) }).token("0x00000000000000000000000000000000000000a1"),
    (e: unknown) => e instanceof EdenApiError && e.code === "token_not_found" && e.status === 404);
  await assert.rejects(new EdenApi({ fetch: fake(429, { error: "quota:monthly", message: "used all 10" }) }).txLaunch({} as never),
    (e: unknown) => e instanceof LaunchQuotaError && e.scope === "monthly");
  const q = await new EdenApi({ fetch: fake(200, { token: "0x00000000000000000000000000000000000000c3", side: "buy", route: "curve", amountIn: "10", expectedOut: "20",
    minOut: "19", priceImpactBps: 5, fee: "1", tax: "0", priceBefore: "3", priceAfter: "4", graduates: false }) }).quote("0x00000000000000000000000000000000000000c3", "buy", 10n, 300);
  assert.equal(q.minOut, 19n);
  await assert.rejects(new EdenApi({ fetch: fake(200, { token: "0x00000000000000000000000000000000000000c3", amountIn: "1.5" }) }).quote("0x00000000000000000000000000000000000000c3", "buy", 1n, 300),
    (e: unknown) => (e as { code?: string }).code === "bad_response");
});
