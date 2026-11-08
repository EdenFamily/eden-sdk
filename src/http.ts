/**
 * The Eden HTTP API, in one module: every request, every response shape, and the wire ↔ SDK conversion (decimal wei
 * strings ↔ bigint) live here, so a change in the server's contract is a change in this file only.
 */
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { DEFAULT_API_URL } from "./constants.ts";
import { EdenApiError, EdenError, LaunchQuotaError } from "./errors.ts";
import type {
  Candle, CandleInterval, Claimable, ClaimPlan, Referral, CreatorProfile, Holder, LaunchPlan, LaunchQuota, Portfolio, Quote, Side, Stats, Step, SwapPlan,
  Token, TokenList, TokenListQuery, TopQuery, Trade,
} from "./types.ts";

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string>;
}>;

export type ApiOptions = { baseUrl?: string; fetch?: FetchLike; headers?: Record<string, string>; timeoutMs?: number };

/* ---------- wire shapes (what the server sends: amounts as decimal strings) ---------- */

export type WireStep = { kind: string; description: string; simulated?: boolean; tx: { to: string; data: string; value: string; chainId: number; from: string } };
export type WireQuote = {
  token: string; side: Side; route: "curve" | "pool"; amountIn: string; expectedOut: string; minOut: string; priceImpactBps: number;
  fee: string; tax: string; priceBefore: string; priceAfter: string; graduates: boolean;
  slippageBps?: number; feeAsset?: "HYPE" | "token"; snipeTax?: string; amountSpent?: string; refund?: string; block?: string | number;
};
export type WireSwap = { chainId: number; route: "curve" | "pool"; quote: WireQuote; steps: WireStep[]; referral?: Referral };
export type WireLaunch = {
  chainId: number; logo: string; logoUrl?: string; quota?: LaunchQuota; steps: WireStep[]; launchFee?: string;
  predicted?: { token: string; curve: string; initialBuyTokensOut?: string; minTokensOut?: string };
};
export type WireClaimable = { kind: Claimable["kind"]; token?: string; asset: "HYPE"; amount: string; how: Claimable["how"]; note: string };
export type WireClaim = { chainId: number; claimable: WireClaimable[]; steps: WireStep[] };
/** POST /tx/launch body, exactly the server's (strict) schema. */
export type WireLaunchRequest = {
  user: Address; name: string; symbol: string; description: string; image: string;
  socials: { x?: string; telegram?: string; website?: string }; initialBuy: string; creatorFeeRecipient?: Address;
  creatorTaxBps: number; buybackEnabled: boolean; slippageBps: number; snipeTaxExemptions: Address[];
};

const big = (v: unknown, field: string): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  throw new EdenError("bad_response", `The API sent ${field} = ${JSON.stringify(v)}, not a wei amount.`);
};
const addr = (v: unknown, field: string): Address => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new EdenError("bad_response", `The API sent ${field} = ${JSON.stringify(v)}, not an address.`);
  return getAddress(v);
};

/** Wire step → Step. Shape errors throw here; the meaning of each step is checked by verify(). */
export function parseStep(s: WireStep, i: number): Step {
  if (!s || typeof s !== "object" || !s.tx) throw new EdenError("bad_response", `Step ${i} has no tx.`);
  if (typeof s.tx.data !== "string" || !isHex(s.tx.data)) throw new EdenError("bad_response", `Step ${i} data is not hex.`);
  return {
    kind: s.kind as Step["kind"],
    description: String(s.description ?? ""),
    ...(typeof s.simulated === "boolean" ? { simulated: s.simulated } : {}),
    tx: { to: addr(s.tx.to, `steps[${i}].tx.to`), data: s.tx.data.toLowerCase() as Hex, value: big(s.tx.value ?? "0", `steps[${i}].tx.value`),
      chainId: Number(s.tx.chainId), from: addr(s.tx.from, `steps[${i}].tx.from`) },
  };
}

export function parseQuote(q: WireQuote, slippageBps: number): Quote {
  return {
    token: addr(q.token, "quote.token"), side: q.side, route: q.route,
    amountIn: big(q.amountIn, "quote.amountIn"), expectedOut: big(q.expectedOut, "quote.expectedOut"), minOut: big(q.minOut, "quote.minOut"),
    slippageBps, priceImpactBps: Number(q.priceImpactBps), fee: big(q.fee, "quote.fee"), tax: big(q.tax, "quote.tax"),
    priceBefore: big(q.priceBefore, "quote.priceBefore"), priceAfter: big(q.priceAfter, "quote.priceAfter"), graduates: Boolean(q.graduates),
    ...(q.amountSpent !== undefined ? { amountSpent: big(q.amountSpent, "quote.amountSpent") } : {}),
    ...(q.refund !== undefined ? { refund: big(q.refund, "quote.refund") } : {}),
    ...(q.snipeTax !== undefined ? { snipeTax: big(q.snipeTax, "quote.snipeTax") } : {}),
    ...(q.feeAsset ? { feeAsset: q.feeAsset } : {}),
    ...(q.block !== undefined ? { block: big(q.block, "quote.block") } : {}),
  };
}

export const parseSwapPlan = (w: WireSwap, slippageBps: number): SwapPlan =>
  ({ chainId: Number(w.chainId), route: w.route, quote: parseQuote(w.quote, slippageBps), steps: (w.steps ?? []).map(parseStep), ...(w.referral ? { referral: w.referral } : {}) });
export const parseLaunchPlan = (w: WireLaunch): LaunchPlan => ({
  chainId: Number(w.chainId), logo: String(w.logo), logoUrl: w.logoUrl, quota: w.quota, steps: (w.steps ?? []).map(parseStep),
  ...(w.launchFee !== undefined ? { launchFee: big(w.launchFee, "launchFee") } : {}),
  ...(w.predicted ? { predicted: { token: addr(w.predicted.token, "predicted.token"), curve: addr(w.predicted.curve, "predicted.curve"),
    ...(w.predicted.initialBuyTokensOut !== undefined ? { initialBuyTokensOut: big(w.predicted.initialBuyTokensOut, "predicted.initialBuyTokensOut") } : {}),
    ...(w.predicted.minTokensOut !== undefined ? { minTokensOut: big(w.predicted.minTokensOut, "predicted.minTokensOut") } : {}) } } : {}),
});
export const parseClaimable = (c: WireClaimable): Claimable => ({
  kind: c.kind, ...(c.token ? { token: addr(c.token, "claimable.token") } : {}), asset: c.asset, amount: big(c.amount, "claimable.amount"), how: c.how, note: String(c.note ?? ""),
});
export const parseClaimPlan = (w: WireClaim): ClaimPlan => {
  if (!Array.isArray(w.claimable)) throw new EdenError("bad_response", "claimable is not a list.");
  return { chainId: Number(w.chainId), claimable: w.claimable.map(parseClaimable), steps: (w.steps ?? []).map(parseStep) };
};

/** Step → wire (for logging, or handing a plan to another process). */
export function serializeStep(s: Step): WireStep {
  return { kind: s.kind, description: s.description, ...(s.simulated !== undefined ? { simulated: s.simulated } : {}), tx: { to: s.tx.to, data: s.tx.data, value: s.tx.value.toString(), chainId: s.tx.chainId, from: s.tx.from } };
}

/** JSON.stringify replacer that writes bigints as decimal strings. */
export const jsonBigint = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

/* ---------- the client ---------- */

export class EdenApi {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: ApiOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.headers = { accept: "application/json", "user-agent": "eden-sdk-ts/0.1.0", ...options.headers };
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, contentType = "application/json"): Promise<T> {
    const headers: Record<string, string> = { ...this.headers };
    let payload: string | Uint8Array | undefined;
    if (body !== undefined) {
      headers["content-type"] = contentType;
      payload = body instanceof Uint8Array ? body : JSON.stringify(body, jsonBigint);
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (cause) {
      throw new EdenError("network", `Could not reach the Eden API at ${this.baseUrl}${path}: ${(cause as Error).message}`, { path }, { cause });
    }
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; message?: string; resetsAt?: string };
      const code = typeof d.error === "string" ? d.error : `http_${res.status}`;
      const message = typeof d.message === "string" ? d.message : `The Eden API answered ${res.status} for ${method} ${path}.`;
      if (res.status === 429 && (code === "quota:daily" || code === "quota:monthly")) {
        throw new LaunchQuotaError(code === "quota:daily" ? "daily" : "monthly", message, d.resetsAt);
      }
      throw new EdenApiError(res.status, code, message, path, d as Record<string, unknown>);
    }
    return data as T;
  }

  get<T>(path: string): Promise<T> { return this.request<T>("GET", path); }
  post<T>(path: string, body: unknown): Promise<T> { return this.request<T>("POST", path, body); }

  /* market data */
  tokens(q: TokenListQuery = {}): Promise<TokenList> {
    const p = new URLSearchParams();
    const set = (k: string, v: unknown) => { if (v !== undefined && v !== null) p.set(k, String(v)); };
    set("tab", q.tab); set("q", q.q); set("sort", q.sort); set("dir", q.dir); set("limit", q.limit); set("offset", q.offset);
    set("min_mcap_usd", q.minMcapUsd); set("max_mcap_usd", q.maxMcapUsd); set("max_age_hours", q.maxAgeHours);
    set("minVolume24h", q.minVolume24h); set("minHolders", q.minHolders); set("verifiedOnly", q.verifiedOnly); set("creator", q.creator?.toLowerCase());
    set("graduatedWithinHours", q.graduatedWithinHours);
    return this.get(`/tokens${p.size ? `?${p}` : ""}`);
  }
  top(q: TopQuery = {}): Promise<TokenList> {
    const p = new URLSearchParams({ by: q.by ?? "volume", window: q.window ?? "24h", limit: String(q.limit ?? 20) });
    return this.get(`/tokens/top?${p}`);
  }
  token(address: Address): Promise<{ token: Token; hypeUsd: number | null }> { return this.get(`/tokens/${address.toLowerCase()}`); }
  candles(address: Address, q: { interval?: CandleInterval; from?: Date; to?: Date } = {}): Promise<{ interval: string; candles: Candle[] }> {
    const p = new URLSearchParams({ interval: q.interval ?? "1m" });
    if (q.from) p.set("from", q.from.toISOString());
    if (q.to) p.set("to", q.to.toISOString());
    return this.get(`/tokens/${address.toLowerCase()}/candles?${p}`);
  }
  trades(address: Address, q: { limit?: number; before?: Date } = {}): Promise<{ trades: Trade[] }> {
    const p = new URLSearchParams({ limit: String(q.limit ?? 50) });
    if (q.before) p.set("before", q.before.toISOString());
    return this.get(`/tokens/${address.toLowerCase()}/trades?${p}`);
  }
  holders(address: Address, q: { limit?: number } = {}): Promise<{ holders: Holder[] }> {
    return this.get(`/tokens/${address.toLowerCase()}/holders?limit=${q.limit ?? 100}`);
  }
  portfolio(wallet: Address): Promise<Portfolio> { return this.get(`/wallets/${wallet.toLowerCase()}/portfolio`); }
  walletTrades(wallet: Address, q: { limit?: number; before?: Date } = {}): Promise<{ trades: Trade[] }> {
    const p = new URLSearchParams({ limit: String(q.limit ?? 50) });
    if (q.before) p.set("before", q.before.toISOString());
    return this.get(`/wallets/${wallet.toLowerCase()}/trades?${p}`);
  }
  creator(address: Address): Promise<CreatorProfile> { return this.get(`/creators/${address.toLowerCase()}`); }
  quota(address: Address): Promise<LaunchQuota> { return this.get(`/creators/${address.toLowerCase()}/quota`); }
  stats(): Promise<Stats> { return this.get("/stats"); }
  openapi(): Promise<Record<string, unknown>> { return this.get("/openapi.json"); }
  referral(wallet: Address): Promise<{ referral: Record<string, unknown> }> { return this.get(`/referrals/${wallet.toLowerCase()}`); }

  /* quotes and transaction building */
  /** `user`: the buyer (the snipe tax in a launch's first seconds depends on who receives the tokens). */
  async quote(token: Address, side: Side, amount: bigint, slippageBps: number, user?: Address): Promise<Quote> {
    const p = new URLSearchParams({ side, amount: amount.toString(), slippageBps: String(slippageBps) });
    if (user) p.set("user", user);
    return parseQuote(await this.get<WireQuote>(`/tokens/${token.toLowerCase()}/quote?${p}`), slippageBps);
  }
  /** POST /tx/swap, raw wire response (call parseSwapPlan, then verify). */
  /** POST /tx/swap. `minOut` overrides slippage; `referrer` is an address or a referral code. */
  txSwap(body: { token: Address; side: Side; amount: bigint; user: Address; slippageBps: number; recipient?: Address; referrer?: string; minOut?: bigint }): Promise<WireSwap> {
    return this.post("/tx/swap", body);
  }
  txLaunch(body: WireLaunchRequest): Promise<WireLaunch> { return this.post("/tx/launch", body); }
  txClaim(body: { user: Address; token?: Address }): Promise<WireClaim> { return this.post("/tx/claim", body); }
  /** Broadcasts a signed transaction through Eden (only transactions to Eden's contracts are accepted). */
  async txSend(signedTransaction: Hex): Promise<{ hash: Hex; from?: Address; to?: Address }> {
    const r = await this.post<{ hash: Hex; from?: string; to?: string }>("/tx/send", { signedTransaction });
    if (!r || typeof r.hash !== "string" || !isHex(r.hash) || r.hash.length !== 66) throw new EdenError("bad_response", "POST /tx/send did not return a transaction hash.");
    return { hash: r.hash, ...(r.from ? { from: addr(r.from, "from") } : {}), ...(r.to ? { to: addr(r.to, "to") } : {}) };
  }
  /** POST /uploads/image: pins an image (PNG, JPEG or GIF, at most 4 MB, sent unchanged) and returns ipfs://<cid>. */
  async uploadImage(bytes: Uint8Array, contentType: "image/png" | "image/jpeg" | "image/gif"): Promise<string> {
    const r = await this.request<{ logo: string }>("POST", "/uploads/image", bytes, contentType);
    if (!r?.logo?.startsWith("ipfs://")) throw new EdenError("bad_response", "POST /uploads/image did not return an ipfs:// logo.");
    return r.logo;
  }
}

/** ipfs://<cid> → an https gateway URL (Eden's image cache by default). */
export function ipfsToHttp(uri: string, gateway = `${DEFAULT_API_URL}/images/ipfs/`): string {
  return uri.startsWith("ipfs://") ? gateway + uri.slice(7) : uri;
}
