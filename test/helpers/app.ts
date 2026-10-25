// Start the app in-process on port 0 with captured logs. Config comes from an explicit env
// object, never process.env, so a Qloo key exported in the shell can't make tests go live.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type App, createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import type { LogRecord } from "../../src/log.ts";
import type { Qloo } from "../../src/qloo/client.ts";

export interface TestApp {
  app: App;
  url: string;
  logs: LogRecord[];
  close(): Promise<void>;
}

export async function startTestApp(opts: { env?: Record<string, string>; qloo?: Qloo } = {}): Promise<TestApp> {
  const logs: LogRecord[] = [];
  const config = loadConfig({ PORT: "0", HOST: "127.0.0.1", ...opts.env });
  const app = createApp({ config, logger: (r) => logs.push(r), qloo: opts.qloo });
  await app.listen();
  return { app, url: app.url(), logs, close: () => app.close() };
}

export async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "ambree-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

export function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export const INIT_PARAMS = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-test", version: "0.0.0" } };

/** The environment for a spawned process: the parent's, minus every QLOO_* variable. */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("QLOO_")) env[k] = v;
  return { ...env, ...extra };
}
