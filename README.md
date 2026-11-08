# eden-sdk

TypeScript SDK for [Eden](https://edenfamily.xyz), the token launchpad on Elysium. Read the market, quote, launch tokens, trade them on the bonding curve and in their Uniswap v4 pool after graduation, and claim creator fees. **Every transaction is verified against your own request and independent on-chain reads before it is signed.**

- Built on [viem](https://viem.sh) only. ESM, Node ≥ 22, typed throughout, bigint amounts.
- Two ways to build every write: **API mode** asks Eden's server (`POST /tx/*`), **local mode** builds the same calldata from chain reads alone. Both go through the same `verify()`.
- Exact quotes: the curve and pool math follow the contracts integer for integer, so a quote equals the on-chain fill to the wei.
- Docs: [github.com/EdenFamily/eden-docs](https://github.com/EdenFamily/eden-docs) · Python: [eden-sdk-python](https://github.com/EdenFamily/eden-sdk-python) · AI agents: [eden-skills](https://github.com/EdenFamily/eden-skills) · Contracts: [eden-contracts](https://github.com/EdenFamily/eden-contracts)

## Install

From GitHub for now (the `prepare` script builds `dist/`):

```bash
npm install github:EdenFamily/eden-sdk viem
```

<!-- TODO(registry): once published, `npm install @edenfamily/eden-sdk viem` (final npm name to be confirmed). -->

## Quick start

```ts
import { EdenClient, formatTokens, parseHype } from "@edenfamily/eden-sdk";
import { privateKeyToAccount } from "viem/accounts";

const eden = new EdenClient({ account: privateKeyToAccount(process.env.EDEN_PRIVATE_KEY as `0x${string}`) });

const token = "0x…";
const quote = await eden.quote(token, "buy", parseHype("0.5"));       // HYPE in, tokens out
console.log(formatTokens(quote.expectedOut), "tokens, at least", formatTokens(quote.minOut));

const fill = await eden.buy(token, parseHype("0.5"));                  // build → verify → simulate → sign → send → confirm
console.log(`got ${formatTokens(fill.amountOut)} on the ${fill.route}`, fill.hash);

const sold = await eden.sell(token, fill.amountOut / 2n, { slippageBps: 100 });
```

Reads need no wallet:

```ts
const eden = new EdenClient();
const { tokens } = await eden.top({ by: "volume", window: "24h", limit: 10 });
const t = await eden.token(tokens[0].address);
const candles = await eden.candles(t.address, { interval: "5m" });
const sub = eden.live({ channels: ["feed"], onFrame: (f) => console.log(f.type, f.data) });
```

## Units

Every amount is a `bigint` in the smallest unit. HYPE and every Eden token have 18 decimals. Convert at the edges, never with floating point:

| | |
|---|---|
| `parseHype("1.5")` → `1500000000000000000n` | `formatHype(wei)` → `"1.5"` |
| `parseTokens("1000")` | `formatTokens(units)` |
| `percentToBps(3)` → `300` | slippage is in bps everywhere; default **300 (3%)** |

Prices in quotes are wei of HYPE per whole token (`formatPrice`).

## API

### Client

```ts
new EdenClient({
  account,            // viem LocalAccount (privateKeyToAccount / mnemonicToAccount); or walletClient for a browser wallet
  mode: "api",        // "api" (default) or "local"
  sendVia: "api",     // "api" (default: POST /tx/send) or "rpc" (with sendRpcUrl)
  sendRpcUrl,         // an RPC that accepts eth_sendRawTransaction
  rpcUrl,             // reads, simulation, gas, receipts (default https://rpc-live.elysp.com)
  apiUrl,             // default https://edenfamily.xyz/api
  wsUrl,              // default wss://edenfamily.xyz/ws
  slippageBps: 300,   // default slippage; above 5000 (50%) is refused unless allowHighSlippage
  deployment,         // default MAINNET; loadDeployment(record) for a fork or testnet
  approval: "unlimited", // local mode: "unlimited" (as the website and API) or "exact"
  permit2: "approve", // local mode pool sells: on-chain Permit2.approve (as the API) or "signature" (website's signed permit)
  marker,             // calldata marker for locally built transactions (default 4544454e0001)
  onStep,             // progress: simulated / signed / sent / confirmed, per step
})
```

| Group | Methods |
|---|---|
| Market data | `tokens(query)`, `top({ by, window, limit })`, `token(a)`, `candles(a, { interval, from, to })`, `trades(a)`, `holders(a)`, `portfolio(w)`, `walletTrades(w)`, `creator(a)`, `quota(a)`, `stats()`, `balances(owner, token?)` |
| Live feed | `live({ channels: ["feed" \| "token:0x…" \| "wallet:0x…"], onFrame, onStatus })` → `{ subscribe, unsubscribe, close, ready }` |
| Quotes | `quote(token, side, amount, { slippageBps, mode })` |
| Writes (verified) | `buy(token, hypeWei, opts)`, `sell(token, units, opts)`, `swap(request)`, `launch(request)`, `claimFees({ token? })`, `graduate(token)` |
| Build only | `buildSwap`, `buildBuy`, `buildSell`, `buildLaunch`, `buildClaim`, `buildGraduate` → plans `{ chainId, steps: [{ kind, description, tx }] }` |
| Verify | `verify({ action, plan, request })`, and the standalone `verifySwap / verifyLaunch / verifyClaim / verifyGraduate(reader, plan, request)` |
| Send a verified plan | `executeSwap(plan, request)` |

Writes return decoded results from the receipt, not the quote: `TradeResult { amountIn, amountOut, fee, tax, feeCurrency, expectedOut, minOut, graduated, hash, hashes, receipt }`, `LaunchResult { token, curve, logo, initialBuy, warnings }`, `ClaimResult { claimed, swept, claimedTokens }`.

Lower-level exports: the contract math (`quoteBuy`, `quoteSell`, `quotePool`, `readCurve`, `readPool`, `initialBuyTokens`, `minimumOut`), calldata (`swapCalldata`, `poolKey`, `poolId`, `permitTyped`), every bundled ABI (`edenLaunchFactoryAbi`, `edenBondingCurveAbi`, … and the short `curveAbi`, `factoryAbi` the website uses), `MAINNET`, `UNISWAP`, `loadDeployment`, `EdenApi` (the raw HTTP client) and the wire parsers.

### Errors

All errors extend `EdenError` with a stable `code`:

| Error | When |
|---|---|
| `VerificationError` (`code`, `step`) | a plan failed a check: nothing was signed |
| `LaunchQuotaError` (`scope: "daily" \| "monthly"`, `resetsAt`) | Eden's launch limits; wait for the reset, do not retry |
| `ValidationError` (`field`) | launch metadata or an image breaks the rules below |
| `EdenApiError` (`status`, `code`, `body`) | the API refused (e.g. `422 simulation:reverted` with `reason`) |
| `NotTradableError` | not an Eden token, or graduating (call `graduate(token)`) |
| `TransactionError` (`hash`) | reverted on chain, no receipt yet, or a send endpoint returned the wrong hash |
| `ConfigError` | e.g. a write without an account |

## How verification works

`verify()` runs before every signature, in both modes, and is public so you can check any plan yourself (see [examples/verify-api-response.ts](examples/verify-api-response.ts)). For each step:

1. **Chain and sender.** `chainId` is the configured chain (99901 on mainnet) and `from` is your wallet.
2. **Target.** `to` is a known Eden address: a deployment contract (factory, LaunchAndBuy, fee escrow, hook, Permit2, Universal Router), the token's own curve **as registered by Eden's factory on chain**, or the token itself for an approval.
3. **Calldata.** It decodes with the bundled ABIs to the one function that step kind allows, and it is canonical: re-encoding the decoded arguments gives back the same bytes, and nothing but Eden's 6-byte marker may follow.
4. **Arguments.** Recipient, user, amount, value, approval spender (the token's curve, or Permit2 → Universal Router), the pool key (HYPE/token, fee 0, tick spacing 200, Eden's hook), direction, deadline, launch metadata, creator fee recipient, launch fee + initial buy.
5. **Price.** The minimum out equals the quote's `minOut` **and** is no lower than the SDK's own quote, computed independently from chain state (curve reserves, or the pool's price and liquidity), less your slippage. A server that claims a worse price to widen your slippage is caught.
6. **Simulation.** Each step is `eth_call`ed from your wallet. A step that needs an earlier approval is simulated right before it is signed, after that approval is mined.

After sending, the SDK checks the returned hash is the hash of what it signed, waits for the receipt, requires success, and decodes Eden's events (`TokenLaunched`, `CurveBuy`/`CurveSell`, the pool's `Swap` + `HookFeeCollected` cross-checked with the token `Transfer`, `Claimed`, `PoolGraduated`) into the amounts that actually moved.

## Sending

Elysium's public RPC may be read-only for transaction sends. By default the SDK signs locally and broadcasts through **`POST /tx/send`**, which relays only Eden calls (factory, LaunchAndBuy, escrow, hook sweeps, curve trades, the Universal Router, Permit2 and token approvals to the curve or Permit2). To use your own node instead:

```ts
new EdenClient({ account, sendVia: "rpc", sendRpcUrl: "https://your-elysium-rpc" });
```

Private keys never leave the `account` object; only signed transactions are sent.

## Launch metadata and logos

The SDK enforces the website's Create page rules (`validateLaunchMetadata`), and Eden's API enforces the same:

| Field | Rule |
|---|---|
| `name` | required, trimmed, at most 32 characters, no control characters |
| `symbol` | required, upper-cased, 1–10 letters A–Z or digits 0–9 (no `$`) |
| `description` | optional, trimmed, at most 256 characters (line breaks allowed) |
| `socials.x` | `https://x.com/…` / `https://twitter.com/…`, or a handle (`@name`, 1–15 letters, digits, `_`) |
| `socials.telegram` | `https://t.me/…`, or a username (5–32 characters) |
| `socials.website` | an `http(s)://` URL |
| `creatorFeeBps` | 0, 100, 200, 300, 500 or 1000 (default 100 = 1%); local mode accepts any whole value up to the contract's 1000 |
| `buyback` | default `true` (part of the creator fee buys back and locks the token) |
| `bundleWallets` | snipe-tax exemptions: up to 31 (32 via `launchToken` in local mode) |
| `initialBuy` | HYPE wei bought in the launch transaction (`launchAndBuy`) |
| `image` | PNG, JPEG or GIF (checked from the bytes), at most **8 MB**: raw bytes, a `data:` URI, or an `https://` URL |

**Logos are square.** Eden crops any image to its **centred square** and saves it as a 1024×1024 PNG (a GIF keeps its first frame). A 1600×900 banner keeps its middle 900×900, so frame the subject in the centre with some margin. `validateLaunchMetadata` returns a warning for a non-square image. In local mode, pass `logo: "ipfs://…"` (already pinned), or image bytes, which are uploaded **unchanged** through `POST /uploads/image` (4 MB): crop them square yourself.

**Launch limits.** Eden counts 2 launches per creator per UTC day and 10 per UTC month. API mode answers `429 quota:daily|quota:monthly` (`LaunchQuotaError`); local mode checks `GET /creators/:a/quota` first. Respect the limit; do not retry.

## Modes

| | API mode (default) | Local mode |
|---|---|---|
| Builds with | `POST /tx/swap`, `/tx/launch`, `/tx/claim` | chain reads only |
| Logo | the server crops and pins it | your `ipfs://` logo, or bytes uploaded as-is |
| Claims without a token | sweeps every curve/pool you created (Eden's index) | claims the escrow balance only |
| Trust in Eden's server | none: every step is verified | none |

## Testing

```bash
npm test                 # unit tests: math, metadata, HTTP, verify() against hand-built tampered API responses
EDEN_DEPLOYMENT=path/to/deployment.json npm run test:e2e   # local chain only: anvil with Eden deployed (EDEN_TEST_RPC, default http://127.0.0.1:8590)
```

The end-to-end suites never touch mainnet. They launch with a logo, trade on the curve with exact amount checks, trade to graduation, trade in the pool through the Universal Router with Permit2, claim fees, and prove `verify()` refuses tampered steps; in API mode against a mock server with tamper hooks and against a real Eden server (`EDEN_REAL_API`).

## Security

Report vulnerabilities privately to support@edenfamily.xyz. Never commit private keys; the tests use only anvil's public test mnemonic.

## License

[MIT](LICENSE)
