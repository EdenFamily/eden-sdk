// Check a raw POST /tx/swap response yourself, without letting the SDK send anything.
// node --experimental-strip-types examples/verify-api-response.ts <token> <HYPE amount> <your address>
import type { Address } from "viem";
import { parseHype, parseSwapPlan, VerificationError } from "../src/index.ts";
import { eden, show } from "./_env.ts";

const [token, amount, user] = process.argv.slice(2) as [Address, string, Address];
const client = eden(false);
const request = { token, side: "buy" as const, amount: parseHype(amount), user, slippageBps: 300 };
const wire = await client.api.txSwap({ ...request, slippageBps: 300 }); // the raw JSON, amounts as decimal strings
try {
  const checked = await client.verify({ action: "swap", plan: parseSwapPlan(wire, 300), request });
  show(checked.steps);
} catch (e) {
  if (e instanceof VerificationError) console.error(`REFUSED: ${e.message}`);
  else throw e;
}
