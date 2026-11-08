/**
 * A stand-in for Eden's server implementing the developer endpoints' contract (POST /tx/swap, /tx/launch, /tx/claim,
 * /tx/send, GET /tokens/:a/quote, /creators/:a/quota, /uploads/image) honestly, with the SDK's local builders over the
 * local chain. `tamper` rewrites a response before it is sent, to prove that verify() catches a dishonest server.
 * Other GETs are proxied to a real Eden test server when one is up.
 */
import { createServer, type Server } from "node:http";
import { getAddress, parseTransaction, type Address } from "viem";
import {
  buildClaimLocal, buildLaunchLocal, buildSwapLocal, createReader, dataUriBytes, EDEN_CALLDATA_MARKER, inspectImage, jsonBigint, localQuote,
  serializeStep, validateLaunchMetadata,
} from "../../src/index.ts";
import { deployment, PINATA, publicClient, rpc, UPSTREAM_API } from "./env.ts";

export type Tamper = (path: string, body: any) => any;

export type MockApi = { url: string; close(): Promise<void>; tamper?: Tamper; sent: string[]; launches: Map<string, number>; requests: string[] };

const reader = createReader(publicClient, deployment);
const opts = { marker: EDEN_CALLDATA_MARKER, approval: "unlimited" as const };

async function pin(bytes: Uint8Array, type: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), `logo.${type.split("/")[1]}`);
  form.append("network", "public");
  const r = await fetch(`${PINATA}/v3/files`, { method: "POST", headers: { authorization: "Bearer test" }, body: form });
  const j = (await r.json()) as { data: { cid: string } };
  return `ipfs://${j.data.cid}`;
}

export async function startMockApi(): Promise<MockApi> {
  const state: MockApi = { url: "", close: async () => {}, sent: [], launches: new Map(), requests: [] };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    state.requests.push(`${req.method} ${url.pathname}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const send = (status: number, value: unknown) => {
      const body = status === 200 && state.tamper ? state.tamper(url.pathname, JSON.parse(JSON.stringify(value, jsonBigint))) : value;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body, jsonBigint));
    };
    const err = (status: number, error: string, message: string) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error, message })); };
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });
      let m = /^\/creators\/(0x[0-9a-fA-F]{40})\/quota$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const used = state.launches.get(m[1]!.toLowerCase()) ?? 0;
        return send(200, { used, limit: 10, resetsAt: "2026-12-01T00:00:00.000Z", usedToday: used, dailyLimit: 2, dailyResetsAt: "2026-11-09T00:00:00.000Z" });
      }
      m = /^\/tokens\/(0x[0-9a-fA-F]{40})\/quote$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const q = await localQuote(reader, { token: m[1] as Address, side: url.searchParams.get("side") as "buy" | "sell", amount: BigInt(url.searchParams.get("amount")!),
          slippageBps: Number(url.searchParams.get("slippageBps") ?? 300) });
        const { slippageBps: _s, ...wire } = q.quote;
        return send(200, wire);
      }
      if (req.method === "POST" && url.pathname === "/uploads/image") {
        return send(200, { logo: await pin(new Uint8Array(raw), String(req.headers["content-type"])) });
      }
      if (req.method === "POST" && url.pathname.startsWith("/tx/")) {
        const b = JSON.parse(raw.toString("utf8") || "{}");
        if (url.pathname === "/tx/swap") {
          const plan = await buildSwapLocal(reader, { token: b.token, side: b.side, amount: BigInt(b.amount), user: b.user, slippageBps: b.slippageBps ?? 300, recipient: b.recipient }, opts);
          const { slippageBps: _s, ...quote } = plan.quote;
          return send(200, { chainId: plan.chainId, route: plan.route, quote, steps: plan.steps.map(serializeStep) });
        }
        if (url.pathname === "/tx/launch") {
          const user = getAddress(b.user).toLowerCase();
          const used = state.launches.get(user) ?? 0;
          if (used >= 2) return err(429, "quota:daily", "This wallet has used today's 2 launches.");
          const meta = validateLaunchMetadata({ name: b.name, symbol: b.symbol, description: b.description, socials: b.socials, creatorFeeBps: b.creatorTaxBps ?? 100,
            buyback: b.buybackEnabled ?? true, bundleWallets: b.snipeTaxExemptions ?? [], initialBuy: BigInt(b.initialBuy ?? "0") });
          const bytes = dataUriBytes(b.image);
          const info = inspectImage(bytes);
          const logo = await pin(bytes, info.type); // the real server crops to a 1024×1024 PNG first
          const plan = await buildLaunchLocal(reader, { meta, logo, user: getAddress(b.user), initialBuy: BigInt(b.initialBuy ?? "0"),
            creatorFeeRecipient: getAddress(b.creatorFeeRecipient ?? b.user), slippageBps: b.slippageBps ?? 300 }, opts);
          state.launches.set(user, used + 1);
          return send(200, { chainId: plan.chainId, logo, logoUrl: `${PINATA}/ipfs/${logo.slice(7)}`, quota: { used: used + 1, limit: 10 }, steps: plan.steps.map(serializeStep) });
        }
        if (url.pathname === "/tx/claim") {
          const plan = await buildClaimLocal(reader, { user: b.user, token: b.token }, opts);
          return send(200, { chainId: plan.chainId, claimable: plan.claimable.map((c) => ({ ...c, amount: c.amount.toString() })), steps: plan.steps.map(serializeStep) });
        }
        if (url.pathname === "/tx/send") {
          const tx = parseTransaction(b.signedTransaction);
          if (!tx.to) return err(400, "not_eden", "Contract creation is not accepted.");
          state.sent.push(b.signedTransaction);
          const hash = await rpc<string>("eth_sendRawTransaction", [b.signedTransaction]);
          return send(200, { hash, from: (await import("viem")).getAddress((await (await import("viem")).recoverTransactionAddress({ serializedTransaction: b.signedTransaction }))), to: tx.to });
        }
      }
      if (req.method === "GET") {
        const r = await fetch(UPSTREAM_API + url.pathname + url.search).catch(() => undefined);
        if (r) { res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }); return res.end(Buffer.from(await r.arrayBuffer())); }
      }
      err(404, "not_found", `no route ${req.method} ${url.pathname}`);
    } catch (e) {
      err(400, "bad_request", (e as Error).message);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}
