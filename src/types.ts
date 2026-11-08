import type { Address, Hex, TransactionReceipt } from "viem";

/* ------------------------------------------------------------------ market data (GET endpoints) */

/** A token row as the Eden API returns it. Raw amounts are decimal wei strings; *_usd fields are numbers or null. */
export type Token = {
  address: Address;
  curve: Address;
  creator: Address;
  pair_token?: Address;
  name: string;
  symbol: string;
  /** ipfs://<cid>; resolve with ipfsToHttp() or Eden's cache at <api>/images/ipfs/<cid> */
  logo: string;
  description: string;
  socials: Partial<Record<"twitter" | "telegram" | "discord" | "website" | "farcaster", string>>;
  supply: string;
  graduation_threshold: string;
  real_quote_reserve: string;
  price_quote: string;
  market_cap_quote: string;
  curve_fee_bps: number;
  creator_tax_bps: number;
  buyback_enabled: boolean;
  phase: "curve" | "swept" | "pool";
  pool_id?: Hex | null;
  launched_at: string;
  graduated_at: string | null;
  last_trade_at: string | null;
  trades_count: number;
  holders: number;
  volume_24h_quote: string;
  trades_24h: number;
  change_24h: number;
  graduation_progress: number;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  price_usd: number | null;
  creator_x: string | null;
  creator_tiktok?: string | null;
  creator_verified: boolean;
  launched_via?: "x" | null;
  launch_tweet_id?: string | null;
  creator_ethos_score?: number | null;
  creator_ethos_level?: string | null;
  [extra: string]: unknown;
};

export type Trade = {
  tx_hash: Hex;
  log_index: number;
  at: string;
  token: Address;
  venue: "curve" | "pool";
  side: "buy" | "sell";
  trader: Address;
  signer: Address;
  source: string;
  quote_amount: string;
  token_amount: string;
  price_quote: string;
  symbol?: string;
  name?: string;
  logo?: string;
  [extra: string]: unknown;
};

export type Candle = { bucket: string; open: string; high: string; low: string; close: string; volume_quote: string; trades: number };
export type CandleInterval = "1s" | "15s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | (string & {});
export type Holder = { holder: Address; amount: string };

export type Portfolio = {
  positions: Array<Token & { balance: string }>;
  fees: Array<{ asset: string; earned: string; claimable: string }>;
  created: Token[];
  hypeUsd: number | null;
};

export type CreatorProfile = {
  address: Address;
  x?: { handle: string; ethos: { score: number; level: string; profileUrl: string } | null };
  tiktok?: { handle: string };
  [extra: string]: unknown;
};

export type LaunchQuota = {
  used: number;
  limit: number;
  resetsAt: string;
  usedToday?: number;
  dailyLimit?: number;
  dailyResetsAt?: string;
  [extra: string]: unknown;
};

export type Stats = { stats: Record<string, string | number>; hypeUsd: number | null };

export type TokenTab = "trending" | "new" | "graduating" | "graduated";
export type TokenListQuery = {
  tab?: TokenTab;
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  minMcapUsd?: number;
  maxMcapUsd?: number;
  maxAgeHours?: number;
  /** Server filters added with the developer endpoints. */
  minVolume24h?: bigint | string;
  minHolders?: number;
  verifiedOnly?: boolean;
  creator?: Address;
  graduatedWithinHours?: number;
};
export type TokenList = { tokens: Token[]; total: number; hypeUsd: number | null };

export type TopBy = "volume" | "gainers" | "market_cap" | "new" | "trades";
export type TopQuery = { by?: TopBy; window?: "1h" | "24h"; limit?: number };

/** A live-feed frame from /ws. Channels: "feed", "token:<address>", "wallet:<address>". */
export type LiveFrame = { channel: string; type: "trade" | "launch" | "graduation" | "token" | "referral_earning" | (string & {}); data: any };

/* ------------------------------------------------------------------ quotes and transaction plans */

export type Side = "buy" | "sell";
export type Route = "curve" | "pool";

/** A quote. All amounts are bigint wei / smallest token units. Prices are wei of HYPE per whole token. */
export type Quote = {
  token: Address;
  side: Side;
  route: Route;
  /** What the trade spends (HYPE for a buy, tokens for a sell). */
  amountIn: bigint;
  expectedOut: bigint;
  /** expectedOut less slippage: the transaction reverts below it. */
  minOut: bigint;
  slippageBps: number;
  priceImpactBps: number;
  /** Eden's trading fee (1%), in HYPE on the curve; on the pool, in the output currency. */
  fee: bigint;
  /** Creator tax, same currency as fee. */
  tax: bigint;
  priceBefore: bigint;
  priceAfter: bigint;
  /** This buy completes the curve: the token graduates in the same transaction. */
  graduates: boolean;
  /** HYPE a buy actually spends (less than amountIn when it fills the curve; the rest is refunded). */
  amountSpent?: bigint;
  refund?: bigint;
  /** Snipe tax in the launch window (included in fee). */
  snipeTax?: bigint;
  /** "HYPE", or "token" for pool buys (the hook takes its cut from the output). */
  feeAsset?: "HYPE" | "token";
  /** Block the quote was read at (API quotes). */
  block?: bigint;
};

export type StepKind = "approve" | "permit2-approve" | "swap" | "launch" | "claim" | "sweep-fees" | "graduate";

export type TxRequest = { to: Address; data: Hex; value: bigint; chainId: number; from: Address };

/** One transaction to sign, in order. `simulated`: whether the builder (server) already eth_call'ed it. */
export type Step = { kind: StepKind; description: string; tx: TxRequest; simulated?: boolean };

export type Referral = { status: "none" | "bound" | "unbound"; referrer?: Address; message?: string; howToBind?: string };
export type SwapPlan = { chainId: number; route: Route; quote: Quote; steps: Step[]; referral?: Referral };
export type LaunchPlan = {
  chainId: number; logo: string; logoUrl?: string; quota?: LaunchQuota; steps: Step[];
  launchFee?: bigint;
  /** The addresses the launch will deploy (from the server's simulation) and the initial buy's expected and minimum tokens. */
  predicted?: { token: Address; curve: Address; initialBuyTokensOut?: bigint; minTokensOut?: bigint };
};
/**
 * What a wallet can claim. how: "claim" (a step claims it), "sweep_then_claim" (a sweep-fees step moves it into the
 * escrow first), "operator_sweep" (only Eden's fee operator can sweep it: a buyback or token-denominated fee must be
 * converted first), "automatic" (referral earnings, paid out by Eden).
 */
export type Claimable = {
  kind: "fee_escrow" | "curve_fees" | "pool_fees" | "referral";
  token?: Address; asset: "HYPE"; amount: bigint;
  how: "claim" | "sweep_then_claim" | "operator_sweep" | "automatic";
  note: string;
};
export type ClaimPlan = { chainId: number; claimable: Claimable[]; steps: Step[] };
export type GraduatePlan = { chainId: number; steps: Step[] };
export type Plan = SwapPlan | LaunchPlan | ClaimPlan | GraduatePlan;

/* ------------------------------------------------------------------ requests */

export type SwapRequest = {
  token: Address;
  side: Side;
  /** HYPE wei for a buy, token units for a sell. */
  amount: bigint;
  /** The wallet that signs and pays. */
  user: Address;
  slippageBps?: number;
  /** Who receives the output (default: user). */
  recipient?: Address;
  referrer?: Address;
};

export type Socials = { x?: string; telegram?: string; website?: string };

export type LaunchRequest = {
  user: Address;
  name: string;
  symbol: string;
  description?: string;
  /**
   * API mode: an https URL, a data: URI, or raw bytes (PNG, JPEG or GIF, at most 8 MB); Eden crops it to a centred
   * 1024×1024 square and pins it. Local mode: pass `logo` (an ipfs:// URI you pinned) instead, or bytes, which are
   * uploaded unchanged through POST /uploads/image (crop them square yourself).
   */
  image?: string | Uint8Array;
  /** A logo already pinned to IPFS (ipfs://<cid>). */
  logo?: string;
  socials?: Socials;
  /** HYPE wei for the creator's first buy in the launch transaction (0 or omitted: none). */
  initialBuy?: bigint;
  /** Who earns the creator fee (default: user). */
  creatorFeeRecipient?: Address;
  /** Creator fee on every trade, in bps: 0, 100, 200, 300, 500 or 1000 (default 100 = 1%, as on the website). */
  creatorFeeBps?: number;
  /** Route part of the creator fee to buyback-and-lock (default true, as on the website). */
  buyback?: boolean;
  /** Up to 31 wallets exempt from the launch-window snipe tax. */
  bundleWallets?: Address[];
  slippageBps?: number;
};

export type ClaimRequest = { user: Address; token?: Address };
export type GraduateRequest = { user: Address; token: Address };

/* ------------------------------------------------------------------ results (decoded from receipts) */

export type TradeResult = {
  hash: Hex;
  /** Every transaction sent for this trade (approvals first). */
  hashes: Hex[];
  token: Address;
  side: Side;
  route: Route;
  /** Actually spent (a clamped final curve buy spends less than offered). */
  amountIn: bigint;
  /** Actually received by the recipient. */
  amountOut: bigint;
  fee: bigint;
  tax: bigint;
  /** "HYPE" or the token address: the currency the fee and tax were taken in. */
  feeCurrency: "HYPE" | Address;
  expectedOut: bigint;
  minOut: bigint;
  /** The curve graduated in this transaction. */
  graduated: boolean;
  receipt: TransactionReceipt;
};

export type LaunchResult = {
  hash: Hex;
  token: Address;
  curve: Address;
  logo: string;
  initialBuy?: { quoteIn: bigint; tokensOut: bigint; fee: bigint; tax: bigint };
  receipt: TransactionReceipt;
};

export type ClaimResult = {
  hashes: Hex[];
  /** HYPE claimed from the fee escrow. */
  claimed: bigint;
  /** Token-denominated fees claimed, by token. */
  claimedTokens: Array<{ token: Address; amount: bigint }>;
  /** Fees swept from a curve or pool into the escrow first. */
  swept: bigint;
  receipts: TransactionReceipt[];
};

export type GraduateResult = { hashes: Hex[]; poolId?: Hex; positionId?: bigint; receipts: TransactionReceipt[] };
