// The three tools, in demo mode (fixtures) and against a local mock Qloo (live mode).

import { afterEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../src/log.ts";
import type { ToolOutcome } from "../src/tools/context.ts";
import { type PlanDayOutput, planDay, planDayInput } from "../src/tools/plan-day.ts";
import { rankPlaces, rankPlacesInput } from "../src/tools/rank-places.ts";
import { resolveTastes, resolveTastesInput } from "../src/tools/resolve-tastes.ts";
import { sentences } from "../src/tools/speech.ts";
import { demoDeps, liveDeps, startQlooMock } from "./helpers/deps.ts";
import { type MockServer, json, queryOf } from "./helpers/mock-server.ts";

let mock: MockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function ok<T>(o: ToolOutcome<T>): T {
  if (!o.ok) throw new Error(`expected ok, got: ${o.message}`);
  return o.value;
}

const searches = (m: MockServer) => m.requests.filter((r) => r.url.startsWith("/search")).map(queryOf);
const insightsCalls = (m: MockServer) => m.requests.filter((r) => r.url.startsWith("/v2/insights")).map(queryOf);

const FULL_DAY = [
  { name: "Morning Spot", town: "Port Louis", country: "MU", tags: ["Museum"], affinity: 0.95 },
  { name: "Lunch Spot", town: "Port Louis", country: "MU", tags: ["Seafood Restaurant"], affinity: 0.9 },
  { name: "Afternoon Spot", town: "Grand Baie", country: "MU", tags: ["Beach"], affinity: 0.85 },
  { name: "Evening Spot", town: "Grand Baie", country: "MU", tags: ["Cocktail Bar"], affinity: 0.8 },
];

describe("resolve_tastes", () => {
  it("resolve maps music→artist, film→movie, game→videogame", async () => {
    mock = await startQlooMock();
    const out = ok(
      await resolveTastes(
        resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "film", name: "Amelie" }, { kind: "game", name: "Tetris" }, { kind: "tv", name: "Some Show" }] }),
        liveDeps(mock),
      ),
    );
    expect(Object.fromEntries(searches(mock).map((q) => [q.query, q.types]))).toEqual({
      Kaya: "urn:entity:artist",
      Amelie: "urn:entity:movie",
      Tetris: "urn:entity:videogame",
      "Some Show": "urn:entity:tv_show",
    });
    expect(searches(mock).every((q) => q.take === "1")).toBe(true);
    expect(out.mode).toBe("live");
    expect(out.signals.map((s) => [s.input, s.source, s.name])).toEqual([
      ["Kaya", "entity", "Kaya Match"],
      ["Amelie", "entity", "Amelie Match"],
      ["Tetris", "entity", "Tetris Match"],
      ["Some Show", "entity", "Some Show Match"],
    ]);
    expect(out.qloo_calls).toHaveLength(4);
  });

  it("food goes to /v2/tags", async () => {
    mock = await startQlooMock();
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "food", name: "street food" }] }), liveDeps(mock)));
    expect(mock.requests.map((r) => new URL(r.url, "http://x").pathname)).toEqual(["/v2/tags"]);
    expect(queryOf(mock.requests[0]!)["filter.query"]).toBe("street food");
    expect(out.signals).toEqual([{ input: "street food", kind: "food", id: "urn:tag:test:street_food", name: "Street Food", source: "tag" }]);
  });

  it("food tags that can't describe a place are skipped", async () => {
    mock = await startQlooMock({ tags: [{ id: "urn:tag:test:genre", name: "Food Films", parents: [{ type: "urn:entity:movie" }] }] });
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "food", name: "food" }] }), liveDeps(mock)));
    expect(out.signals).toEqual([]);
    expect(out.unresolved).toEqual([{ input: "food", kind: "food" }]);
  });

  it("unresolved tastes listed, not invented", async () => {
    mock = await startQlooMock({ noMatch: ["Nobody Knows"] });
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "book", name: "Nobody Knows" }] }), liveDeps(mock)));
    expect(out.signals.map((s) => s.input)).toEqual(["Kaya"]);
    expect(out.unresolved).toEqual([{ input: "Nobody Knows", kind: "book" }]);
    expect(out.speech).toBe("I matched Kaya Match on Qloo. I couldn't find Nobody Knows.");
  });

  it("search 404 or empty → unresolved, not isError", async () => {
    mock = await startQlooMock({ notFound: ["Gone"], noMatch: ["Empty"] });
    const r = await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "film", name: "Gone" }, { kind: "film", name: "Empty" }] }), liveDeps(mock));
    expect(r.ok).toBe(true);
    const out = ok(r);
    expect(out.unresolved.map((u) => u.input)).toEqual(["Gone", "Empty"]);
    expect(out.signals).toEqual([]);
    expect(out.speech).toMatch(/^Qloo had no match for Gone or Empty/);
    mock.setHandler((_req, res) => json(res, 400, { code: 400, reason: "Bad Request", message: "no entities matched" }));
    expect(ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "film", name: "X" }] }), liveDeps(mock))).unresolved).toHaveLength(1);
  });

  it("demo mode: every taste resolves to a synthetic entity or tag", async () => {
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "food", name: "seafood" }] }), demoDeps()));
    expect(out.mode).toBe("demo");
    expect(out.signals.map((s) => s.name)).toEqual(["Kaya (demo)", "Seafood restaurant (demo)"]);
    expect(out.speech).toBe("I matched Kaya and Seafood restaurant on Qloo. This uses demo data, not live Qloo results.");
  });
});

describe("rank_places", () => {
  it("rank drops non-MU results and counts them", async () => {
    mock = await startQlooMock({
      places: [
        { name: "Abroad", town: "Paris", country: "FR", affinity: 0.99 },
        { name: "Here", town: "Curepipe", country: "MU", affinity: 0.9 },
        { name: "Unknown Code", affinity: 0.8 },
      ],
    });
    const out = ok(await rankPlaces(rankPlacesInput.parse({ entity_ids: ["e1"] }), liveDeps(mock)));
    expect(out.places.map((p) => p.name)).toEqual(["Here", "Unknown Code"]);
    expect(out.dropped_non_mu).toBe(1);
    expect(out.places[1]!.location_unverified).toBe(true);
    expect(out.places[0]!.location_unverified).toBeUndefined();
    const q = insightsCalls(mock)[0]!;
    expect(q).toMatchObject({ "filter.type": "urn:entity:place", "signal.interests.entities": "e1", "filter.geocode.country_code": "MU", "feature.explainability": "true", take: "15" });
  });

  it("destination without entity_ids is an isError", async () => {
    const r = await rankPlaces(rankPlacesInput.parse({ kind: "destination", tag_ids: ["urn:tag:demo:place:beach"] }), demoDeps());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/entity_ids/);
    const none = await rankPlaces(rankPlacesInput.parse({}), demoDeps());
    expect(none.ok).toBe(false);
  });

  it("destinations rank with filter.type urn:entity:destination", async () => {
    const out = ok(await rankPlaces(rankPlacesInput.parse({ kind: "destination", entity_ids: ["00000000-0000-4000-8000-000100000001"], take: 3 }), demoDeps()));
    expect(out.kind).toBe("destination");
    expect(out.places).toHaveLength(3);
    expect(out.speech).toMatch(/^Qloo's top destinations in Mauritius for you are /);
  });

  it("vibe resolves to filter.tags", async () => {
    mock = await startQlooMock({ tags: [{ id: "urn:tag:test:beach", name: "Beach", parents: [{ type: "urn:entity:place" }] }], places: FULL_DAY });
    ok(await rankPlaces(rankPlacesInput.parse({ entity_ids: ["e1"], vibe: "beach", town: "Grand Baie" }), liveDeps(mock)));
    expect(queryOf(mock.requests[0]!)["filter.query"]).toBe("beach");
    const q = insightsCalls(mock)[0]!;
    expect(q["filter.tags"]).toBe("urn:tag:test:beach");
    expect(q["filter.geocode.name"]).toBe("Grand Baie");
    expect(q["signal.interests.tags"]).toBeUndefined();
  });

  it("a vibe alone is also the signal (demo)", async () => {
    const out = ok(await rankPlaces(rankPlacesInput.parse({ vibe: "beach", take: 3 }), demoDeps()));
    expect(out.places.length).toBeGreaterThan(0);
    expect(out.places.every((p) => p.tags.includes("Beach (demo)"))).toBe(true);
    expect(out.places[0]!.why).toEqual(["Beach (demo)"]);
  });

  it("insights empty → no places, said so", async () => {
    mock = await startQlooMock({ places: [] });
    const out = ok(await rankPlaces(rankPlacesInput.parse({ entity_ids: ["e1"] }), liveDeps(mock)));
    expect(out.places).toEqual([]);
    expect(out.speech).toBe("Qloo found no places in Mauritius for those tastes.");
  });

  it("insights 400 'at least one valid signal' → no places, not an error", async () => {
    mock = await startQlooMock();
    mock.setHandler((_req, res) => json(res, 400, { code: 400, reason: "Bad Request", message: "at least one valid signal or filter is required" }));
    const out = ok(await rankPlaces(rankPlacesInput.parse({ entity_ids: ["e1"] }), liveDeps(mock)));
    expect(out.places).toEqual([]);
  });
});

describe("plan_day", () => {
  it("plan_day fills 4 slots from distinct places, ordered", async () => {
    mock = await startQlooMock({ places: [...FULL_DAY].reverse() });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => [s.slot, s.place])).toEqual([
      ["morning", "Morning Spot"],
      ["lunch", "Lunch Spot"],
      ["afternoon", "Afternoon Spot"],
      ["evening", "Evening Spot"],
    ]);
    expect(insightsCalls(mock)).toHaveLength(1);
    expect(insightsCalls(mock)[0]!.take).toBe("30");
    expect(out.speech).toBe(
      "Start at Morning Spot in Port Louis, have lunch at Lunch Spot, spend the afternoon at Afternoon Spot in Grand Baie and end the evening at Evening Spot.",
    );
    expect(out.qloo_calls.map((c) => c.endpoint)).toEqual(["/search", "/v2/insights"]);
  });

  it("demo: 4 distinct fixture places, ordered by slot", async () => {
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "food", name: "street food" }] }), demoDeps()));
    expect(out.mode).toBe("demo");
    expect(out.day.map((s) => s.slot)).toEqual(["morning", "lunch", "afternoon", "evening"]);
    expect(new Set(out.day.map((s) => s.place_id)).size).toBe(4);
    expect(out.day.every((s) => s.place.endsWith("(demo)"))).toBe(true);
    expect(out.day[1]!.tags.join(" ")).toMatch(/restaurant|cafe|food/i);
  });

  it("relaxed = 3 stops", async () => {
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "film", name: "Amelie" }], pace: "relaxed" }), demoDeps()));
    expect(out.day.map((s) => s.slot)).toEqual(["morning", "lunch", "evening"]);
  });

  it("why names the contributing taste", async () => {
    mock = await startQlooMock({
      places: FULL_DAY.map((p) => ({ ...p, explain: [{ entity_id: "00000000-0000-4000-8000-000000000604", score: 1 }] })),
    });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    // The mock gives "Kaya" the ID id(600 + 4).
    expect(out.signals[0]!.id).toBe("00000000-0000-4000-8000-000000000604");
    expect(out.day[0]!.why).toBe("Because you like Kaya.");
    const demo = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), demoDeps()));
    expect(demo.day.every((s) => s.why === "Because you like Kaya.")).toBe(true);
  });

  it("ties prefer the previous stop's town", async () => {
    mock = await startQlooMock({
      places: [
        { name: "Start", town: "Chamarel", country: "MU", tags: ["Viewpoint"], affinity: 0.9 },
        { name: "Far Lunch", town: "Port Louis", country: "MU", tags: ["Cafe"], affinity: 0.801 },
        { name: "Near Lunch", town: "Chamarel", country: "MU", tags: ["Cafe"], affinity: 0.799 },
      ],
    });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => s.place)).toEqual(["Start", "Near Lunch", "Far Lunch"]);
  });

  it("an empty slot takes the next best place", async () => {
    mock = await startQlooMock({ places: [0.9, 0.8, 0.7, 0.6].map((a, i) => ({ name: `Sight ${i}`, country: "MU", tags: ["Museum"], affinity: a })) });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => s.place)).toEqual(["Sight 0", "Sight 1", "Sight 2", "Sight 3"]);
  });

  it("no tastes matched → an empty day, said so, no insights call", async () => {
    mock = await startQlooMock({ noMatch: ["Zzz"] });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Zzz" }] }), liveDeps(mock)));
    expect(out.day).toEqual([]);
    expect(insightsCalls(mock)).toHaveLength(0);
    expect(out.speech).toMatch(/^Qloo had no match for any of those tastes/);
  });

  it("Qloo 429/5xx/timeout → isError with spoken message", async () => {
    const cases: Array<[string, (m: MockServer) => void, RegExp]> = [
      ["429", (m) => m.setHandler((_q, res) => json(res, 429, { code: 429, reason: "Too Many Requests" })), /^Qloo is busy right now/],
      ["503", (m) => m.setHandler((_q, res) => json(res, 503, {})), /^I couldn't reach Qloo just now/],
      ["timeout", (m) => m.setHandler(async (_q, res) => {
        await new Promise((r) => setTimeout(r, 300));
        json(res, 200, {});
      }), /^I couldn't reach Qloo just now/],
    ];
    for (const [label, script, message] of cases) {
      const m = await startQlooMock();
      script(m);
      const logs: LogRecord[] = [];
      const r: ToolOutcome<PlanDayOutput> = await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(m, logs, { timeoutMs: 100 }));
      await m.close();
      expect(r.ok, label).toBe(false);
      const msg = r.ok ? "" : r.message;
      expect(msg, label).toMatch(message);
      expect(sentences(msg).length, label).toBeLessThanOrEqual(2);
      expect(logs.some((l) => l.event === "qloo_error"), label).toBe(true);
    }
  });

  it("a live 401 falls back to demo data, labelled", async () => {
    mock = await startQlooMock();
    mock.setHandler((_q, res) => json(res, 401, { code: 401, reason: "Unauthorized" }));
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.mode).toBe("demo");
    expect(out.notice).toBe("live_unavailable");
    expect(out.day).toHaveLength(4);
    expect(out.speech).toMatch(/ Live Qloo access isn't available right now, so this uses demo data\.$/);
  });
});
