// node --experimental-strip-types examples/live.ts [token]
import { eden } from "./_env.ts";

const token = process.argv[2];
const sub = eden(false).live({
  channels: token ? [`token:${token}`] : ["feed"],
  onFrame: (f) => console.log(f.channel, f.type, JSON.stringify(f.data).slice(0, 160)),
  onStatus: (up) => console.error(up ? "connected" : "disconnected, reconnecting"),
});
process.on("SIGINT", () => { sub.close(); process.exit(0); });
