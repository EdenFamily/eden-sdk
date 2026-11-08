// node --experimental-strip-types examples/launch.ts "<name>" <SYMBOL> <logo.png> [initial buy HYPE]
import { readFileSync } from "node:fs";
import { LaunchQuotaError, parseHype, validateLaunchMetadata } from "../src/index.ts";
import { eden } from "./_env.ts";

const [name, symbol, logoPath, initial = "0"] = process.argv.slice(2) as [string, string, string, string?];
const image = new Uint8Array(readFileSync(logoPath));
const meta = validateLaunchMetadata({ name, symbol, image }); // throws ValidationError naming the bad field
for (const w of meta.warnings) console.warn(`note: ${w}`);
try {
  const r = await eden().launch({ name, symbol, image, initialBuy: parseHype(initial) });
  console.log(`$${meta.symbol} launched: token ${r.token}, curve ${r.curve}, logo ${r.logo}, tx ${r.hash}`);
} catch (e) {
  if (e instanceof LaunchQuotaError) console.error(`Launch limit reached (${e.scope}); launches reopen ${e.resetsAt ?? "after the reset"}. Not retrying.`);
  else throw e;
}
