// The live Qloo transport against a local mock server (never the real API).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { distanceKm, parsePoint } from "../src/geo.ts";
import type { LogRecord } from "../src/log.ts";
import { type QlooTransport, QlooError, createLiveTransport, createQloo, fallsBack, PLACE_TYPE } from "../src/qloo/client.ts";
import { type MockServer, json, queryOf, startMockServer } from "./helpers/mock-server.ts";
import { SENTINEL_KEY, insightsBodyA, searchBody, tagsBody } from "./helpers/shapes.ts";

let mock: MockServer;
let logs: LogRecord[];

beforeEach(async () => {
  logs = [];
  mock = await startMockServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/search") return json(res, 200, searchBody());
    if (path === "/v2/tags") return json(res, 200, tagsBody());
    if (path === "/v2/insights") return json(res, 200, insightsBodyA());
    json(res, 404, { code: 404, reason: "Not Found" });
  });
});
afterEach(async () => {
  await mock.close();
});

function live(extra: { dailyCalls?: number; timeoutMs?: number } = {}) {
  return createLiveTransport({ base: mock.url, key: SENTINEL_KEY, dailyCalls: extra.dailyCalls ?? 100, log: (r) => logs.push(r), timeoutMs: extra.timeoutMs });
}

function liveQloo(extra: { dailyCalls?: number; timeoutMs?: number; demo?: QlooTransport } = {}) {
  const demo: QlooTransport = extra.demo ?? { get: async () => ({ body: insightsBodyA(1), cached: false }) };
  return createQloo({ live: live(extra), demo, log: (r) => logs.push(r) });
}

async function errorOf(p: Promise<unknown>): Promise<QlooError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(QlooError);
    return e as QlooError;
  }
  throw new Error("expected a QlooError");
}

describe("requests", () => {
  it("sends X-Api-Key, never Authorization or a key query param", async () => {
    const r = liveQloo().reply();
    await r.search("Test", "urn:entity:artist");
    await r.tags("beach");
    await r.insights({ type: PLACE_TYPE, entities: ["e1"], countryCode: "MU", take: 5 });
    expect(mock.requests).toHaveLength(3);
    for (const req of mock.requests) {
      expect(req.method).toBe("GET");
      expect(req.headers["x-api-key"]).toBe(SENTINEL_KEY);
      expect(req.headers.authorization).toBeUndefined();
      expect(req.url).not.toContain(SENTINEL_KEY);
      expect(req.url.toLowerCase()).not.toMatch(/api_key|apikey|key=/);
    }
  });

  it("insights is GET with filter.type, signal.interests.entities, filter.geocode.country_code=MU, feature.explainability=true", async () => {
    await liveQloo().reply().insights({ type: PLACE_TYPE, entities: ["e1", "e2"], tags: ["urn:tag:demo:a"], countryCode: "MU", town: "Curepipe", take: 9 });
    const req = mock.requests[0]!;
    expect(new URL(req.url, "http://x").pathname).toBe("/v2/insights");
    expect(req.body).toBe("");
    expect(queryOf(req)).toEqual({
      "filter.type": "urn:entity:place",
      "signal.interests.entities": "e1,e2",
      "signal.interests.tags": "urn:tag:demo:a",
      "filter.geocode.country_code": "MU",
      "filter.geocode.name": "Curepipe",
      "feature.explainability": "true",
      take: "9",
    });
  });

  it("a radius goes as filter.location=POINT(lon lat) and filter.location.radius in metres, as live Qloo took it", async () => {
    await liveQloo().reply().insights({ type: PLACE_TYPE, entities: ["e1"], filterTags: ["urn:tag:category:place:bar"], countryCode: "MU", near: { lat: -20.45, lon: 57.33, radiusM: 12000.4 }, take: 25 });
    const q = queryOf(mock.requests[0]!);
    expect(q).toMatchObject({ "filter.tags": "urn:tag:category:place:bar", "filter.location": "POINT(57.33 -20.45)", "filter.location.radius": "12000", "filter.geocode.country_code": "MU" });
    expect(mock.requests[0]!.url).toContain("filter.location=POINT%2857.33+-20.45%29");
  });

  it("geo: distances in km and the WKT point Qloo takes", () => {
    expect(parsePoint("POINT(57.33 -20.45)")).toEqual({ lon: 57.33, lat: -20.45 });
    expect(parsePoint("POINT(57 -20)")).toEqual({ lon: 57, lat: -20 });
    expect(parsePoint("57.33,-20.45")).toBeUndefined();
    expect(parsePoint(undefined)).toBeUndefined();
    // 0.1 degree of latitude is about 11.1 km anywhere.
    expect(distanceKm({ lat: -20.3, lon: 57.4 }, { lat: -20.4, lon: 57.4 })).toBeCloseTo(11.12, 1);
    expect(distanceKm({ lat: -20.3, lon: 57.4 }, { lat: -20.3, lon: 57.4 })).toBe(0);
  });

  it("search sends query, types and take", async () => {
    await liveQloo().reply().search("Some Band", "urn:entity:artist", 1);
    expect(new URL(mock.requests[0]!.url, "http://x").pathname).toBe("/search");
    expect(queryOf(mock.requests[0]!)).toEqual({ query: "Some Band", types: "urn:entity:artist", take: "1" });
  });

  it("tags sends filter.query and take", async () => {
    await liveQloo().reply().tags("rooftop bar", 3);
    expect(new URL(mock.requests[0]!.url, "http://x").pathname).toBe("/v2/tags");
    expect(queryOf(mock.requests[0]!)).toEqual({ "filter.query": "rooftop bar", take: "3" });
  });
});

describe("errors and retries", () => {
  it("429 → QlooError, no retry", async () => {
    mock.setHandler((_req, res) => json(res, 429, { code: 429, reason: "Too Many Requests", message: "Rate limit exceeded" }));
    const e = await errorOf(liveQloo().reply().search("x", "urn:entity:artist"));
    expect(e.status).toBe(429);
    expect(e.reason).toBe("Too Many Requests");
    expect(e.message).toBe("Qloo returned 429 Too Many Requests: Rate limit exceeded");
    expect(mock.requests).toHaveLength(1);
  });

  it("500 then 200 → one retry", async () => {
    let n = 0;
    mock.setHandler((_req, res) => (n++ === 0 ? json(res, 500, {}) : json(res, 200, searchBody())));
    const out = await liveQloo().reply().search("x", "urn:entity:artist");
    expect(out.results).toHaveLength(1);
    expect(mock.requests).toHaveLength(2);
  });

  it("500 twice → QlooError after exactly one retry", async () => {
    mock.setHandler((_req, res) => json(res, 503, {}));
    const e = await errorOf(liveQloo().reply().search("x", "urn:entity:artist"));
    expect(e.status).toBe(503);
    expect(mock.requests).toHaveLength(2);
  });

  it("timeout → QlooError timeout", async () => {
    mock.setHandler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 400));
      json(res, 200, searchBody());
    });
    const e = await errorOf(liveQloo({ timeoutMs: 100 }).reply().search("x", "urn:entity:artist"));
    expect(e.kind).toBe("timeout");
    expect(mock.requests).toHaveLength(1);
  });

  it("a 302 to a second mock host is not followed, and the second host gets no request", async () => {
    const second = await startMockServer((_req, res) => json(res, 200, searchBody()));
    try {
      mock.setHandler((_req, res) => {
        res.writeHead(302, { Location: `${second.url}/search?query=x` });
        res.end();
      });
      const e = await errorOf(liveQloo().reply().search("x", "urn:entity:artist"));
      expect(e.kind).toBe("redirect");
      expect(second.requests).toHaveLength(0);
      expect(mock.requests).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it("error messages and logs never contain the key", async () => {
    mock.setHandler((_req, res) => json(res, 400, { code: 400, reason: `Bad key ${SENTINEL_KEY}`, message: `The key ${SENTINEL_KEY} is not valid` }));
    const e = await errorOf(liveQloo().reply().search("x", "urn:entity:artist"));
    expect(e.message).not.toContain(SENTINEL_KEY);
    expect(e.reason).not.toContain(SENTINEL_KEY);
    expect(e.message).toContain("[redacted]");
    mock.setHandler((_req, res) => json(res, 401, { code: 401, reason: "Unauthorized" }));
    await liveQloo().reply().insights({ type: PLACE_TYPE, entities: ["e1"], take: 3 });
    expect(logs.some((l) => l.event === "qloo_fallback")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL_KEY);
    expect(JSON.stringify(e)).not.toContain(SENTINEL_KEY);
  });

  it("a 200 that breaks the contract is a bad_response error, logged with paths only", async () => {
    mock.setHandler((_req, res) => json(res, 200, { success: true, results: { entities: [] } }));
    const e = await errorOf(liveQloo().reply().search("x", "urn:entity:artist"));
    expect(e.kind).toBe("bad_response");
    expect(logs.find((l) => l.event === "qloo_shape_mismatch")?.mismatches).toEqual(["$.results expected array, got object"]);
  });
});

describe("cache, cap and fallback", () => {
  it("cache hit makes no second request", async () => {
    const q = liveQloo();
    const a = q.reply();
    await a.search("x", "urn:entity:artist");
    const b = q.reply();
    await b.search("x", "urn:entity:artist");
    expect(mock.requests).toHaveLength(1);
    expect(a.calls[0]).toMatchObject({ endpoint: "/search", cached: false });
    expect(b.calls[0]).toMatchObject({ endpoint: "/search", cached: true });
  });

  it("daily cap → quota", async () => {
    const t = live({ dailyCalls: 1 });
    await t.get("search", { query: "a", types: "urn:entity:artist", take: "1" });
    const e = await errorOf(t.get("search", { query: "b", types: "urn:entity:artist", take: "1" }));
    expect(e.kind).toBe("quota");
    expect(mock.requests).toHaveLength(1);
    expect(t.callsToday()).toBe(1);
  });

  it("per-client budget: only that client hits it, retries count, a new day resets it", async () => {
    let t0 = Date.parse("2026-10-26T10:00:00Z");
    const t = createLiveTransport({ base: mock.url, key: SENTINEL_KEY, dailyCalls: 100, clientDailyCalls: 2, log: (r) => logs.push(r), now: () => t0 });
    const q = (s: string) => ({ query: s, types: "urn:entity:artist", take: "1" });
    await t.get("search", q("a"), "client-a");
    await t.get("search", q("b"), "client-a");
    const e = await errorOf(t.get("search", q("c"), "client-a"));
    expect(e.kind).toBe("quota");
    expect(e.reason).toBe("client_quota");
    expect(fallsBack(e)).toBe(true);
    // A cache hit is free, another client has its own budget, and no client means no budget.
    await t.get("search", q("a"), "client-a");
    await t.get("search", q("c"), "client-b");
    await t.get("search", q("d"));
    expect(mock.requests).toHaveLength(4);
    // A 5xx retry spends a second call.
    mock.setHandler((_req, res) => json(res, 503, {}));
    await errorOf(t.get("search", q("e"), "client-c"));
    expect((await errorOf(t.get("search", q("f"), "client-c"))).reason).toBe("client_quota");
    t0 += 24 * 3600 * 1000;
    mock.setHandler((_req, res) => json(res, 200, searchBody()));
    await t.get("search", q("g"), "client-a");
  });

  it("daily cap → that reply falls back to demo, labelled", async () => {
    const q = liveQloo({ dailyCalls: 0 });
    const r = q.reply();
    await r.insights({ type: PLACE_TYPE, entities: ["e1"], take: 3 });
    expect(r.mode).toBe("demo");
    expect(r.notice).toBe("live_unavailable");
    expect(logs).toContainEqual(expect.objectContaining({ event: "qloo_fallback", qloo_fallback: "quota" }));
  });

  it("401 → fixture fallback with notice", async () => {
    mock.setHandler((_req, res) => json(res, 401, { code: 401, reason: "Unauthorized", message: "No API key found in request" }));
    const demoCalls: string[] = [];
    const demo: QlooTransport = {
      get: async (endpoint) => {
        demoCalls.push(endpoint);
        return { body: insightsBodyA(2), cached: false };
      },
    };
    const q = liveQloo({ demo });
    expect(q.mode).toBe("live");
    const r = q.reply();
    expect(r.mode).toBe("live");
    const out = await r.insights({ type: PLACE_TYPE, entities: ["e1"], take: 3 });
    expect(out.results.entities).toHaveLength(2);
    expect(r.mode).toBe("demo");
    expect(r.notice).toBe("live_unavailable");
    // The rest of the reply stays on demo: no second live request.
    await r.insights({ type: PLACE_TYPE, entities: ["e2"], take: 3 });
    expect(mock.requests).toHaveLength(1);
    expect(demoCalls).toEqual(["insights", "insights"]);
    expect(logs).toContainEqual(expect.objectContaining({ event: "qloo_fallback", qloo_fallback: 401, endpoint: "/v2/insights" }));
    // A new reply tries live again.
    expect(q.reply().mode).toBe("live");
  });

  it("parallel calls that all get 403 each fall back", async () => {
    mock.setHandler((_req, res) => json(res, 403, { code: 403, reason: "Forbidden" }));
    const r = liveQloo().reply();
    const out = await Promise.all([1, 2, 3].map((n) => r.insights({ type: PLACE_TYPE, entities: [`e${n}`], take: 3 })));
    expect(out).toHaveLength(3);
    expect(r.mode).toBe("demo");
    expect(mock.requests).toHaveLength(3);
  });

  it("429 and 5xx do not fall back: they are errors", async () => {
    mock.setHandler((_req, res) => json(res, 429, {}));
    const r = liveQloo().reply();
    await errorOf(r.search("x", "urn:entity:artist"));
    expect(r.mode).toBe("live");
    expect(r.notice).toBeUndefined();
  });
});
