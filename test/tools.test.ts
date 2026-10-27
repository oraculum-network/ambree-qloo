// The three tools, in demo mode (fixtures) and against a local mock Qloo (live mode).

import { afterEach, describe, expect, it } from "vitest";
import type { LogRecord } from "../src/log.ts";
import { PLACE_TYPE, insightsParams } from "../src/qloo/client.ts";
import { InsightsResponse } from "../src/qloo/contract.ts";
import { createDemoTransport } from "../src/qloo/fixtures.ts";
import type { ToolOutcome } from "../src/tools/context.ts";
import { PLAN_CALL_BUDGET, type PlanDayOutput, ordinal, planDay, planDayInput, planDayOutput } from "../src/tools/plan-day.ts";
import { MU_BY_COUNTRY, MU_BY_LOCATION, MU_FILTER, rankIn, rankPlaces, rankPlacesInput } from "../src/tools/rank-places.ts";
import { resolveTastes, resolveTastesInput } from "../src/tools/resolve-tastes.ts";
import { sentences } from "../src/tools/speech.ts";
import type { ServerResponse } from "node:http";
import { FILTER_TAGS } from "../src/tools/places.ts";
import { type MockPlace, demoDeps, liveDeps, mockInsights, qlooHandler, startQlooMock } from "./helpers/deps.ts";
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
      expect(lunch.why).toMatch(/No seafood place came up nearby, so this is Qloo's top restaurant here\.$/);
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

  describe("one region per day", () => {
    // West coast (around -20.29, 57.36) and north coast (around -20.01, 57.58): about 40 km apart.
    const WEST = { lat: -20.29, lon: 57.36 };
    const at = (p: { lat: number; lon: number }, dLat = 0, dLon = 0) => ({ lat: p.lat + dLat, lon: p.lon + dLon });
    const NORTH = { lat: -20.01, lon: 57.58 };
    const music = planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }] });

    it("after the first stop, every call asks for places within 15 km of it, and far places are not used", async () => {
      mock = await startQlooMock({
        places: [
          { name: "West Beach", country: "MU", town: "Flic en Flac", ...SIGHT, ...WEST, affinity: 0.9 },
          { name: "North Island", country: "MU", ...SIGHT, ...NORTH, affinity: 0.85 },
          { name: "West Gardens", country: "MU", ...SIGHT, ...at(WEST, 0.05), affinity: 0.6 },
          { name: "North Grill", country: "MU", ...RESTAURANT, ...NORTH, affinity: 0.99 },
          { name: "West Grill", country: "MU", ...RESTAURANT, ...at(WEST, 0.01), affinity: 0.5 },
          { name: "North Bar", country: "MU", ...BAR, ...NORTH, affinity: 0.99 },
          { name: "West Bar", country: "MU", ...BAR, ...at(WEST, -0.02, 0.01), affinity: 0.4 },
        ],
      });
      const out = ok(await planDay(music, liveDeps(mock)));
      expect(out.day.map((s) => s.place)).toEqual(["West Beach", "West Grill", "West Gardens", "West Bar"]);
      expect(out.area).toEqual({ around: "Flic en Flac", radius_km: 15 });
      expect(out.day[0]!.km_from_start).toBeUndefined();
      expect(out.day.slice(1).map((s) => s.km_from_start)).toEqual([1.1, 5.6, 2.5]);
      const calls = insightsCalls(mock);
      // The island-wide first call, then restaurants and bars around it; the afternoon came from the first list.
      expect(calls).toHaveLength(3);
      expect(calls[0]!["filter.location"]).toBeUndefined();
      for (const q of calls.slice(1)) expect(q).toMatchObject({ "filter.location": "POINT(57.36 -20.29)", "filter.location.radius": "15000", "filter.geocode.country_code": "MU" });
      expect(planDayOutput.parse(out)).toEqual(out);
    });

    it("no second sight in the first list nearby: the afternoon asks Qloo around the first stop", async () => {
      // The mock returns at most `take` places per call, so 25 far sights hide the near one from the island-wide call.
      const far = Array.from({ length: 25 }, (_, i): MockPlace => ({ name: `Far Sight ${i}`, country: "MU", ...SIGHT, ...NORTH, affinity: 0.8 - i / 100 }));
      const places: MockPlace[] = [
        { name: "West Beach", country: "MU", ...SIGHT, ...WEST, affinity: 0.9 },
        ...far,
        { name: "West Gardens", country: "MU", ...SIGHT, ...at(WEST, 0.05), affinity: 0.1 },
        { name: "West Grill", country: "MU", ...RESTAURANT, ...WEST, affinity: 0.5 },
        { name: "West Bar", country: "MU", ...BAR, ...WEST, affinity: 0.4 },
      ];
      mock = await startQlooMock();
      mock.setHandler((req, res) => {
        const q = queryOf(req);
        if (req.url.startsWith("/v2/insights")) return json(res, 200, { results: { entities: mockInsights(places, q).slice(0, Number(q.take)) } });
        return qlooHandler({})(req, res);
      });
      const out = ok(await planDay(music, liveDeps(mock)));
      expect(out.day.map((s) => s.place)).toEqual(["West Beach", "West Grill", "West Gardens", "West Bar"]);
      const sightCalls = insightsCalls(mock).filter((q) => q["filter.tags"] === FILTER_TAGS.thingsToDo);
      expect(sightCalls.map((q) => q["filter.location.radius"])).toEqual([undefined, "15000"]);
    });

    it("too few places within 15 km: widen once to 25 km for the empty slots, never further", async () => {
      mock = await startQlooMock({
        places: [
          { name: "West Beach", country: "MU", ...SIGHT, ...WEST, affinity: 0.9 },
          { name: "West Gardens", country: "MU", ...SIGHT, ...at(WEST, 0.05), affinity: 0.6 },
          // About 20 km away: only after widening.
          { name: "Hill Kitchen", country: "MU", ...RESTAURANT, ...at(WEST, -0.18), affinity: 0.5 },
          // About 40 km away: never.
          { name: "North Bar", country: "MU", ...BAR, ...NORTH, affinity: 0.99 },
        ],
      });
      const out = ok(await planDay(music, liveDeps(mock)));
      expect(out.day.map((s) => [s.slot, s.place])).toEqual([
        ["morning", "West Beach"],
        ["lunch", "Hill Kitchen"],
        ["afternoon", "West Gardens"],
      ]);
      expect(out.area).toEqual({ around: "West Beach", radius_km: 25 });
      const radii = insightsCalls(mock).map((q) => `${q["filter.tags"]?.split(":").pop()} ${q["filter.location.radius"] ?? "island"}`);
      expect(radii.sort()).toEqual(["bar 15000", "bar 25000", "restaurant 15000", "restaurant 25000", "tourist_attraction island"]);
    });

    it("Qloo ignoring the radius: far places are still dropped", async () => {
      const places: MockPlace[] = [
        { name: "West Beach", country: "MU", ...SIGHT, ...WEST, affinity: 0.9 },
        { name: "North Grill", country: "MU", ...RESTAURANT, ...NORTH, affinity: 0.99 },
        { name: "West Grill", country: "MU", ...RESTAURANT, ...WEST, affinity: 0.5 },
      ];
      mock = await startQlooMock();
      // Answers filter.tags but not filter.location.
      mock.setHandler((req, res) => {
        const q = queryOf(req);
        if (req.url.startsWith("/v2/insights")) return json(res, 200, { results: { entities: mockInsights(places, { "filter.tags": q["filter.tags"]! }) } });
        return qlooHandler({})(req, res);
      });
      const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }], pace: "relaxed" }), liveDeps(mock)));
      // North Grill (the best score, 40 km away) is neither lunch nor, after widening, the evening.
      expect(out.day.map((s) => s.place)).toEqual(["West Beach", "West Grill"]);
    });

    it("a town keeps the whole day there: filter.geocode.name on every call, no radius", async () => {
      mock = await startQlooMock({ places: FULL_DAY.map((p) => ({ ...p, ...WEST })) });
      const out = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }], town: "Flic en Flac" }), liveDeps(mock)));
      expect(out.area).toBeUndefined();
      expect(insightsCalls(mock).every((q) => q["filter.geocode.name"] === "Flic en Flac" && q["filter.location"] === undefined)).toBe(true);
    });

    it("demo: the whole day sits within the area's radius of the first stop", async () => {
      for (const tastes of [
        [{ kind: "music", name: "Bob Marley" }, { kind: "food", name: "seafood" }, { kind: "film", name: "Life of Pi" }],
        [{ kind: "music", name: "Miles Davis" }, { kind: "food", name: "cafe" }, { kind: "book", name: "Norwegian Wood" }],
        [{ kind: "film", name: "Moana" }, { kind: "food", name: "street food" }, { kind: "music", name: "Jack Johnson" }],
      ]) {
        const out = ok(await planDay(planDayInput.parse({ tastes }), demoDeps()));
        expect(out.area, JSON.stringify(tastes)).toBeDefined();
        expect(out.day.map((s) => s.kind), JSON.stringify(tastes)).toEqual(["thing_to_do", "restaurant", "thing_to_do", "bar"]);
        // Every demo region has a seafood place, a cafe and street food, so lunch shows the food taste.
        const food = tastes.find((t) => t.kind === "food")!.name;
        expect(out.day[1]!.why, JSON.stringify(tastes)).toContain(`matching your ${food}.`);
        for (const s of out.day.slice(1)) expect(s.km_from_start!, s.place).toBeLessThanOrEqual(out.area!.radius_km);
      }
    });
  });

  describe("things to do follow the tastes' Qloo tags", () => {
    const WEST = { lat: -20.29, lon: 57.36 };
    const near = (dLat: number) => ({ lat: WEST.lat + dLat, lon: WEST.lon });
    const sight = (name: string, affinity: number, tags: string[], extra: Partial<MockPlace> = {}): MockPlace => ({ name, country: "MU", ...SIGHT, ...WEST, tags, affinity, ...extra });
    const meals: MockPlace[] = [
      { name: "Grill", country: "MU", ...RESTAURANT, ...WEST, affinity: 0.5 },
      { name: "Bar", country: "MU", ...BAR, ...WEST, affinity: 0.5 },
    ];
    const film = planDayInput.parse({ tastes: [{ kind: "film", name: "Sea Film" }] });

    it("the morning is the sight whose tags echo the tastes', not Qloo's first; the why and the card say which", async () => {
      mock = await startQlooMock({
        searchTags: { "Sea Film": ["Swimming underwater", "Castaway", "Nature"] },
        places: [sight("Top Fort", 0.9, ["Fortress", "Nature"]), sight("Reef Cove", 0.6, ["Snorkeling", "Nature"]), sight("Old Mill", 0.7, ["Heritage"]), ...meals],
      });
      const out = ok(await planDay(film, liveDeps(mock)));
      expect(out.day[0]).toMatchObject({ slot: "morning", kind: "thing_to_do", place: "Reef Cove" });
      expect(out.day[0]!.tags[0]).toBe("Snorkeling");
      expect(out.day[0]!.why).toBe(
        "Fans of Sea Film tend to like it: Qloo ranks it 3rd of 3 things to do in Mauritius. Its Qloo tags echo your tastes: Snorkeling (Sea Film: Swimming underwater).",
      );
      // The afternoon has no link left: Qloo's order decides it. Still one Insights call per kind, no extra calls.
      expect(out.day.find((s) => s.slot === "afternoon")!.place).toBe("Top Fort");
      expect(out.qloo_calls.map((c) => c.endpoint)).toEqual(["/search", "/v2/insights", "/v2/insights", "/v2/insights"]);
    });

    it("a shared tag name counts too: 'also on' the taste", async () => {
      mock = await startQlooMock({
        searchTags: { "Sea Film": ["Romantic"] },
        places: [sight("Top Fort", 0.9, ["Fortress"]), sight("Love Bay", 0.5, ["Romantic"]), sight("Mill", 0.6, ["Heritage"]), ...meals],
      });
      const out = ok(await planDay(film, liveDeps(mock)));
      expect(out.day[0]!.place).toBe("Love Bay");
      expect(out.day[0]!.why).toContain("Its Qloo tags echo your tastes: Romantic (also on Sea Film).");
    });

    it("a food taste draws the day to a market; a music taste to live music", async () => {
      const places = [sight("Top Fort", 0.9, ["Fortress"]), sight("Town Market", 0.5, ["Market stalls"]), sight("Music Square", 0.4, ["Live music"]), ...meals];
      mock = await startQlooMock({ tags: [{ id: "urn:tag:cuisine:qloo:street_food", name: "Street food", parents: [{ type: "urn:entity:place" }] }], places });
      const food = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "film", name: "A Film" }, { kind: "food", name: "street food" }] }), liveDeps(mock)));
      expect(food.day[0]!.place).toBe("Town Market");
      expect(food.day[0]!.why).toContain("Its Qloo tags echo your tastes: Market stalls (your street food).");
      const music = ok(await planDay(planDayInput.parse({ tastes: [{ kind: "music", name: "A Band" }] }), liveDeps(mock)));
      expect(music.day[0]!.place).toBe("Music Square");
      expect(music.day[0]!.why).toContain("Live music (A Band)");
    });

    it("no tag in common: Qloo's order, as before", async () => {
      mock = await startQlooMock({ searchTags: { "Sea Film": ["Castaway"] }, places: [sight("Top Fort", 0.9, ["Fortress"]), sight("Reef Cove", 0.6, ["Hiking"]), ...meals] });
      const out = ok(await planDay(film, liveDeps(mock)));
      expect(out.day.filter((s) => s.kind === "thing_to_do").map((s) => s.place)).toEqual(["Top Fort", "Reef Cove"]);
      expect(out.day[0]!.why).not.toContain("echo");
    });

    it("ties go to variety: the afternoon avoids the morning's genre, and a link the morning showed counts half", async () => {
      const BEACH = "urn:tag:genre:place:beach";
      const FOREST = "urn:tag:genre:place:nature_preserve";
      mock = await startQlooMock({
        searchTags: { "Sea Film": ["Ocean", "Forest imagery"] },
        places: [
          sight("Reef Cove", 0.9, ["Snorkeling"], { genre: BEACH }),
          sight("Second Beach", 0.8, ["Swimming"], { genre: BEACH, ...near(0.02) }),
          sight("Rain Forest", 0.6, ["Hiking"], { genre: FOREST, ...near(0.03) }),
          sight("Car Park", 0.7, ["Parking"], near(0.01)),
          sight("Car Park 2", 0.65, ["Parking"], near(0.01)),
          ...meals,
        ],
      });
      const out = ok(await planDay(film, liveDeps(mock)));
      expect(out.day.filter((s) => s.kind === "thing_to_do").map((s) => s.place)).toEqual(["Reef Cove", "Rain Forest"]);
    });

    it("resolve_tastes never reports the taste's tags", async () => {
      mock = await startQlooMock({ searchTags: { "Sea Film": ["Castaway"] } });
      const out = ok(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "film", name: "Sea Film" }] }), liveDeps(mock)));
      expect(JSON.stringify(out)).not.toContain("Castaway");
    });
  });

  describe("the region follows the tastes", () => {
    // West coast and east coast, about 45 km apart.
    const WEST = { lat: -20.29, lon: 57.36 };
    const EAST = { lat: -20.27, lon: 57.78 };
    const sight = (name: string, affinity: number, tags: string[], at: { lat: number; lon: number }, dLat = 0): MockPlace => ({ name, country: "MU", ...SIGHT, lat: at.lat + dLat, lon: at.lon, tags, affinity });
    const mealsAt = (at: { lat: number; lon: number }, tag: string): MockPlace[] => [
      { name: `${tag} Grill`, country: "MU", ...RESTAURANT, ...at, affinity: 0.5 },
      { name: `${tag} Bar`, country: "MU", ...BAR, ...at, affinity: 0.5 },
    ];
    const tastes = planDayInput.parse({ tastes: [{ kind: "film", name: "Sea Film" }, { kind: "music", name: "Calm Singer" }] });
    const searchTags = { "Sea Film": ["Ocean"], "Calm Singer": ["Meditative"] };
    // Alone, Reef Cove scores best (a rare shared name and a good rank), then Quiet Temple, then Kayak Bay.
    // Kayak Bay plus half of Quiet Temple's fit beats Reef Cove alone, so the day goes east;
    // of that pair, Quiet Temple scores better alone, so it opens the day.
    const places: MockPlace[] = [
      sight("Kayak Bay", 0.95, ["Kayaking"], EAST),
      sight("West Car Park", 0.9, ["Parking"], WEST, 0.02),
      sight("Reef Cove", 0.85, ["Ocean"], WEST),
      sight("Quiet Temple", 0.6, ["Meditation"], EAST, 0.05),
      sight("East Fort", 0.5, ["Fortress", "Lagoon"], EAST, 0.01),
      ...mealsAt(WEST, "West"),
      ...mealsAt(EAST, "East"),
    ];

    it("a sight with a fitting neighbour beats a slightly better lone one; the better of the two opens the day", async () => {
      mock = await startQlooMock({ searchTags, places });
      const out = ok(await planDay(tastes, liveDeps(mock)));
      expect(out.day.map((s) => s.place)).toEqual(["Quiet Temple", "East Grill", "Kayak Bay", "East Bar"]);
      expect(out.area).toEqual({ around: "Quiet Temple", radius_km: 15 });
    });

    it("no extra calls for it: 2 lookups and 3 Insights calls; the same plan again is all cache hits", async () => {
      mock = await startQlooMock({ searchTags, places });
      const deps = liveDeps(mock);
      const out = ok(await planDay(tastes, deps));
      expect(out.qloo_calls.map((c) => c.endpoint)).toEqual(["/search", "/search", "/v2/insights", "/v2/insights", "/v2/insights"]);
      const sent = mock.requests.length;
      const again = ok(await planDay(tastes, deps));
      expect(mock.requests).toHaveLength(sent);
      expect(again.qloo_calls.every((c) => c.cached)).toBe(true);
      expect(again.day).toEqual(out.day);
    });

    it("in a town the town is the region: the best fit opens the day, wherever its neighbours are", async () => {
      mock = await startQlooMock({ searchTags, places });
      const out = ok(await planDay({ ...tastes, town: "Anywhere" }, liveDeps(mock)));
      expect(out.day[0]!.place).toBe("Reef Cove");
    });
  });

  describe("at most 10 Qloo calls a plan", () => {
    // One sight in the west and nothing else nearby: every optional call is wanted.
    const lonely: MockPlace[] = [
      { name: "West Beach", country: "MU", ...SIGHT, lat: -20.29, lon: 57.36, affinity: 0.9 },
      { name: "North Grill", country: "MU", ...RESTAURANT, lat: -20.01, lon: 57.58, affinity: 0.9 },
    ];
    const tastes = (n: number) => planDayInput.parse({ tastes: [...Array.from({ length: n - 1 }, (_, i) => ({ kind: "music", name: `Band ${"x".repeat(i + 1)}` })), { kind: "food", name: "seafood" }] });

    it("3 tastes: 3 lookups, 3 Insights calls, the afternoon's radius call and 3 widening calls = 10", async () => {
      mock = await startQlooMock({ places: lonely });
      const out = ok(await planDay(tastes(3), liveDeps(mock)));
      expect(mock.requests).toHaveLength(PLAN_CALL_BUDGET);
      expect(out.qloo_calls).toHaveLength(10);
      expect(out.day.map((s) => s.place)).toEqual(["West Beach"]);
      expect(insightsCalls(mock).map((q) => q["filter.location.radius"] ?? "island").sort()).toEqual(["15000", "15000", "15000", "25000", "25000", "25000", "island"]);
    });

    it("6 tastes: the optional calls stop at the budget; the meals are asked for before the afternoon", async () => {
      mock = await startQlooMock({ places: lonely });
      const out = ok(await planDay(tastes(6), liveDeps(mock)));
      expect(mock.requests.length).toBeLessThanOrEqual(PLAN_CALL_BUDGET);
      expect(out.qloo_calls.length).toBeLessThanOrEqual(PLAN_CALL_BUDGET);
      // 6 lookups + the island-wide sights + restaurants and bars within 15 km = 9; one call left, for the afternoon.
      const insights = insightsCalls(mock).map((q) => `${q["filter.tags"]!.split(":").pop()} ${q["filter.location.radius"] ?? "island"}`);
      expect(insights.sort()).toEqual(["bar 15000", "restaurant 15000", "tourist_attraction 15000", "tourist_attraction island"]);
    });

    it("the same plan again is all cache hits; another plan with the same food reuses its tag lookup", async () => {
      mock = await startQlooMock({ places: FULL_DAY });
      const deps = liveDeps(mock);
      ok(await planDay(tastes(2), deps));
      const sent = mock.requests.length;
      const again = ok(await planDay(tastes(2), deps));
      expect(mock.requests).toHaveLength(sent);
      expect(again.qloo_calls.every((c) => c.cached)).toBe(true);
      ok(await planDay(planDayInput.parse({ tastes: [{ kind: "film", name: "Other Film" }, { kind: "food", name: "seafood" }] }), deps));
      expect(mock.requests.filter((r) => r.url.startsWith("/v2/tags"))).toHaveLength(1);
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

  describe("a distinct, honest why per stop", () => {
    const two = planDayInput.parse({ tastes: [{ kind: "music", name: "Kaya" }, { kind: "film", name: "Some Film" }] });

    it("names the fans of every taste, and the stop's rank in the list Qloo returned for its kind", async () => {
      mock = await startQlooMock({ places: FULL_DAY });
      const out = ok(await planDay(two, liveDeps(mock)));
      expect(out.day.map((s) => s.why)).toEqual([
        "Fans of Kaya and Some Film tend to like it: Qloo ranks it 1st of 2 things to do in Mauritius.",
        "Fans of Kaya and Some Film tend to like it: it is the only restaurant Qloo returned in Mauritius.",
        "Fans of Kaya and Some Film tend to like it: Qloo ranks it 2nd of 2 things to do in Mauritius.",
        "Fans of Kaya and Some Film tend to like it: it is the only bar Qloo returned in Mauritius.",
      ]);
    });

    it("the taste Qloo's explainability credits most is the one named", async () => {
      // The mock gives "Kaya" the ID id(600 + 4) and "Some Film" id(600 + 9).
      mock = await startQlooMock({
        places: FULL_DAY.map((p, i) => ({
          ...p,
          explain: [
            { entity_id: "00000000-0000-4000-8000-000000000604", score: i % 2 ? 0.3 : 0.7 },
            { entity_id: "00000000-0000-4000-8000-000000000609", score: i % 2 ? 0.7 : 0.3 },
          ],
        })),
      });
      const out = ok(await planDay(two, liveDeps(mock)));
      expect(out.day.map((s) => s.why.split(" tend")[0])).toEqual(["Fans of Kaya", "Fans of Some Film", "Fans of Kaya", "Fans of Some Film"]);
    });

    it("says when a meal is at a hotel; rank 2+ and ordinals read right", async () => {
      expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
      mock = await startQlooMock({ places: [...FULL_DAY.slice(0, 3), { name: "Big Resort", country: "MU", ...RESORT, affinity: 0.99 }] });
      const out = ok(await planDay(two, liveDeps(mock)));
      expect(out.day.at(-1)!.why).toBe(
        "Fans of Kaya and Some Film tend to like it: it is the only bar Qloo returned in Mauritius. It's a hotel's bar: no stand-alone place was left nearby.",
      );
    });

    it("demo: the example plans give every stop its own why, with no 'Because you like'", async () => {
      for (const tastes of [
        [{ kind: "music", name: "Bob Marley" }, { kind: "food", name: "seafood" }, { kind: "film", name: "Life of Pi" }],
        [{ kind: "music", name: "Miles Davis" }, { kind: "food", name: "cafe" }, { kind: "book", name: "Norwegian Wood" }],
        [{ kind: "film", name: "Moana" }, { kind: "food", name: "street food" }, { kind: "music", name: "Jack Johnson" }],
      ]) {
        const out = ok(await planDay(planDayInput.parse({ tastes }), demoDeps()));
        const whys = out.day.map((s) => s.why);
        expect(new Set(whys).size, whys.join("\n")).toBe(whys.length);
        for (const w of whys) expect(w).toMatch(/^Fans of .+ tend to like it: (Qloo ranks it \d+(st|nd|rd|th) of \d+ |it is the only )/);
        for (const s of out.day) {
          expect(s.town ?? "").not.toMatch(/VCA/);
          expect(s.tags.length).toBeLessThanOrEqual(4);
          expect(new Set(s.tags).size).toBe(s.tags.length);
          expect(s.tags).not.toContain("Restaurant (demo)");
        }
      }
    });
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
    // No explainability: the fans are the non-food tastes. No place carries a seafood tag. The bar
    // (genre restaurant:bar) is in both meal lists; the resort is in neither.
    expect(out.day.map((s) => s.why)).toEqual([
      "Fans of Bob Marley tend to like it: Qloo ranks it 1st of 2 things to do in Mauritius.",
      "Fans of Bob Marley tend to like it: Qloo ranks it 1st of 2 restaurants within 15 km. No seafood place came up nearby, so this is Qloo's top restaurant here.",
      "Fans of Bob Marley tend to like it: Qloo ranks it 2nd of 2 things to do in Mauritius.",
      "Fans of Bob Marley tend to like it: Qloo ranks it 2nd of 2 bars within 15 km.",
    ]);
    expect(out.area).toEqual({ around: "Port Louis", radius_km: 15 });
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
    // "Tourist attraction" is too generic to show.
    expect(out.places[0]!.tags).toEqual(["Test tag 0 (demo)"]);
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
