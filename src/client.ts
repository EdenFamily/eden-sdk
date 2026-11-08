import { createPublicClient, getAddress, http, type Account, type Address, type PublicClient, type WalletClient } from "viem";
import {
  buildClaimLocal, buildGraduateLocal, buildLaunchLocal, buildSwapLocal, checkSlippage, localQuote, type BuildOptions,
} from "./build.ts";
import { createReader, poolIdOf, poolKeyFor, type EdenReader } from "./chain.ts";
import { DEFAULT_API_URL, DEFAULT_RPC_URL, DEFAULT_WS_URL, EDEN_CALLDATA_MARKER } from "./constants.ts";
import { elysiumChain, MAINNET, type Deployment } from "./deployment.ts";
import { ConfigError, EdenError, LaunchQuotaError, ValidationError } from "./errors.ts";
import { EdenApi, parseClaimPlan, parseLaunchPlan, parseSwapPlan, type FetchLike } from "./http.ts";
import { subscribeLive, type LiveOptions, type LiveSubscription } from "./live.ts";
import { bytesToDataUri, CREATOR_FEE_BPS_OPTIONS, IPFS_LOGO, UPLOAD_MAX_BYTES, validateLaunchMetadata, dataUriBytes, inspectImage, type NormalizedMetadata } from "./metadata.ts";
import { claimEvents, curveTrade, graduationEvents, launchEvents, poolTrade } from "./receipts.ts";
import { executeSteps, type Sender } from "./send.ts";
import type {
  CandleInterval, ClaimPlan, ClaimRequest, ClaimResult, GraduatePlan, GraduateRequest, GraduateResult, LaunchPlan, LaunchRequest, LaunchResult,
  Quote, Side, SwapPlan, SwapRequest, TokenListQuery, TopQuery, TradeResult,
} from "./types.ts";
import { verifyClaim, verifyGraduate, verifyLaunch, verifySwap, verify as verifyAny, type VerifyAction, type VerifyOptions, type Verified } from "./verify.ts";

export type Mode = "api" | "local";

export type EdenClientOptions = {
  /** Eden API base (default https://edenfamily.xyz/api). */
  apiUrl?: string;
  /** Live feed URL (default wss://edenfamily.xyz/ws). */
  wsUrl?: string;
  /** RPC for reads, simulation, gas and receipts (default Elysium's public RPC). */
  rpcUrl?: string;
  chainId?: number;
  /** Contract addresses (default: Eden on Elysium mainnet). Use loadDeployment() for another chain. */
  deployment?: Deployment;
  /** The signer for writes: a viem LocalAccount (privateKeyToAccount / mnemonicToAccount). Keys never leave it. */
  account?: Account;
  /** Or a wallet client that signs and broadcasts itself (browser wallets). */
  walletClient?: WalletClient;
  /** "api" (default): build with POST /tx/*, then verify locally. "local": build from chain reads only. Both verify. */
  mode?: Mode;
  /** "api" (default): broadcast through POST /tx/send. "rpc": eth_sendRawTransaction on sendRpcUrl. */
  sendVia?: "api" | "rpc";
  /** RPC that accepts transaction sends (required for sendVia "rpc"). */
  sendRpcUrl?: string;
  /** Default slippage in bps (default 300 = 3%). */
  slippageBps?: number;
  /** Refuse slippage above 50% unless true (default false). */
  allowHighSlippage?: boolean;
  /** Calldata marker for locally built transactions (default Eden's 4544454e0001; false for none). */
  marker?: string | false;
  /** Token approvals in local mode: "unlimited" (default, as the website and the API) or "exact". */
  approval?: "exact" | "unlimited";
  /** Local-mode pool sells: "approve" (default) sends Permit2.approve on chain; "signature" signs a Permit2 permit into the swap (website flow). */
  permit2?: "approve" | "signature";
  /** Local-mode launches check the creator's quota through the API; set true to skip when the API is unreachable. */
  skipQuotaCheck?: boolean;
  fetch?: FetchLike;
  publicClient?: PublicClient;
  onStep?: Sender["onStep"];
};

type WriteOptions = { slippageBps?: number; recipient?: Address; referrer?: Address; mode?: Mode };

/**
 * The Eden SDK. Reads come from the Eden API and the chain; every write is built (API or local mode), verified against
 * your request and independent chain reads, simulated, signed locally, sent, and confirmed with decoded results.
 */
export class EdenClient {
  readonly api: EdenApi;
  readonly publicClient: PublicClient;
  readonly reader: EdenReader;
  readonly deployment: Deployment;
  readonly chainId: number;
  readonly mode: Mode;
  readonly slippageBps: number;
  private readonly o: EdenClientOptions;
  private readonly sendClient?: PublicClient;

  constructor(options: EdenClientOptions = {}) {
    this.o = options;
    this.deployment = options.deployment ?? MAINNET;
    this.chainId = options.chainId ?? this.deployment.chainId;
    if (this.deployment.chainId !== this.chainId) throw new ConfigError(`The deployment is for chain ${this.deployment.chainId}, the client for ${this.chainId}.`);
    this.mode = options.mode ?? "api";
    this.slippageBps = checkSlippage(options.slippageBps, options.allowHighSlippage);
    this.api = new EdenApi({ baseUrl: options.apiUrl ?? DEFAULT_API_URL, fetch: options.fetch });
    const rpc = options.rpcUrl ?? DEFAULT_RPC_URL;
    this.publicClient = options.publicClient ?? (createPublicClient({ chain: elysiumChain(rpc, this.chainId), transport: http(rpc, { retryCount: 3, timeout: 30_000 }), pollingInterval: 500 }) as PublicClient);
    this.reader = createReader(this.publicClient, this.deployment);
    if (options.sendRpcUrl) this.sendClient = createPublicClient({ chain: elysiumChain(options.sendRpcUrl, this.chainId), transport: http(options.sendRpcUrl) }) as PublicClient;
    if ((options.sendVia ?? "api") === "rpc" && !options.sendRpcUrl) throw new ConfigError("sendVia \"rpc\" needs sendRpcUrl (an RPC that accepts eth_sendRawTransaction).");
  }

  /** The signing wallet's address. */
  get address(): Address | undefined {
    return this.o.account?.address ?? this.o.walletClient?.account?.address;
  }
  private user(): Address {
    const a = this.address;
    if (!a) throw new ConfigError("This needs a wallet: pass `account` (e.g. privateKeyToAccount(process.env.EDEN_PRIVATE_KEY)) to new EdenClient().");
    return getAddress(a);
  }
  private buildOptions(): BuildOptions {
    const acct = this.o.account as { signTypedData?: (t: unknown) => Promise<`0x${string}`> } | undefined;
    const signPermit = this.o.permit2 === "signature"
      ? (typed: unknown) => {
        if (acct?.signTypedData) return acct.signTypedData(typed);
        if (this.o.walletClient?.account) return this.o.walletClient.signTypedData({ account: this.o.walletClient.account, ...(typed as any) });
        throw new ConfigError("permit2 \"signature\" needs an account that signs typed data.");
      }
      : undefined;
    return { marker: this.o.marker === undefined ? EDEN_CALLDATA_MARKER : this.o.marker, approval: this.o.approval ?? "unlimited", signPermit };
  }
  private verifyOptions(): VerifyOptions {
    return { allowHighSlippage: this.o.allowHighSlippage };
  }
  private sender(): Sender {
    return { publicClient: this.publicClient, reader: this.reader, via: this.o.sendVia ?? "api", api: this.api, sendClient: this.sendClient,
      account: this.o.account, walletClient: this.o.walletClient, onStep: this.o.onStep };
  }

  /* ============================================================ market data */

  tokens(q: TokenListQuery = {}) { return this.api.tokens(q); }
  top(q: TopQuery = {}) { return this.api.top(q); }
  async token(address: Address) { return (await this.api.token(address)).token; }
  async candles(address: Address, q: { interval?: CandleInterval; from?: Date; to?: Date } = {}) { return (await this.api.candles(address, q)).candles; }
  async trades(address: Address, q: { limit?: number; before?: Date } = {}) { return (await this.api.trades(address, q)).trades; }
  async holders(address: Address, q: { limit?: number } = {}) { return (await this.api.holders(address, q)).holders; }
  portfolio(wallet: Address) { return this.api.portfolio(wallet); }
  async walletTrades(wallet: Address, q: { limit?: number; before?: Date } = {}) { return (await this.api.walletTrades(wallet, q)).trades; }
  creator(address: Address) { return this.api.creator(address); }
  quota(address: Address) { return this.api.quota(address); }
  stats() { return this.api.stats(); }

  /** HYPE balance and (optionally) a token balance, read on chain. */
  async balances(owner: Address, token?: Address): Promise<{ hype: bigint; token?: bigint }> {
    const [hype, t] = await Promise.all([this.reader.balance(owner), token ? this.reader.balance(owner, token) : Promise.resolve(undefined)]);
    return { hype, token: t };
  }

  /** Subscribes to the live feed. Channels: "feed", "token:<address>", "wallet:<address>". */
  live(options: Omit<LiveOptions, "url"> & { url?: string }): LiveSubscription {
    return subscribeLive({ url: this.o.wsUrl ?? DEFAULT_WS_URL, ...options });
  }

  /* ============================================================ quotes */

  /**
   * A quote: from GET /tokens/:a/quote in API mode, from chain state in local mode (`localQuote` always reads the
   * chain; verify() uses it). `amount` is HYPE wei for a buy, token units for a sell.
   */
  async quote(token: Address, side: Side, amount: bigint, o: { slippageBps?: number; mode?: Mode; recipient?: Address } = {}): Promise<Quote> {
    const slippageBps = checkSlippage(o.slippageBps ?? this.slippageBps, this.o.allowHighSlippage);
    if ((o.mode ?? this.mode) === "api") return this.api.quote(getAddress(token), side, amount, slippageBps, o.recipient ?? this.address);
    return (await localQuote(this.reader, { token, side, amount, slippageBps, recipient: o.recipient ?? this.address, user: this.address })).quote;
  }

  /* ============================================================ build (unverified plans) */

  /** Builds a swap plan without verifying it. Call verify() before signing, or use buy()/sell(). */
  async buildSwap(request: SwapRequest, o: { mode?: Mode } = {}): Promise<SwapPlan> {
    const req = this.normalizeSwap(request);
    if ((o.mode ?? this.mode) === "local") return buildSwapLocal(this.reader, req, this.buildOptions());
    const wire = await this.api.txSwap({ token: req.token, side: req.side, amount: req.amount, user: req.user, slippageBps: req.slippageBps!,
      ...(req.recipient ? { recipient: req.recipient } : {}), ...(req.referrer ? { referrer: req.referrer } : {}) });
    return parseSwapPlan(wire, req.slippageBps!);
  }
  buildBuy(token: Address, hypeWei: bigint, o: WriteOptions = {}) {
    return this.buildSwap({ token, side: "buy", amount: hypeWei, user: this.user(), slippageBps: o.slippageBps, recipient: o.recipient, referrer: o.referrer }, o);
  }
  buildSell(token: Address, tokenUnits: bigint, o: WriteOptions = {}) {
    return this.buildSwap({ token, side: "sell", amount: tokenUnits, user: this.user(), slippageBps: o.slippageBps, recipient: o.recipient, referrer: o.referrer }, o);
  }

  /** Validates the metadata and builds the launch plan (API: POST /tx/launch; local: chain reads + your ipfs:// logo). */
  async buildLaunch(request: LaunchRequest, o: { mode?: Mode } = {}): Promise<{ plan: LaunchPlan; meta: NormalizedMetadata; request: LaunchRequest }> {
    const user = getAddress(request.user);
    const meta = validateLaunchMetadata({ ...request, initialBuy: request.initialBuy });
    const slippageBps = checkSlippage(request.slippageBps ?? this.slippageBps, this.o.allowHighSlippage);
    const initialBuy = request.initialBuy ?? 0n;
    if (initialBuy < 0n) throw new ValidationError("initialBuy", "initialBuy must not be negative.");
    const creatorFeeRecipient = getAddress(request.creatorFeeRecipient ?? user);
    const full: LaunchRequest = { ...request, user, name: meta.name, symbol: meta.symbol, description: meta.description,
      socials: { x: meta.socials.twitter, telegram: meta.socials.telegram, website: meta.socials.website }, creatorFeeBps: meta.creatorFeeBps,
      buyback: meta.buyback, bundleWallets: meta.bundleWallets, initialBuy, creatorFeeRecipient, slippageBps };
    if ((o.mode ?? this.mode) === "api") {
      if (request.image === undefined) {
        throw new ValidationError("image", request.logo
          ? "API mode takes an image (bytes, a data: URI or an https URL) and pins it itself; to launch with an already pinned ipfs:// logo, use mode \"local\"."
          : "Add an image: bytes, a data: URI or an https URL.");
      }
      if (!(CREATOR_FEE_BPS_OPTIONS as readonly number[]).includes(meta.creatorFeeBps)) {
        throw new ValidationError("creatorFeeBps", `Eden's API takes the website's creator fees: ${CREATOR_FEE_BPS_OPTIONS.join(", ")} bps. Use mode "local" for other values up to 1000.`);
      }
      if (meta.bundleWallets.length > 31) throw new ValidationError("bundleWallets", "Eden's API takes up to 31 bundle wallets; use mode \"local\" for 32.");
      const image = request.image instanceof Uint8Array ? bytesToDataUri(request.image, meta.image!.type) : request.image;
      const socials = Object.fromEntries(Object.entries({ x: meta.socials.twitter, telegram: meta.socials.telegram, website: meta.socials.website }).filter(([, v]) => v));
      const wire = await this.api.txLaunch({ user, name: meta.name, symbol: meta.symbol, description: meta.description, image, socials,
        initialBuy: initialBuy.toString(), creatorFeeRecipient, creatorTaxBps: meta.creatorFeeBps, buybackEnabled: meta.buyback,
        slippageBps, snipeTaxExemptions: meta.bundleWallets });
      const plan = parseLaunchPlan(wire);
      return { plan, meta, request: { ...full, logo: undefined } };
    }
    await this.checkQuota(user);
    let logo = request.logo;
    if (!logo) {
      if (request.image === undefined) throw new ValidationError("logo", "Local mode needs `logo` (an ipfs:// URI) or image bytes to upload.");
      if (typeof request.image === "string" && !request.image.startsWith("data:")) {
        throw new ValidationError("image", "Local mode cannot fetch an image URL; pass the bytes, a data: URI, or a pinned ipfs:// logo.");
      }
      const bytes = typeof request.image === "string" ? dataUriBytes(request.image) : request.image;
      const info = inspectImage(bytes, UPLOAD_MAX_BYTES);
      logo = await this.api.uploadImage(bytes, info.type);
    }
    if (!IPFS_LOGO.test(logo)) throw new ValidationError("logo", `"${logo}" is not an ipfs:// CID.`);
    const plan = await buildLaunchLocal(this.reader, { meta, logo, user, initialBuy, creatorFeeRecipient, slippageBps }, this.buildOptions());
    return { plan, meta, request: { ...full, logo } };
  }

  async buildClaim(request: Partial<ClaimRequest> = {}, o: { mode?: Mode } = {}): Promise<ClaimPlan> {
    const req: ClaimRequest = { user: getAddress(request.user ?? this.user()), ...(request.token ? { token: getAddress(request.token) } : {}) };
    if ((o.mode ?? this.mode) === "local") return buildClaimLocal(this.reader, req, this.buildOptions());
    return parseClaimPlan(await this.api.txClaim(req));
  }

  /** Graduation steps are always built locally (the factory's graduate / createGraduatedPool are permissionless). */
  buildGraduate(token: Address): Promise<GraduatePlan> {
    return buildGraduateLocal(this.reader, { user: this.user(), token: getAddress(token) }, this.buildOptions());
  }

  /* ============================================================ verify */

  /** Verifies a plan (from the API or anywhere) against its request. Throws VerificationError on any mismatch. */
  verify(v: VerifyAction, options: VerifyOptions = {}): Promise<Verified<unknown>> {
    return verifyAny(this.reader, v, { ...this.verifyOptions(), ...options });
  }

  /* ============================================================ writes */

  /** Buys `token` with `hypeWei` HYPE. Builds, verifies, simulates, signs, sends, confirms; returns the decoded fill. */
  buy(token: Address, hypeWei: bigint, o: WriteOptions = {}): Promise<TradeResult> {
    return this.swap({ token, side: "buy", amount: hypeWei, user: this.user(), slippageBps: o.slippageBps, recipient: o.recipient, referrer: o.referrer }, o);
  }
  /** Sells `tokenUnits` of `token` for HYPE. */
  sell(token: Address, tokenUnits: bigint, o: WriteOptions = {}): Promise<TradeResult> {
    return this.swap({ token, side: "sell", amount: tokenUnits, user: this.user(), slippageBps: o.slippageBps, recipient: o.recipient, referrer: o.referrer }, o);
  }

  async swap(request: SwapRequest, o: { mode?: Mode } = {}): Promise<TradeResult> {
    const req = this.normalizeSwap(request);
    if (!this.address || getAddress(this.address) !== req.user) throw new ConfigError("The swap's user must be the client's account.");
    const plan = await this.buildSwap(req, o);
    await verifySwap(this.reader, plan, req, this.verifyOptions());
    return this.executeSwap(plan, req);
  }

  /** Sends an already verified swap plan and decodes the result. Re-verifies first. */
  async executeSwap(plan: SwapPlan, request: SwapRequest): Promise<TradeResult> {
    const req = this.normalizeSwap(request);
    await verifySwap(this.reader, plan, req, { ...this.verifyOptions(), simulate: false });
    const receipts = await executeSteps(plan.steps, this.sender());
    const receipt = receipts[receipts.length - 1]!;
    const recipient = req.recipient ?? req.user;
    const base = { hash: receipt.transactionHash, hashes: receipts.map((r) => r.transactionHash), token: req.token, side: req.side, route: plan.route,
      expectedOut: plan.quote.expectedOut, minOut: plan.quote.minOut, receipt };
    if (plan.route === "curve") {
      const launch = (await this.reader.launch(req.token))!;
      const t = curveTrade(receipt, launch.curve, req.side);
      return { ...base, amountIn: t.amountIn, amountOut: t.amountOut, fee: t.fee, tax: t.tax, feeCurrency: "HYPE", graduated: t.graduated };
    }
    const t = poolTrade(receipt, this.deployment, poolIdOf(poolKeyFor(req.token, this.deployment)), req.token, req.side, recipient);
    return { ...base, amountIn: t.amountIn, amountOut: t.amountOut, fee: t.fee, tax: t.tax, feeCurrency: t.feeCurrency, graduated: false };
  }

  /**
   * Launches a token. API mode: POST /tx/launch crops the image to a centred 1024×1024 PNG and pins it. Local mode:
   * pass `logo` (ipfs://) or image bytes (uploaded unchanged). Respects the launch limits: a LaunchQuotaError means
   * wait until the reset; do not retry.
   */
  async launch(request: Omit<LaunchRequest, "user"> & { user?: Address }, o: { mode?: Mode } = {}): Promise<LaunchResult & { warnings: string[] }> {
    const user = this.user();
    if (request.user && getAddress(request.user) !== user) throw new ConfigError("The launch's user must be the client's account.");
    const { plan, meta, request: full } = await this.buildLaunch({ ...request, user }, o);
    await verifyLaunch(this.reader, plan, full, this.verifyOptions());
    const receipts = await executeSteps(plan.steps, this.sender());
    const receipt = receipts[0]!;
    const e = launchEvents(receipt, this.deployment);
    return { hash: receipt.transactionHash, token: e.token, curve: e.curve, logo: plan.logo, initialBuy: e.initialBuy, receipt, warnings: meta.warnings };
  }

  /** Claims the creator fees waiting in the fee escrow (and sweeps `token`'s pending fees into it first when allowed). */
  async claimFees(o: { token?: Address; mode?: Mode } = {}): Promise<ClaimResult> {
    const user = this.user();
    const req: ClaimRequest = { user, ...(o.token ? { token: getAddress(o.token) } : {}) };
    const plan = await this.buildClaim(req, o);
    await verifyClaim(this.reader, plan, req, this.verifyOptions());
    if (plan.steps.length === 0) return { hashes: [], claimed: 0n, claimedTokens: [], swept: 0n, receipts: [] };
    const receipts = await executeSteps(plan.steps, this.sender());
    const e = claimEvents(receipts, this.deployment, user);
    return { hashes: receipts.map((r) => r.transactionHash), ...e, receipts };
  }

  /** Graduates a sold-out curve and/or creates its Uniswap v4 pool (permissionless; anyone may call). */
  async graduate(token: Address): Promise<GraduateResult> {
    const req: GraduateRequest = { user: this.user(), token: getAddress(token) };
    const plan = await this.buildGraduate(req.token);
    await verifyGraduate(this.reader, plan, req, this.verifyOptions());
    const receipts = await executeSteps(plan.steps, this.sender());
    return { hashes: receipts.map((r) => r.transactionHash), poolId: poolIdOf(poolKeyFor(req.token, this.deployment)), ...graduationEvents(receipts, this.deployment), receipts };
  }

  /* ============================================================ helpers */

  private normalizeSwap(r: SwapRequest): SwapRequest {
    if (r.side !== "buy" && r.side !== "sell") throw new EdenError("invalid:side", `side must be "buy" or "sell", got ${String(r.side)}.`);
    if (typeof r.amount !== "bigint" || r.amount <= 0n) throw new EdenError("invalid:amount", "amount must be a bigint greater than zero (wei / token units; see parseHype, parseTokens).");
    return {
      token: getAddress(r.token), side: r.side, amount: r.amount, user: getAddress(r.user),
      slippageBps: checkSlippage(r.slippageBps ?? this.slippageBps, this.o.allowHighSlippage),
      ...(r.recipient ? { recipient: getAddress(r.recipient) } : {}), ...(r.referrer ? { referrer: getAddress(r.referrer) } : {}),
    };
  }

  private async checkQuota(user: Address): Promise<void> {
    let q;
    try {
      q = await this.api.quota(user);
    } catch (e) {
      if (this.o.skipQuotaCheck) return;
      throw new EdenError("quota_unknown", `Could not read the launch quota (${(e as Error).message}). Pass skipQuotaCheck to launch anyway.`);
    }
    if (q.used >= q.limit) throw new LaunchQuotaError("monthly", `This wallet has used all ${q.limit} launches for this UTC month. Launches reopen ${q.resetsAt}.`, q.resetsAt);
    if (q.dailyLimit !== undefined && (q.usedToday ?? 0) >= q.dailyLimit) {
      throw new LaunchQuotaError("daily", `This wallet has used today's ${q.dailyLimit} launches. Launches reopen ${q.dailyResetsAt ?? "at 00:00 UTC"}.`, q.dailyResetsAt);
    }
  }
}

