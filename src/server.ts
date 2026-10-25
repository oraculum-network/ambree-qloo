// Entry point: node src/server.ts (Node 22.18+ runs TypeScript by stripping types).
// The one place that reads process.env. It logs the mode, never the key.

import { type App, createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { jsonLogger } from "./log.ts";
import { VERSION } from "./meta.ts";

let app: App | undefined;
try {
  const config = loadConfig(process.env);
  app = createApp({ config, logger: jsonLogger });
  const port = await app.listen();
  jsonLogger({
    event: "listening",
    port,
    version: VERSION,
    mode: config.mode,
    qloo_base: config.qlooBase,
    daily_calls: config.qlooDailyCalls,
  });
} catch (e) {
  // Boot errors carry no user data and config errors name keys only, so the message is safe to print.
  const message = e instanceof Error ? e.message : "unknown error";
  process.stderr.write(`ambree-qloo failed to start: ${message}\n`);
  process.exit(1);
}

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  jsonLogger({ event: "shutdown", signal });
  const force = setTimeout(() => process.exit(0), 10_000);
  force.unref();
  if (!app) process.exit(0);
  void app.close().then(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
