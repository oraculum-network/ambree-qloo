// The three tools, in demo mode (fixtures) and against a local mock Qloo (live mode).

import { afterEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../src/log.ts";
import { PLACE_TYPE, insightsParams } from "../src/qloo/client.ts";
import { InsightsResponse } from "../src/qloo/contract.ts";
import { createDemoTransport } from "../src/qloo/fixtures.ts";
import type { ToolOutcome } from "../src/tools/context.ts";
import { type PlanDayOutput, planDay, planDayInput, planDayOutput } from "../src/tools/plan-day.ts";
import { MU_BY_COUNTRY, MU_BY_LOCATION, MU_FILTER, rankIn, rankPlaces, rankPlacesInput } from "../src/tools/rank-places.ts";
import { resolveTastes, resolveTastesInput } from "../src/tools/resolve-tastes.ts";
import { sentences } from "../src/tools/speech.ts";
import type { ServerResponse } from "node:http";
import { FILTER_TAGS } from "../src/tools/places.ts";
import { type MockPlace, demoDeps, liveDeps, qlooHandler, startQlooMock } from "./helpers/deps.ts";
import { type MockServer, type RecordedRequest, json, queryOf, startMockServer } from "./helpers/mock-server.ts";
import { liveInsightsBody, liveSearchBody, liveTagsBody } from "./helpers/shapes.ts";

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

const SIGHT = { genre: "urn:tag:genre:place:tourist_attraction", tagIds: [FILTER_TAGS.thingsToDo] };
const RESTAURANT = { genre: "urn:tag:genre:place:restaurant", tagIds: [FILTER_TAGS.restaurant, "urn:tag:category:place:restaurant"] };
const BAR = { genre: "urn:tag:genre:place:restaurant:bar", tagIds: [FILTER_TAGS.bar] };
const RESORT = { genre: "urn:tag:genre:place:hotel:resort", tagIds: ["urn:tag:category:place:resort_hotel", FILTER_TAGS.thingsToDo, FILTER_TAGS.restaurant, FILTER_TAGS.bar] };

const FULL_DAY: MockPlace[] = [
  { name: "Morning Spot", town: "Port Louis", country: "MU", tags: ["Museum"], ...SIGHT, affinity: 0.95 },
  { name: "Lunch Spot", town: "Port Louis", country: "MU", tags: ["Seafood Restaurant"], ...RESTAURANT, affinity: 0.9 },
  { name: "Afternoon Spot", town: "Grand Baie", country: "MU", tags: ["Beach"], ...SIGHT, affinity: 0.85 },
  { name: "Evening Spot", town: "Grand Baie", country: "MU", tags: ["Cocktail Bar"], ...BAR, affinity: 0.8 },
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

  it("no match is logged with endpoint, status and type, never the taste", async () => {
    mock = await startQlooMock({ notFound: ["Gone Film"] });
    const logs: LogRecord[] = [];
    ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "film", name: "Gone Film" }] }), liveDeps(mock, logs)));
    expect(logs).toContainEqual({ level: "info", event: "qloo_no_match", endpoint: "/search", status: 404, type: "urn:entity:movie" });
    expect(JSON.stringify(logs)).not.toContain("Gone Film");
  });

  it("a 403 for one entity type → that taste unresolved, the rest of the reply stays live", async () => {
    mock = await startQlooMock();
    const normal = qlooHandler({});
    mock.setHandler((req, res) => {
      if (queryOf(req).types === "urn:entity:videogame") {
        return json(res, 403, { code: 403, reason: "Forbidden", message: "You do not have permission to access urn:entity:videogame" });
      }
      return normal(req, res);
    });
    const logs: LogRecord[] = [];
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "game", name: "Animal Crossing" }] }), liveDeps(mock, logs)));
    expect(out.mode).toBe("live");
    expect(out.notice).toBeUndefined();
    expect(out.signals.map((s) => s.input)).toEqual(["Kaya"]);
    expect(out.unresolved).toEqual([{ input: "Animal Crossing", kind: "game" }]);
    expect(logs).toContainEqual(expect.objectContaining({ level: "warn", event: "qloo_no_match", status: 403, type: "urn:entity:videogame" }));
    expect(logs.some((l) => l.event === "qloo_fallback")).toBe(false);
    // A 403 that names no entity type still means the key is unusable: the reply falls back.
    mock.setHandler((_req, res) => json(res, 403, { code: 403, reason: "Forbidden" }));
    const dead = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(dead).toMatchObject({ mode: "demo", notice: "live_unavailable" });
  });

  it("demo mode: every taste resolves to a synthetic entity or tag", async () => {
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "food", name: "seafood" }] }), demoDeps()));
    expect(out.mode).toBe("demo");
    expect(out.signals.map((s) => [s.name, s.id])).toEqual([
      ["Kaya (demo)", "00000000-0000-4000-8000-0001" + out.signals[0]!.id.slice(-8)],
      ["Seafood (demo)", "urn:tag:genre:place:restaurant:seafood"],
    ]);
    expect(out.speech).toBe("I matched Kaya and Seafood on Qloo. This uses demo data, not live Qloo results.");
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
    // A spoken place with no country code: the speech doesn't claim "in Mauritius".
    expect(out.speech).toBe("Qloo's top places for you are Here in Curepipe and Unknown Code.");
    const q = insightsCalls(mock)[0]!;
    expect(q).toMatchObject({ "filter.type": "urn:entity:place", "signal.interests.entities": "e1", "filter.geocode.country_code": "MU", "feature.explainability": "true", take: "15" });
  });

  it("the MU filter: country code by default; the location fallback sends filter.location.query and the guard still keeps MU", async () => {
    expect(MU_FILTER).toBe(MU_BY_COUNTRY);
    const byLocation = insightsParams({ type: PLACE_TYPE, entities: ["e1"], ...MU_BY_LOCATION, take: 5 });
    expect(byLocation["filter.location.query"]).toBe("Mauritius");
    expect(byLocation["filter.geocode.country_code"]).toBeUndefined();
    mock = await startQlooMock({ places: [{ name: "Here", country: "MU", affinity: 0.9 }, { name: "Lower Case", country: "mu", affinity: 0.8 }, { name: "Abroad", country: "RE", affinity: 0.7 }] });
    const { places, dropped_non_mu } = await rankIn(liveDeps(mock).qloo.reply(), { type: PLACE_TYPE, entities: ["e1"], take: 5 }, new Map());
    expect(places.map((p) => p.name)).toEqual(["Here", "Lower Case"]);
    expect(dropped_non_mu).toBe(1);
    // The demo transport answers the fallback too, and only for Mauritius.
    const demo = createDemoTransport();
    const count = async (locationQuery: string) =>
      InsightsResponse.parse((await demo.get("insights", insightsParams({ type: PLACE_TYPE, entities: ["e1"], locationQuery, take: 50 }))).body).results.entities.length;
    expect(await count("Mauritius")).toBeGreaterThan(0);
    expect(await count("France")).toBe(0);
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
  it("plan_day fills 4 slots from distinct places, ordered: one Insights call per kind of stop", async () => {
    mock = await startQlooMock({ places: [...FULL_DAY].reverse() });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => [s.slot, s.kind, s.place])).toEqual([
      ["morning", "thing_to_do", "Morning Spot"],
      ["lunch", "restaurant", "Lunch Spot"],
      ["afternoon", "thing_to_do", "Afternoon Spot"],
      ["evening", "bar", "Evening Spot"],
    ]);
    const calls = insightsCalls(mock);
    expect(calls.map((q) => q["filter.tags"]).sort()).toEqual(
      ["urn:tag:category:place:bar", "urn:tag:category:place:tourist_attraction", "urn:tag:genre:place:restaurant"],
    );
    expect(calls.every((q) => q.take === "25" && q["filter.geocode.country_code"] === "MU")).toBe(true);
    expect(out.speech).toBe(
      "Start at Morning Spot in Port Louis, have lunch at Lunch Spot, spend the afternoon at Afternoon Spot in Grand Baie and end the evening at Evening Spot.",
    );
    expect(out.qloo_calls.map((c) => c.endpoint)).toEqual(["/search", "/v2/insights", "/v2/insights", "/v2/insights"]);
  });

  it("a hotel or resort is never a sight; a meal takes one only after every stand-alone place", async () => {
    // The resort has the best score and every filter tag, as live resorts often do.
    const places: MockPlace[] = [{ name: "Big Resort", country: "MU", ...RESORT, affinity: 0.99 }, ...FULL_DAY];
    mock = await startQlooMock({ places });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => s.place)).toEqual(["Morning Spot", "Lunch Spot", "Afternoon Spot", "Evening Spot"]);
    // With no stand-alone restaurant or bar left for the evening, the resort's restaurant is used.
    mock.setHandler(qlooHandler({ places: [{ name: "Big Resort", country: "MU", ...RESORT, affinity: 0.99 }, ...FULL_DAY.slice(0, 3)] }));
    const late = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Someone" }] }), liveDeps(mock)));
    expect(late.day.map((s) => [s.slot, s.kind, s.place])).toEqual([
      ["morning", "thing_to_do", "Morning Spot"],
      ["lunch", "restaurant", "Lunch Spot"],
      ["afternoon", "thing_to_do", "Afternoon Spot"],
      ["evening", "bar", "Big Resort"],
    ]);
  });

  it("lunch prefers a restaurant to a bar Qloo files as a restaurant; the evening prefers the bar", async () => {
    const barAsRestaurant = { genre: "urn:tag:genre:place:restaurant:bar", tagIds: [FILTER_TAGS.restaurant, FILTER_TAGS.bar] };
    mock = await startQlooMock({
      places: [
        { name: "Sight", country: "MU", ...SIGHT, affinity: 0.9 },
        { name: "Pub With Food", country: "MU", ...barAsRestaurant, affinity: 0.95 },
        { name: "Kitchen", country: "MU", ...RESTAURANT, affinity: 0.6 },
      ],
    });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }], pace: "relaxed" }), liveDeps(mock)));
    expect(out.day.map((s) => [s.slot, s.kind, s.place])).toEqual([
      ["morning", "thing_to_do", "Sight"],
      ["lunch", "restaurant", "Kitchen"],
      ["evening", "bar", "Pub With Food"],
    ]);
  });

  describe("the food taste shapes the meals", () => {
    const SEAFOOD_TAG = { id: "urn:tag:genre:place:restaurant:seafood", name: "Seafood", parents: [{ type: "urn:entity:place" }] };
    const seafood = (affinity: number, name = "Fish Shack"): MockPlace => ({ name, country: "MU", ...RESTAURANT, tagIds: [...RESTAURANT.tagIds, "urn:tag:cuisine:qloo:seafood"], affinity });
    const tastes = (more: Array<{ kind: string; name: string }> = []) => planDayInput.parse({ tastes: [{ kind: "film", name: "Some Film" }, { kind: "food", name: "seafood" }, ...more] });

    it("lunch is the place tagged with the cuisine, even below a higher-scored restaurant; the food tag steers only the meal calls", async () => {
      mock = await startQlooMock({
        tags: [SEAFOOD_TAG],
        places: [{ name: "Sight", country: "MU", ...SIGHT, affinity: 0.9 }, { name: "Steakhouse", country: "MU", ...RESTAURANT, affinity: 0.95 }, seafood(0.5)],
      });
      const out = ok(await planDay(tastes(), liveDeps(mock)));
      const lunch = out.day.find((s) => s.slot === "lunch")!;
      expect(lunch.place).toBe("Fish Shack");
      expect(lunch.why).toContain("Tagged Seafood, matching your seafood.");
      const byFilter = Object.fromEntries(insightsCalls(mock).map((q) => [q["filter.tags"], q["signal.interests.tags"]]));
      expect(byFilter).toEqual({
        [FILTER_TAGS.thingsToDo]: undefined,
        [FILTER_TAGS.restaurant]: SEAFOOD_TAG.id,
        [FILTER_TAGS.bar]: SEAFOOD_TAG.id,
      });
    });

    it("a stand-alone restaurant still beats a hotel that serves the cuisine", async () => {
      const hotelSeafood: MockPlace = { name: "Hotel Grill", country: "MU", genre: "urn:tag:genre:place:hotel", tagIds: [FILTER_TAGS.restaurant, "urn:tag:cuisine:qloo:seafood"], affinity: 0.99 };
      mock = await startQlooMock({ tags: [SEAFOOD_TAG], places: [hotelSeafood, { name: "Steakhouse", country: "MU", ...RESTAURANT, affinity: 0.5 }] });
      const out = ok(await planDay(tastes(), liveDeps(mock)));
      expect(out.day.find((s) => s.slot === "lunch")!.place).toBe("Steakhouse");
    });

    it("no place serves the cuisine: lunch is the top restaurant, and the why says so", async () => {
      mock = await startQlooMock({ tags: [SEAFOOD_TAG], places: [{ name: "Steakhouse", country: "MU", ...RESTAURANT, affinity: 0.7 }] });
      const out = ok(await planDay(tastes(), liveDeps(mock)));
      const lunch = out.day.find((s) => s.slot === "lunch")!;
      expect(lunch.place).toBe("Steakhouse");
      expect(lunch.why).toMatch(/No seafood place came up here, so this is the top restaurant\.$/);
    });

    it("with no music taste the evening is dinner in the same cuisine; with one it prefers live music", async () => {
      const places: MockPlace[] = [
        { name: "Sight", country: "MU", ...SIGHT, affinity: 0.9 },
        seafood(0.8, "Fish Shack"),
        seafood(0.6, "Crab House"),
        { name: "Cocktail Bar", country: "MU", ...BAR, affinity: 0.95 },
        { name: "Music Bar", country: "MU", ...BAR, tagIds: [...BAR.tagIds, "urn:tag:amenity:qloo:live_music"], affinity: 0.7 },
      ];
      mock = await startQlooMock({ tags: [SEAFOOD_TAG], places });
      const dinner = ok(await planDay(tastes(), liveDeps(mock)));
      expect(dinner.day.map((s) => [s.slot, s.kind, s.place])).toEqual([
        ["morning", "thing_to_do", "Sight"],
        ["lunch", "restaurant", "Fish Shack"],
        ["evening", "restaurant", "Crab House"],
      ]);
      expect(dinner.day[2]!.why).toContain("Tagged Seafood, matching your seafood.");
      const music = ok(await planDay(tastes([{ kind: "music", name: "Some Band" }]), liveDeps(mock)));
      expect(music.day.at(-1)).toMatchObject({ slot: "evening", kind: "bar", place: "Music Bar" });
      expect(music.day.at(-1)!.why).toContain("Tagged Live music.");
      // Neither taste: the evening is the best bar.
      const plain = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "film", name: "Some Film" }] }), liveDeps(mock)));
      expect(plain.day.at(-1)).toMatchObject({ kind: "bar", place: "Cocktail Bar" });
    });
  });

  it("a slot with no place of its kind is left out, never filled with another kind", async () => {
    mock = await startQlooMock({ places: [0.9, 0.8, 0.7].map((a, i) => ({ name: `Sight ${i}`, country: "MU", ...SIGHT, affinity: a })) });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => [s.slot, s.place])).toEqual([
      ["morning", "Sight 0"],
      ["afternoon", "Sight 1"],
    ]);
  });

  it("demo: 4 distinct fixture places, ordered by slot", async () => {
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "food", name: "street food" }] }), demoDeps()));
    expect(out.mode).toBe("demo");
    expect(out.day.map((s) => s.slot)).toEqual(["morning", "lunch", "afternoon", "evening"]);
    expect(new Set(out.day.map((s) => s.place_id)).size).toBe(4);
    expect(out.day.every((s) => s.place.endsWith("(demo)"))).toBe(true);
    expect(out.day.map((s) => s.kind)).toEqual(["thing_to_do", "restaurant", "thing_to_do", expect.stringMatching(/^(bar|restaurant)$/)]);
    // The fixtures' hotels never appear as a sight.
    expect(out.day.filter((s) => s.kind === "thing_to_do").map((s) => s.place).join()).not.toMatch(/Resort|Hotel/);
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
    expect(demo.day.every((s) => s.why.startsWith("Because you like Kaya."))).toBe(true);
  });

  it("a stop with no country code from Qloo keeps location_unverified", async () => {
    mock = await startQlooMock({ places: [{ name: "Sure", country: "MU", ...SIGHT, affinity: 0.9 }, { name: "Unsure", ...SIGHT, affinity: 0.8 }] });
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] }), liveDeps(mock)));
    expect(out.day.map((s) => [s.place, s.location_unverified])).toEqual([
      ["Sure", undefined],
      ["Unsure", true],
    ]);
    expect(planDayOutput.safeParse(out).success).toBe(true);
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

  it("a live 200 that breaks the contract → isError 'couldn't read', no demo fallback, mismatch paths logged", async () => {
    // What the live pod did on 27 Oct before the contract fix, with an object where /search has its list.
    mock = await startQlooMock();
    mock.setHandler((_req, res) => json(res, 200, { results: { entities: [] } }));
    const logs: LogRecord[] = [];
    const r = await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Bob Marley" }, { kind: "food", name: "seafood" }] }), liveDeps(mock, logs));
    expect(r).toEqual({ ok: false, message: "Qloo sent an answer I couldn't read, so I can't do that right now." });
    expect(logs).toContainEqual({ level: "warn", event: "qloo_shape_mismatch", endpoint: "/search", mismatches: ["$.results expected array, got object"] });
    expect(logs).toContainEqual({ level: "warn", event: "qloo_error", kind: "bad_response", status: 200 });
    expect(logs.some((l) => l.event === "qloo_fallback")).toBe(false);
    expect(insightsCalls(mock)).toHaveLength(0);
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

describe("live shapes (27 Oct 2026, synthetic values)", () => {
  /** A mock Qloo answering in the live shapes: no `success` on /search, null regions, no affinity. */
  function liveShapes(insights: () => unknown = () => liveInsightsBody(5)) {
    return (req: RecordedRequest, res: ServerResponse) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, liveSearchBody([`${queryOf(req).query} (demo)`]));
      if (path === "/v2/tags") return json(res, 200, liveTagsBody(3));
      if (path === "/v2/insights") return json(res, 200, insights());
      json(res, 404, {});
    };
  }

  it("plan_day: a live day in Qloo's order, town only where Qloo gave one, score 0, nothing null", async () => {
    mock = await startMockServer(liveShapes());
    const logs: LogRecord[] = [];
    const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Bob Marley" }, { kind: "food", name: "seafood" }] }), liveDeps(mock, logs)));
    expect(logs.some((l) => l.event === "qloo_shape_mismatch")).toBe(false);
    expect(out).toMatchObject({ mode: "live", unresolved: [] });
    expect(out.notice).toBeUndefined();
    // The mock sends the same 5 places to every call; the resort (place 4) is never used.
    expect(out.day.map((s) => [s.slot, s.kind, s.place, s.town])).toEqual([
      ["morning", "thing_to_do", "Live Shape Place 0 (demo)", "Port Louis"],
      ["lunch", "restaurant", "Live Shape Place 1 (demo)", undefined],
      ["afternoon", "thing_to_do", "Live Shape Place 2 (demo)", undefined],
      ["evening", "bar", "Live Shape Place 3 (demo)", undefined],
    ]);
    for (const s of out.day) {
      expect(s.affinity).toBe(0);
      expect(s.location_unverified).toBeUndefined();
      expect(s.tags).toContain("Test tag 0 (demo)");
    }
    // The food tag is a signal for the meals only; no place carries a seafood tag.
    expect(out.day.map((s) => s.why)).toEqual([
      "A strong Qloo match for your tastes.",
      "Because you like seafood. No seafood place came up here, so this is the top restaurant.",
      "A strong Qloo match for your tastes.",
      "Because you like seafood.",
    ]);
    expect(out.day[1]).not.toHaveProperty("town");
    expect(JSON.stringify(out)).not.toContain("null");
    expect(planDayOutput.parse(out)).toEqual(out);
    expect(out.speech).toBe(
      "Start at Live Shape Place 0 in Port Louis, have lunch at Live Shape Place 1, spend the afternoon at Live Shape Place 2 and end the evening at Live Shape Place 3.",
    );
  });

  it("rank_places: a null country code or geocode is unverified (kept, not 'in Mauritius'); another country is dropped; a nameless tag is skipped", async () => {
    mock = await startMockServer(
      liveShapes(() => {
        const body = liveInsightsBody(4);
        const [e0, e1, e2, e3] = body.results.entities as Array<Record<string, unknown>>;
        (e0!.tags as unknown[]).push({ id: "urn:tag:demo:nameless", name: null });
        (e1!.properties as { geocode: { country_code: string | null } }).geocode.country_code = null;
        e2!.properties = null;
        (e3!.properties as { geocode: { country_code: string } }).geocode.country_code = "FR";
        return body;
      }),
    );
    const out = ok(await rankPlaces(rankPlacesInput.parse({ entity_ids: ["e1"] }), liveDeps(mock)));
    expect(out.places.map((p) => [p.name, p.town, p.location_unverified])).toEqual([
      ["Live Shape Place 0 (demo)", "Port Louis", undefined],
      ["Live Shape Place 1 (demo)", undefined, true],
      ["Live Shape Place 2 (demo)", undefined, true],
    ]);
    expect(out.places[0]!.tags).toEqual(["Test tag 0 (demo)", "Tourist attraction (demo)"]);
    expect(out.dropped_non_mu).toBe(1);
    expect(out.speech).toBe("Qloo's top places for you are Live Shape Place 0 in Port Louis, Live Shape Place 1 and Live Shape Place 2.");
    expect(JSON.stringify(out)).not.toContain("null");
  });

  it("resolve_tastes: /search with no `success` resolves", async () => {
    mock = await startMockServer(liveShapes());
    const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "music", name: "Bob Marley" }] }), liveDeps(mock)));
    expect(out.signals).toEqual([{ input: "Bob Marley", kind: "music", id: "00000000-0000-4000-8000-000000000700", name: "Bob Marley (demo)", source: "entity" }]);
    expect(out.speech).toBe("I matched Bob Marley on Qloo.");
  });
});
