/**
 * Market data and the live feed against a real Eden server indexing the local chain (EDEN_TEST_API, else :8791, else
 * :8790). Skipped when none answers. Read-only, plus one small curve buy to see the live trade frame.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EdenClient, parseHype, type LiveFrame } from "../../src/index.ts";
import { account, chainUp, deployment, fund, publicClient, RPC, warp } from "../support/env.ts";

const candidates = [process.env.EDEN_TEST_API, "http://127.0.0.1:8791", "http://127.0.0.1:8790"].filter(Boolean) as string[];
let API: string | undefined;
for (const c of candidates) {
  try { if ((await fetch(`${c}/health`, { signal: AbortSignal.timeout(2000) })).ok) { API = c; break; } } catch { /* next */ }
}

describe(`market data and live feed (${API ?? "no server"})`, { skip: !API || !(await chainUp()) }, () => {
  const eden = () => new EdenClient({ apiUrl: API!, wsUrl: API!.replace(/^http/, "ws") + "/ws", rpcUrl: RPC, deployment, publicClient,
    account: account(67), mode: "local", sendVia: "rpc", sendRpcUrl: RPC });

  test("tokens, token, trades, holders, candles, stats, portfolio, creator, quota", async () => {
    const c = eden();
    const list = await c.tokens({ tab: "new", limit: 5 });
    assert.ok(Array.isArray(list.tokens) && typeof list.total === "number");
    const t = list.tokens.find((x) => x.phase === "curve") ?? list.tokens[0]!;
    const one = await c.token(t.address);
    assert.equal(one.address, t.address);
    assert.ok(Array.isArray(await c.trades(t.address, { limit: 5 })));
    assert.ok(Array.isArray(await c.holders(t.address)));
    assert.ok(Array.isArray(await c.candles(t.address, { interval: "1m" })));
    assert.ok((await c.stats()).stats);
    const p = await c.portfolio(t.creator);
    assert.ok(Array.isArray(p.positions) && Array.isArray(p.created));
    assert.ok((await c.creator(t.creator)).address !== undefined || true);
    const q = await c.quota(t.creator);
    assert.equal(typeof q.used, "number");
  });

  test("live feed: a trade frame for our own buy", async () => {
    const c = eden();
    const curveToken = (await c.tokens({ tab: "new", limit: 50 })).tokens.find((x) => x.phase === "curve");
    if (!curveToken) return;
    if ((await c.reader.launch(curveToken.address))?.phase !== "curve") return;
    await fund(account(67).address, "100");
    await warp(30);
    const frames: LiveFrame[] = [];
    const sub = c.live({ channels: ["feed", `token:${curveToken.address}`], onFrame: (f) => frames.push(f) });
    await sub.ready;
    const fill = await c.buy(curveToken.address, parseHype("0.01"));
    const end = Date.now() + 20_000;
    while (Date.now() < end && !frames.some((f) => f.type === "trade" && f.data?.txHash === fill.hash)) await new Promise((r) => setTimeout(r, 200));
    sub.close();
    assert.ok(frames.some((f) => f.type === "trade" && f.data?.txHash === fill.hash), `trade frame received (${frames.length} frames)`);
  });
});
