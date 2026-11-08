// node --experimental-strip-types examples/buy.ts <token> <HYPE amount> [slippage %]
import type { Address } from "viem";
import { formatTokens, parseHype, percentToBps } from "../src/index.ts";
import { eden } from "./_env.ts";

const [token, amount, slippage = "3"] = process.argv.slice(2) as [Address, string, string?];
const fill = await eden().buy(token, parseHype(amount), { slippageBps: percentToBps(Number(slippage)) });
console.log(`bought ${formatTokens(fill.amountOut)} tokens on the ${fill.route} (quoted ${formatTokens(fill.expectedOut)}), tx ${fill.hash}`);
