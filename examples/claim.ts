// node --experimental-strip-types examples/claim.ts [token]
import type { Address } from "viem";
import { formatHype } from "../src/index.ts";
import { eden } from "./_env.ts";

const token = process.argv[2] as Address | undefined;
const r = await eden().claimFees({ token });
console.log(r.hashes.length ? `claimed ${formatHype(r.claimed)} HYPE (swept ${formatHype(r.swept)} first), txs ${r.hashes.join(", ")}` : "nothing to claim");
