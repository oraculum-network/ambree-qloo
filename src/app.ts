// The HTTP app: routes, guards and logging. No framework: node:http plus the MCP SDK.
//
//   POST /mcp          MCP (Streamable HTTP, stateless). Open to any MCP client, rate-limited.
//   GET  /healthz      { ok, version, mode }
//   GET  /             The demo page, then static files from public/.
//
// There is no other API and no session: the demo page is itself an MCP client of /mcp.

import { realpathSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { createClientIdentity } from "./http/client-ip.ts";
import { sendJson, sendJsonRpcError, setSecurityHeaders } from "./http/headers.ts";
import { type OriginPolicy, createOriginPolicy } from "./http/origin.ts";
import { LIMITS, createRateLimiter } from "./http/rate-limit.ts";
import { resolveStatic, sendFile } from "./http/static.ts";
import { type Logger, jsonLogger } from "./log.ts";
import { handleMcp } from "./mcp/endpoint.ts";
import { VERSION } from "./meta.ts";
import { type Qloo, qlooFromConfig } from "./qloo/client.ts";
import { createDemoTransport } from "./qloo/fixtures.ts";
import type { ToolDeps } from "./tools/context.ts";

const PUBLIC_DIR = realpathSync(fileURLToPath(new URL("../public", import.meta.url)));

export interface AppOptions {
  config: Config;
  logger?: Logger;
  /** Override the Qloo seam (tests). */
  qloo?: Qloo;
}

export interface App {
  server: Server;
  qloo: Qloo;
  /** Listen on config.port (0 = any free port); resolves with the bound port. */
  listen(): Promise<number>;
  url(): string;
  close(): Promise<void>;
}

interface RequestMeta {
  route: string;
  tools?: string[];
}

export function createApp(opts: AppOptions): App {
  const { config } = opts;
  const log = opts.logger ?? jsonLogger;
  const qloo = opts.qloo ?? qlooFromConfig(config, createDemoTransport(), log);
  const deps: ToolDeps = { qloo, log };
  const scale = config.rateLimitScale;
  const mcpLimit = createRateLimiter({ perMinute: LIMITS.mcp.perMinute * scale, burst: Math.max(1, Math.round(LIMITS.mcp.burst * scale)) });
  const identity = createClientIdentity({ trustProxyHops: config.trustProxyHops, log });

  let port = config.port;
  const publicOrigin = () => config.publicOrigin ?? `http://localhost:${port}`;
  const makePolicy = (): OriginPolicy => createOriginPolicy({ publicOrigin: publicOrigin(), port, extraOrigins: config.allowedOrigins });
  let policy: OriginPolicy = makePolicy();
  const https = () => publicOrigin().startsWith("https:");

  async function staticRoute(req: IncomingMessage, res: ServerResponse, path: string, meta: RequestMeta): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    const found = await resolveStatic(PUBLIC_DIR, path === "/" ? "/index.html" : path);
    if (!found.ok) {
      meta.route = "not_found";
      return sendJson(res, found.status, { error: found.status === 400 ? "bad_request" : "not_found" });
    }
    meta.route = found.type.startsWith("text/html") ? "page" : "static";
    await sendFile(res, found.file, found.type, req.method === "HEAD");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const meta: RequestMeta = { route: "other" };
    setSecurityHeaders(res, https());
    res.on("finish", () => {
      log({ route: meta.route, method: req.method ?? "", status: res.statusCode, ms: Math.round(performance.now() - started), tools: meta.tools });
    });
    // A client that goes away before the response: one line too (499, as proxies log it).
    res.on("close", () => {
      if (res.writableFinished) return;
      log({ route: meta.route, method: req.method ?? "", status: 499, aborted: true, ms: Math.round(performance.now() - started), tools: meta.tools });
    });

    const rawPath = (req.url ?? "/").split("?")[0] || "/";
    const isMcp = rawPath === "/mcp";
    meta.route = isMcp ? "/mcp" : rawPath === "/healthz" ? "/healthz" : rawPath.startsWith("/api/") ? "/api/unknown" : "static";

    if (rawPath === "/healthz") {
      // Health probes may use any Host, so this one route skips the Host check.
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      return sendJson(res, 200, { ok: true, version: VERSION, mode: qloo.mode });
    }
    if (!policy.isAllowedHost(req.headers.host)) {
      if (isMcp) return sendJsonRpcError(res, 403, -32000, "Forbidden: Host not allowed");
      return sendJson(res, 403, { error: "forbidden_host" });
    }
    if (!policy.isAllowedOrigin(req.headers.origin)) {
      if (isMcp) return sendJsonRpcError(res, 403, -32000, "Forbidden: Origin not allowed");
      return sendJson(res, 403, { error: "forbidden_origin" });
    }

    if (isMcp) {
      const d = mcpLimit.take(identity.key(req));
      if (!d.ok) return sendJsonRpcError(res, 429, -32000, "Too many requests", { "Retry-After": String(d.retryAfterSec) });
      const info = { tools: [] as string[] };
      meta.tools = info.tools;
      return handleMcp(req, res, deps, info);
    }
    if (rawPath.startsWith("/api/")) return sendJson(res, 404, { error: "not_found" });
    return staticRoute(req, res, rawPath, meta);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log({ level: "error", route: "internal", error: e instanceof Error ? e.name : "unknown" });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  return {
    server,
    qloo,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        const done = () => {
          port = (server.address() as AddressInfo).port;
          policy = makePolicy();
          resolve(port);
        };
        if (config.host) server.listen(config.port, config.host, done);
        else server.listen(config.port, done);
      });
    },
    url: () => `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}
