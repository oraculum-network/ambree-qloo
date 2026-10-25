// The e2e server: the app on 3881 in demo mode. Config comes from this explicit env object,
// never process.env, so a Qloo key in the shell can't make the e2e run call Qloo.

import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig({
  PORT: "3881",
  HOST: "127.0.0.1",
  RATE_LIMIT_SCALE: "20",
});
const app = createApp({ config, logger: () => {} });
await app.listen();
process.stdout.write(`e2e server ready on 3881 (mode ${config.mode})\n`);

const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
