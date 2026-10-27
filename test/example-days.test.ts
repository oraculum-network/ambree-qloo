// The page's three example chips give visibly different days in live mode. A replay over
// synthetic bodies shaped like the live ones (27 Oct 2026): /search hits carry tags
// { name, tag_id, type }; /v2/insights places carry primary_genre, location { lat, lon,
// geohash }, typed tags and query.affinity. Live Qloo ranked nearly the same things to do
// for all three chips, a famous beach first, so this island gives every taste the same
// order; only the tastes' own tags can tell the days apart. Synthetic only: invented
// names ending "(demo)", all-zero IDs, hand-written tags, round coordinates.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { distanceKm, parsePoint } from "../src/geo.ts";
import { PLAN_CALL_BUDGET, type PlanDayOutput, planDay, planDayInput } from "../src/tools/plan-day.ts";
import type { ToolOutcome } from "../src/tools/context.ts";
import { liveDeps, searchTagsOf } from "./helpers/deps.ts";
import { type MockServer, json, queryOf, startMockServer } from "./helpers/mock-server.ts";
import { id } from "./helpers/shapes.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(join(ROOT, "public/app.js"), "utf8");
/** The chips' tastes, read from public/app.js so this test follows the page. */
const EXAMPLES = (/const EXAMPLES = \[\n([\s\S]*?)\n\];/.exec(app)?.[1] ?? "")
  .split("\n")
  .map((line) => [...line.matchAll(/\["(\w+)", "([^"]+)"\]/g)].map((m) => ({ kind: m[1]!, name: m[2]! })));

/** Hand-written tags for each named taste, in the form /search returns (genres, moods, themes); our words, not Qloo's lists. */
const TASTE_TAGS: Record<string, string[]> = {
  "Bob Marley": ["Reggae", "Spiritual", "Peace", "Soulful"],
  "Life of Pi": ["Ocean", "Shipwreck", "Religion", "Survival"],
  "Miles Davis": ["Jazz", "Trumpet", "Atmospheric", "Cool"],
  "Norwegian Wood": ["Nostalgic", "Melancholic", "Woodland", "Sixties", "Romance"],
  Moana: ["Ocean", "Sailing", "Island", "Village life", "Animation", "Adventure"],
  "Jack Johnson": ["Acoustic", "Relaxed", "Mellow", "Surf"],
};
/** /v2/tags for the chips' food words, as live answered (place parents). */
const FOOD_TAGS: Record<string, string> = {
  seafood: "urn:tag:genre:place:restaurant:seafood",
  cafe: "urn:tag:genre:place:restaurant:cafe",
  "street food": "urn:tag:cuisine:qloo:street_food",
};

const SIGHT = ["urn:tag:genre:place:tourist_attraction", "urn:tag:category:place:tourist_attraction"] as const;
const BEACH = ["urn:tag:genre:place:beach", "urn:tag:category:place:tourist_attraction"] as const;
const TEMPLE = ["urn:tag:genre:place:hindu_temple", "urn:tag:category:place:tourist_attraction"] as const;
const CHURCH = ["urn:tag:genre:place:catholic_church", "urn:tag:category:place:tourist_attraction"] as const;
const FOREST = ["urn:tag:genre:place:nature_preserve", "urn:tag:category:place:tourist_attraction"] as const;
const BOATS = ["urn:tag:genre:place:boat_tour_agency", "urn:tag:category:place:tourist_attraction"] as const;
const RESTAURANT = ["urn:tag:genre:place:restaurant", "urn:tag:genre:place:restaurant"] as const;
const BAR = ["urn:tag:genre:place:restaurant:bar", "urn:tag:category:place:bar"] as const;
const RESORT = ["urn:tag:genre:place:hotel:resort", "urn:tag:category:place:tourist_attraction"] as const;

type Kind = readonly [genre: string, filterTag: string];
interface Spot {
  name: string;
  kind: Kind;
  at: [lat: number, lon: number];
  affinity: number;
  /** "type/Name": type is the middle of urn:tag:<type>:qloo. */
  tags: string[];
}

// Four coasts, about 30 to 50 km apart. Every sight also carries the tags live puts on nearly all of them.
const WEST: [number, number] = [-20.3, 57.36];
const NORTH: [number, number] = [-20.05, 57.65];
const SOUTH: [number, number] = [-20.52, 57.52];
const EAST: [number, number] = [-20.25, 57.78];
const off = (p: [number, number], dLat: number, dLon = 0): [number, number] => [p[0] + dLat, p[1] + dLon];
const COMMON = ["activity_type/Nature outdoors", "ambience/Quiet", "ambience/Casual", "ambience/Relaxing", "activity_type/Sightseeing"];

const ISLAND: Spot[] = [
  // Things to do, in the one order Qloo gives every taste.
  { name: "Famous Beach (demo)", kind: BEACH, at: WEST, affinity: 0.62, tags: ["activity_type/Snorkeling", "setting/Lagoon", "ambience/Lively", "ambience/Family friendly", "view/Ocean view"] },
  { name: "Cliff Beach (demo)", kind: BEACH, at: SOUTH, affinity: 0.6, tags: ["ambience/Nostalgic", "activity_type/Contemplation", "ambience/Dramatic", "view/Ocean view"] },
  { name: "Quad Trails (demo)", kind: SIGHT, at: off(SOUTH, 0.01, 0.02), affinity: 0.59, tags: ["activity_type/Quad biking", "setting/Coastal forest", "activity_type/Hiking"] },
  { name: "Gorge Lookout (demo)", kind: SIGHT, at: off(WEST, -0.12, 0.03), affinity: 0.58, tags: ["view/Mountain view", "view/Sunset view", "activity_type/Photography"] },
  { name: "Sugar Museum (demo)", kind: SIGHT, at: off(NORTH, -0.05, -0.07), affinity: 0.57, tags: ["category/Museum", "ambience/Historic", "ambience/Immersive"] },
  { name: "Lagoon Resort (demo)", kind: RESORT, at: off(EAST, 0.02), affinity: 0.56, tags: ["category/Resort hotel", "activity_type/Snorkeling"] },
  { name: "Ebony Woods (demo)", kind: FOREST, at: off(WEST, -0.14, 0.02), affinity: 0.55, tags: ["setting/Forest", "activity_type/Birdwatching", "activity_type/Hiking"] },
  { name: "Old Fort (demo)", kind: SIGHT, at: off(NORTH, -0.1, -0.15), affinity: 0.54, tags: ["category/Fortress", "ambience/Historic", "view/Harbor view"] },
  { name: "Cape Chapel (demo)", kind: CHURCH, at: off(NORTH, 0.07, -0.03), affinity: 0.53, tags: ["activity_type/Religious worship", "activity_type/Beach walking", "ambience/Serene"] },
  { name: "Catamaran Trips (demo)", kind: BOATS, at: EAST, affinity: 0.52, tags: ["activity_type/Boat trips", "activity_type/Snorkeling", "ambience/Adventurous", "setting/Harbour village"] },
  { name: "Safari Park (demo)", kind: SIGHT, at: off(WEST, 0.01, 0.04), affinity: 0.51, tags: ["category/Zoo", "ambience/Family friendly", "activity_type/Animal feeding"] },
  { name: "Seaside Temple (demo)", kind: TEMPLE, at: NORTH, affinity: 0.5, tags: ["activity_type/Meditation", "ambience/Spiritual", "activity_type/Prayer", "view/Ocean view"] },
  { name: "Calm Bay Beach (demo)", kind: BEACH, at: off(EAST, 0.11, -0.04), affinity: 0.49, tags: ["ambience/Relaxed", "ambience/Family friendly", "category/Public beach"] },
  // Meals on each coast.
  ...([["West", WEST], ["North", NORTH], ["South", SOUTH], ["East", EAST]] as const).flatMap(([coast, at]): Spot[] => [
    { name: `${coast} Grill (demo)`, kind: RESTAURANT, at: off(at, 0.01), affinity: 0.6, tags: ["cuisine/Mauritian", "cuisine/Seafood"] },
    { name: `${coast} Coffee House (demo)`, kind: RESTAURANT, at: off(at, -0.01), affinity: 0.55, tags: ["category/Cafe", "cuisine/Coffee"] },
    { name: `${coast} Food Stalls (demo)`, kind: RESTAURANT, at: off(at, 0.02), affinity: 0.5, tags: ["cuisine/Street food"] },
    { name: `${coast} Music Bar (demo)`, kind: BAR, at: off(at, -0.02), affinity: 0.55, tags: ["amenity/Live music", "category/Cocktail bar"] },
  ]),
];

const slug = (s: string) => s.toLowerCase().replace(/\W+/g, "_");

/** A place in the live shape. */
function entity(s: Spot, i: number) {
  const [genre, filterTag] = s.kind;
  const typed = [...COMMON, ...s.tags].map((t) => {
    const [type, name] = t.split("/") as [string, string];
    // Cuisines as live sends them: urn:tag:cuisine:qloo:<cuisine>; cafes as a restaurant genre.
    const tagId = name === "Cafe" ? "urn:tag:genre:place:restaurant:cafe" : `urn:tag:${type}:qloo:${slug(name)}`;
    return { id: tagId, name, type: tagId.split(":").slice(0, -1).join(":"), weight: null };
  });
  return {
    entity_id: id(400 + i),
    name: s.name,
    types: ["urn:entity:place"],
    subtype: "urn:entity:place",
    properties: { geocode: { name: null, city: `${s.name.split(" ")[0]} Town`, country_code: "MU", admin1_region: null, admin2_region: null }, primary_genre: { id: genre } },
    location: { lat: s.at[0], lon: s.at[1], geohash: "demo" },
    popularity: 0.5,
    query: { affinity: s.affinity },
    tags: [{ id: filterTag, name: "Filter tag", type: filterTag.split(":").slice(0, -1).join(":"), weight: null }, ...typed],
  };
}
const PLACES = ISLAND.map(entity);

/** A mock Qloo that answers as live did: search hits with tags (or none), food tags, places by filter.tags and radius. */
async function liveLikeQloo(withTasteTags: boolean): Promise<MockServer> {
  return startMockServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const q = queryOf(req);
    if (path === "/search") {
      const name = q.query!;
      const tags = withTasteTags ? searchTagsOf(TASTE_TAGS[name] ?? []) : [];
      return json(res, 200, { results: [{ name, entity_id: id(300 + Object.keys(TASTE_TAGS).indexOf(name)), types: [q.types], tags }] });
    }
    if (path === "/v2/tags") {
      const tagId = FOOD_TAGS[q["filter.query"]!]!;
      return json(res, 200, { success: true, results: { tags: [{ id: tagId, name: q["filter.query"], type: tagId.split(":").slice(0, -1).join(":"), parents: [{ type: "urn:entity:place" }] }] } });
    }
    const filter = q["filter.tags"];
    const center = parsePoint(q["filter.location"]);
    const radius = Number(q["filter.location.radius"] ?? 0);
    const entities = PLACES.filter((e) => e.tags.some((t) => t.id === filter))
      .filter((e) => !center || !radius || distanceKm(center, e.location) * 1000 <= radius)
      .slice(0, Number(q.take));
    return json(res, 200, { success: true, results: { entities } });
  });
}

let mock: MockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function ok<T>(o: ToolOutcome<T>): T {
  if (!o.ok) throw new Error(`expected ok, got: ${o.message}`);
  return o.value;
}

async function chipDays(withTasteTags: boolean): Promise<PlanDayOutput[]> {
  mock = await liveLikeQloo(withTasteTags);
  const deps = liveDeps(mock);
  const out: PlanDayOutput[] = [];
  for (const tastes of EXAMPLES) out.push(ok(await planDay(planDayInput.parse({ tastes }), deps)));
  return out;
}

const differing = (a: PlanDayOutput, b: PlanDayOutput) => a.day.filter((s) => b.day.find((t) => t.slot === s.slot)?.place !== s.place).length;

describe("the example chips' days (live shapes, synthetic island)", () => {
  it("there are three chips, each with a taste this test has tags for", () => {
    expect(EXAMPLES).toHaveLength(3);
    for (const ex of EXAMPLES) for (const t of ex) expect(t.kind === "food" ? FOOD_TAGS : TASTE_TAGS, t.name).toHaveProperty([t.name]);
  });

  it("any two chips differ in at least 2 of their 4 stops, in different regions; every sight says which tags tie it to the tastes", async () => {
    const days = await chipDays(true);
    for (const [i, d] of days.entries()) {
      expect(d.mode).toBe("live");
      const food = EXAMPLES[i]!.find((t) => t.kind === "food")!.name;
      expect(d.day[1]!.why, food).toContain(`matching your ${food}.`);
      expect(d.day.map((s) => s.slot)).toEqual(["morning", "lunch", "afternoon", "evening"]);
      expect(d.qloo_calls.length).toBeLessThanOrEqual(PLAN_CALL_BUDGET);
      for (const s of d.day.filter((x) => x.kind === "thing_to_do")) expect(s.why, s.place).toContain("Its Qloo tags echo your tastes:");
      for (const s of d.day.slice(1)) expect(s.km_from_start!, s.place).toBeLessThanOrEqual(d.area!.radius_km);
    }
    for (let i = 0; i < days.length; i++) {
      for (let j = i + 1; j < days.length; j++) {
        expect(differing(days[i]!, days[j]!), `chips ${i} and ${j}`).toBeGreaterThanOrEqual(2);
        expect(days[i]!.area!.around, `chips ${i} and ${j}`).not.toBe(days[j]!.area!.around);
      }
    }
    // What each chip's tags lead to on this island.
    expect(days.map((d) => d.day.filter((s) => s.kind === "thing_to_do").map((s) => s.place))).toEqual([
      ["Seaside Temple (demo)", "Cape Chapel (demo)"],
      ["Cliff Beach (demo)", "Quad Trails (demo)"],
      ["Calm Bay Beach (demo)", "Catamaran Trips (demo)"],
    ]);
  });

  it("without the tastes' tags the same island gives all three chips the same first stop, as live did before", async () => {
    const days = await chipDays(false);
    expect(new Set(days.map((d) => d.day[0]!.place))).toEqual(new Set(["Famous Beach (demo)"]));
  });
});
