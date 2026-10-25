// Environment parsing. Fails fast with one clear message per problem.
// Empty values count as unset. The Qloo key is the one secret: it is kept off the
// enumerable config, so JSON.stringify, console.log and util.inspect never show it.

import { z } from "zod";

export const QLOO_HACKATHON_BASE = "https://hackathon.api.qloo.com";

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const httpUrl = z.url({ protocol: /^https?$/ });
const list = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x.toLowerCase() !== "none"),
);

const EnvSchema = z.object({
  PORT: num(0, 65535).pipe(z.int()).default(8080),
  HOST: z.string().optional(),
  PUBLIC_ORIGIN: httpUrl.optional(),
  ALLOWED_ORIGINS: list.default([]),
  TRUST_PROXY_HOPS: num(0, 10).pipe(z.int()).default(0),
  RATE_LIMIT_SCALE: num(0.1, 1000).default(1),

  QLOO_API_KEY: z.string().max(512).optional(),
  QLOO_API_BASE: httpUrl.default(QLOO_HACKATHON_BASE),
  QLOO_DAILY_CALLS: num(0, 1_000_000).pipe(z.int()).default(3000),
  QLOO_CLIENT_DAILY_CALLS: num(0, 1_000_000).pipe(z.int()).default(300),
});

/** Every environment key the app reads (the README's env table lists each one). */
export const ENV_KEYS = Object.keys(EnvSchema.shape);

export type Mode = "live" | "demo";

export interface Config {
  port: number;
  host: string | undefined;
  /** Origin only (scheme://host[:port]); undefined means http://localhost:<bound port>. */
  publicOrigin: string | undefined;
  allowedOrigins: string[];
  trustProxyHops: number;
  rateLimitScale: number;
  /** "live" when QLOO_API_KEY is set, else "demo" (synthetic fixtures, no outbound calls). */
  mode: Mode;
  qlooBase: string;
  qlooDailyCalls: number;
  /** Live Qloo calls a day for one client (rate-limit key), so one client can't use up qlooDailyCalls. */
  qlooClientDailyCalls: number;
  /** Non-enumerable: read it, but it never shows up when the config is printed. */
  readonly qlooKey: string | undefined;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function originOf(raw: string, key: string): string {
  const u = new URL(raw);
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    throw new ConfigError(`${key} must be an origin like https://qloo.ambree.ai (no path), got a URL with a path`);
  }
  return u.origin;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The Qloo base URL, without a trailing slash. It must be https: the key goes in a header,
 * so plain http is allowed only to a loopback host (the tests' mock server).
 */
export function qlooBaseOf(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "https:" && !isLoopbackHost(u.hostname)) {
    throw new ConfigError("QLOO_API_BASE must be https (plain http is allowed only for a loopback host)");
  }
  if (u.search || u.hash || u.username || u.password) throw new ConfigError("QLOO_API_BASE must be a plain base URL (no query, fragment or credentials)");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Tests and e2e pass an explicit env object; only src/server.ts passes process.env. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const cleaned: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const v = env[key];
    if (typeof v === "string" && v.trim() !== "") cleaned[key] = v.trim();
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Name the key only: never echo a value (one of them is the API key).
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: invalid value`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;

  const config = {
    port: e.PORT,
    host: e.HOST,
    publicOrigin: e.PUBLIC_ORIGIN ? originOf(e.PUBLIC_ORIGIN, "PUBLIC_ORIGIN") : undefined,
    allowedOrigins: e.ALLOWED_ORIGINS.map((o) => originOf(o, "ALLOWED_ORIGINS")),
    trustProxyHops: e.TRUST_PROXY_HOPS,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    mode: (e.QLOO_API_KEY ? "live" : "demo") as Mode,
    qlooBase: qlooBaseOf(e.QLOO_API_BASE),
    qlooDailyCalls: e.QLOO_DAILY_CALLS,
    qlooClientDailyCalls: e.QLOO_CLIENT_DAILY_CALLS,
  };
  Object.defineProperty(config, "qlooKey", { value: e.QLOO_API_KEY, enumerable: false, writable: false });
  return config as Config;
}
