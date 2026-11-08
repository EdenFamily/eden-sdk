// node --experimental-strip-types examples/sell.ts <token> <token amount | all> [slippage %]
import type { Address } from "viem";
import { formatHype, parseTokens, percentToBps } from "../src/index.ts";
import { eden } from "./_env.ts";

const [token, amount, slippage = "3"] = process.argv.slice(2) as [Address, string, string?];
const client = eden();
const units = amount === "all" ? (await client.balances(client.address!, token)).token! : parseTokens(amount);
const fill = await client.sell(token, units, { slippageBps: percentToBps(Number(slippage)) });
console.log(`sold for ${formatHype(fill.amountOut)} HYPE on the ${fill.route}, txs ${fill.hashes.join(", ")}`);
