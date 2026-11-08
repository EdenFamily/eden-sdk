# Changelog

## 0.1.0 (unreleased)

First version.

- `EdenClient`: market data (tokens, top, token, candles, trades, holders, portfolio, creator, quota, stats), the `/ws` live feed, quotes, buy, sell, launch, claimFees, graduate.
- API mode (`POST /tx/swap`, `/tx/launch`, `/tx/claim`, `/tx/send`) and local mode (the same calldata built from chain reads).
- `verify()`: chain, sender, target, canonical calldata, arguments, minimum out against the SDK's own quote, simulation. Public, for checking any plan.
- Receipt decoding into the amounts that moved (curve, pool, launch, claims, graduation).
- Exact curve and v4 pool math, ported from edenfamily.xyz's trading library (same names), with the contracts' rounding.
- Launch metadata and logo validation matching the website's Create page and the API.
- Signed Permit2 sells (website flow) as an option in local mode.
- Bundled ABIs for every Eden contract.
