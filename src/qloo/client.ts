// The Qloo seam. Two transports answer the same GET requests:
//  - live: https to QLOO_API_BASE with the X-Api-Key header (never a query param or a
//    Bearer token), a 6 s timeout, a 1 MB cap, one retry on 5xx or a network failure,
//    a private in-memory cache and a daily call cap;
//  - demo: the synthetic fixtures (src/qloo/fixtures.ts), used when no key is set.
// Each tool reply gets a QlooReply, which checks every body against the contract and
// records the calls. A live 401/403 or the daily cap switches the rest of that reply to
// the demo transport, labelled `notice: live_unavailable`.

import type { Config, Mode } from "../config.ts";
import type { Logger } from "../log.ts";
import { type TtlCache, cacheKey, createTtlCache } from "./cache.ts";
import {
  ENDPOINT_PATHS,
  type Endpoint,
  InsightsResponse,
  QlooErrorBody,
  SearchResponse,
  TagsResponse,
  checkShape,
} from "./contract.ts";
import { CappedFetchError, type FetchLike, fetchCapped } from "./fetch.ts";

export type QlooErrorKind = "http" | "timeout" | "network" | "too_big" | "redirect" | "quota" | "bad_response";

/** A failed Qloo call. Carries a status and Qloo's reason, never headers or the key. */
export class QlooError extends Error {
  override name = "QlooError";
  readonly status: number;
  readonly reason: string;
  readonly kind: QlooErrorKind;
  constructor(kind: QlooErrorKind, status: number, reason: string, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export type Params = Record<string, string>;

/** Answers a GET to a Qloo endpoint with the parsed JSON body. `client` is the caller's rate-limit key. */
export interface QlooTransport {
  get(endpoint: Endpoint, params: Params, client?: string): Promise<{ body: unknown; cached: boolean }>;
}

export const PLACE_TYPE = "urn:entity:place";
export const DESTINATION_TYPE = "urn:entity:destination";

export interface InsightsParams {
  type: typeof PLACE_TYPE | typeof DESTINATION_TYPE;
  /** signal.interests.entities */
  entities?: string[];
  /** signal.interests.tags */
  tags?: string[];
  /** filter.tags */
  filterTags?: string[];
  /** filter.geocode.country_code */
  countryCode?: string;
  /** filter.location.query (a place name Qloo geocodes) */
  locationQuery?: string;
  /** filter.geocode.name (usually a city or town) */
  town?: string;
  take: number;
}

/** The part of InsightsParams that restricts results to one country. */
export type CountryFilter = Pick<InsightsParams, "countryCode" | "locationQuery">;

export function searchParams(query: string, type: string, take = 1): Params {
  return { query, types: type, take: String(take) };
}

export function tagsParams(query: string, take = 5): Params {
  return { "filter.query": query, take: String(take) };
}

/** GET only, entity IDs only, parameters in the query string (hackathon guide). */
export function insightsParams(p: InsightsParams): Params {
  const out: Params = { "filter.type": p.type };
  if (p.entities?.length) out["signal.interests.entities"] = p.entities.join(",");
  if (p.tags?.length) out["signal.interests.tags"] = p.tags.join(",");
  if (p.filterTags?.length) out["filter.tags"] = p.filterTags.join(",");
  if (p.countryCode) out["filter.geocode.country_code"] = p.countryCode;
  if (p.locationQuery) out["filter.location.query"] = p.locationQuery;
  if (p.town) out["filter.geocode.name"] = p.town;
  out["feature.explainability"] = "true";
  out.take = String(Math.max(1, Math.min(50, Math.round(p.take))));
  return out;
}

export interface LiveTransportOptions {
  base: string;
  key: string;
  dailyCalls: number;
  /** Live requests a day for one client; unset = no per-client budget. */
  clientDailyCalls?: number;
  log: Logger;
  now?: () => number;
  fetch?: FetchLike;
  timeoutMs?: number;
  cache?: TtlCache<unknown>;
}

export interface LiveTransport extends QlooTransport {
  /** Live requests sent today (cache hits don't count). */
  callsToday(): number;
}

function redact(text: string, key: string): string {
  return key ? text.split(key).join("[redacted]") : text;
}

/** Clients tracked for the per-client budget; past this, the oldest is forgotten first. */
export const MAX_CLIENTS = 10_000;

export function createLiveTransport(opts: LiveTransportOptions): LiveTransport {
  const now = opts.now ?? Date.now;
  const cache = opts.cache ?? createTtlCache<unknown>({ now });
  let day = "";
  let count = 0;
  // Live requests today per client key (in memory only, never logged).
  const perClient = new Map<string, number>();
  const today = () => new Date(now()).toISOString().slice(0, 10);

  async function once(url: string): Promise<{ status: number; text: string }> {
    // The key goes in this one header and nowhere else.
    const headers = { "X-Api-Key": opts.key, Accept: "application/json" };
    return fetchCapped(url, headers, { timeoutMs: opts.timeoutMs, fetch: opts.fetch });
  }

  return {
    callsToday: () => (day === today() ? count : 0),
    async get(endpoint, params, client) {
      const path = ENDPOINT_PATHS[endpoint];
      const key = cacheKey(path, params);
      const hit = cache.get(key);
      if (hit !== undefined) return { body: hit, cached: true };

      if (day !== today()) {
        day = today();
        count = 0;
        perClient.clear();
      }
      if (count >= opts.dailyCalls) throw new QlooError("quota", 0, "quota", "The daily Qloo call budget is used up");
      const cap = opts.clientDailyCalls;
      const who = cap !== undefined ? client : undefined;
      if (who !== undefined && (perClient.get(who) ?? 0) >= cap!) {
        throw new QlooError("quota", 0, "client_quota", "This client's daily Qloo call budget is used up");
      }
      const spend = () => {
        count++;
        if (who === undefined) return;
        const n = (perClient.get(who) ?? 0) + 1;
        perClient.delete(who); // re-insert to mark as most recently used
        perClient.set(who, n);
        while (perClient.size > MAX_CLIENTS) perClient.delete(perClient.keys().next().value as string);
      };

      const url = `${opts.base}${path}?${new URLSearchParams(params).toString()}`;
      let res: { status: number; text: string } | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        spend();
        try {
          res = await once(url);
        } catch (e) {
          const kind = e instanceof CappedFetchError ? e.kind : "network";
          if (kind === "network" && attempt === 0) continue;
          throw new QlooError(kind, 0, kind, `Qloo request failed: ${kind}`);
        }
        if (res.status >= 500 && attempt === 0) continue;
        break;
      }
      const { status, text } = res!;
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (status < 200 || status >= 300) {
        const err = QlooErrorBody.safeParse(body);
        const reason = redact((err.success && err.data.reason) || `HTTP ${status}`, opts.key).slice(0, 80);
        const detail = err.success && err.data.message ? `: ${redact(err.data.message, opts.key).slice(0, 160)}` : "";
        throw new QlooError("http", status, reason, `Qloo returned ${status} ${reason}${detail}`);
      }
      if (body === undefined) throw new QlooError("bad_response", status, "bad_response", "Qloo returned a body that is not JSON");
      cache.set(key, body);
      return { body, cached: false };
    },
  };
}

export interface QlooCallTrace {
  endpoint: string;
  ms: number;
  cached: boolean;
}

export type Notice = "live_unavailable";

/** One tool reply's view of Qloo: typed calls, the mode it ended in, and the call trace. */
export interface QlooReply {
  search(query: string, type: string, take?: number): Promise<SearchResponse>;
  tags(query: string, take?: number): Promise<TagsResponse>;
  insights(p: InsightsParams): Promise<InsightsResponse>;
  readonly mode: Mode;
  readonly notice: Notice | undefined;
  readonly calls: QlooCallTrace[];
}

export interface Qloo {
  /** "live" when a key is configured; a single reply may still fall back to demo. */
  readonly mode: Mode;
  /** One tool reply. `client` (the caller's rate-limit key) counts its live calls against a per-client budget. */
  reply(client?: string): QlooReply;
}

/** 401/403 (a dead or wrong key) and the daily caps fall back to demo data; other errors don't. */
export function fallsBack(e: unknown): e is QlooError {
  return e instanceof QlooError && (e.kind === "quota" || (e.kind === "http" && (e.status === 401 || e.status === 403)));
}

const PARSERS = { search: SearchResponse, tags: TagsResponse, insights: InsightsResponse } as const;

export function createQloo(opts: { live?: QlooTransport; demo: QlooTransport; log: Logger }): Qloo {
  const { live, demo, log } = opts;
  return {
    mode: live ? "live" : "demo",
    reply(client) {
      let current: QlooTransport = live ?? demo;
      let mode: Mode = live ? "live" : "demo";
      let notice: Notice | undefined;
      const calls: QlooCallTrace[] = [];

      async function call<E extends Endpoint>(endpoint: E, params: Params) {
        const started = performance.now();
        let got: { body: unknown; cached: boolean };
        // The transport this call used: parallel calls in one reply may each fall back.
        const used = current;
        try {
          got = await used.get(endpoint, params, client);
        } catch (e) {
          if (used !== live || !fallsBack(e)) {
            calls.push({ endpoint: ENDPOINT_PATHS[endpoint], ms: Math.round(performance.now() - started), cached: false });
            throw e;
          }
          // A 403 can also mean an unsupported entity type (a code bug), so the line keeps it visible.
          // "quota" is the whole app's daily cap, "client_quota" one client's.
          log({ level: "warn", event: "qloo_fallback", qloo_fallback: e.kind === "quota" ? e.reason : e.status, endpoint: ENDPOINT_PATHS[endpoint] });
          current = demo;
          mode = "demo";
          notice = "live_unavailable";
          got = await demo.get(endpoint, params);
        }
        calls.push({ endpoint: ENDPOINT_PATHS[endpoint], ms: Math.round(performance.now() - started), cached: got.cached });
        const parsed = PARSERS[endpoint].safeParse(got.body);
        if (!parsed.success) {
          log({ level: "warn", event: "qloo_shape_mismatch", endpoint: ENDPOINT_PATHS[endpoint], mismatches: checkShape(endpoint, got.body).mismatches });
          throw new QlooError("bad_response", 200, "bad_response", "Qloo's response did not match the expected shape");
        }
        return parsed.data;
      }

      return {
        search: (query, type, take) => call("search", searchParams(query, type, take)) as Promise<SearchResponse>,
        tags: (query, take) => call("tags", tagsParams(query, take)) as Promise<TagsResponse>,
        insights: (p) => call("insights", insightsParams(p)) as Promise<InsightsResponse>,
        get mode() {
          return mode;
        },
        get notice() {
          return notice;
        },
        calls,
      };
    },
  };
}

/** The app's Qloo: live when the config has a key, else demo. */
export function qlooFromConfig(config: Config, demo: QlooTransport, log: Logger, extra: { fetch?: FetchLike; now?: () => number; timeoutMs?: number } = {}): Qloo {
  const key = config.qlooKey;
  const live = key
    ? createLiveTransport({
        base: config.qlooBase,
        key,
        dailyCalls: config.qlooDailyCalls,
        clientDailyCalls: config.qlooClientDailyCalls,
        log,
        now: extra.now,
        fetch: extra.fetch,
        timeoutMs: extra.timeoutMs,
      })
    : undefined;
  return createQloo({ live, demo, log });
}
