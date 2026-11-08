// node --experimental-strip-types examples/top-tokens.ts [volume|gainers|market_cap|new|trades] [1h|24h]
import { formatHype, type TopBy } from "../src/index.ts";
import { eden } from "./_env.ts";

const [by = "volume", window = "24h"] = process.argv.slice(2) as [TopBy?, ("1h" | "24h")?];
const { tokens } = await eden(false).top({ by, window, limit: 10 });
for (const t of tokens) {
  console.log(`$${t.symbol.padEnd(10)} ${t.phase.padEnd(5)} mcap ${formatHype(BigInt(t.market_cap_quote))} HYPE  vol24h ${formatHype(BigInt(t.volume_24h_quote))} HYPE  ${t.address}`);
}
