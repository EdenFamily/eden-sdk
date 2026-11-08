// node --experimental-strip-types examples/quote.ts <token> buy 0.5       (HYPE in)
// node --experimental-strip-types examples/quote.ts <token> sell 1000000  (tokens in)
import type { Address } from "viem";
import { formatHype, formatTokens, parseHype, parseTokens } from "../src/index.ts";
import { eden, show } from "./_env.ts";

const [token, side, amount] = process.argv.slice(2) as [Address, "buy" | "sell", string];
const q = await eden(false).quote(token, side, side === "buy" ? parseHype(amount) : parseTokens(amount));
show(q);
console.log(side === "buy"
  ? `about ${formatTokens(q.expectedOut)} tokens (at least ${formatTokens(q.minOut)})`
  : `about ${formatHype(q.expectedOut)} HYPE (at least ${formatHype(q.minOut)})`);
