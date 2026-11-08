
/** Elysium mainnet: an Arbitrum Orbit L2 over HyperEVM. Native gas and quote asset: HYPE (18 decimals). */
export const ELYSIUM_CHAIN_ID = 99901;

/** Eden's public read API (the website's /api). */
export const DEFAULT_API_URL = "https://edenfamily.xyz/api";
/** Eden's live feed (the website's /ws). */
export const DEFAULT_WS_URL = "wss://edenfamily.xyz/ws";
/** Elysium's public RPC. Good for reads; it may refuse transaction sends (see README, "Sending"). */
export const DEFAULT_RPC_URL = "https://rpc-live.elysp.com";

/**
 * Eden's calldata marker: "EDEN" + version 0x0001, appended to the calldata of transactions Eden builds. Contracts
 * ignore trailing calldata; Eden's indexer reads it to attribute trades. Verification accepts calldata with or without
 * one trailing `4544454e` + 2-byte version marker, and nothing else after the ABI-encoded call.
 */
export const EDEN_CALLDATA_MARKER = "4544454e0001";
export const EDEN_MARKER_PATTERN = /4544454e[0-9a-f]{4}$/i;

/** Every Eden token: 1,000,000,000 supply, 18 decimals. HYPE also has 18 decimals. */
export const TOKEN_DECIMALS = 18;
export const HYPE_DECIMALS = 18;

/** Default slippage tolerance: 3% (the website's default). */
export const DEFAULT_SLIPPAGE_BPS = 300;
/** Slippage above this is refused unless the caller passes `allowHighSlippage`. */
export const MAX_SLIPPAGE_BPS = 5_000;

/** Launch limits counted by Eden per creator wallet (UTC day / UTC month). */
export const LAUNCHES_PER_DAY = 2;
export const LAUNCHES_PER_MONTH = 10;

