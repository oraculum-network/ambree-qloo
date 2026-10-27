// The Qloo response contract: lenient zod schemas for GET /search, GET /v2/tags and
// GET /v2/insights, matched to the live hackathon API on 27 Oct 2026. Objects are loose:
// unknown fields are kept. Only what the tools read is required (the results lists,
// entity_id and name, tag id and name); every other field may be missing or null, since
// live places send `admin2_region: null` and /search sends no `success`.

import { z } from "zod";

const Geocode = z.looseObject({
  name: z.string().nullish(),
  city: z.string().nullish(),
  country_code: z.string().nullish(),
  admin1_region: z.string().nullish(),
  admin2_region: z.string().nullish(),
});

const Properties = z.looseObject({
  geocode: Geocode.nullish(),
  address: z.string().nullish(),
  // One recipe puts the score here instead of query.affinity.
  affinity: z.number().nullish(),
  // Live places send { id: "urn:tag:genre:place:..." }; read by src/tools/places.ts, never required.
  primary_genre: z.unknown().optional(),
  live_music: z.unknown().optional(),
});

export const SearchEntity = z.looseObject({
  name: z.string(),
  entity_id: z.string(),
  types: z.array(z.string()).nullish(),
  popularity: z.number().nullish(),
  properties: z.looseObject({}).nullish(),
});

/** GET /search: `results` is a flat array (not results.entities). Live sends no `success`. */
export const SearchResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.array(SearchEntity),
});

export const Tag = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().nullish(),
  parents: z.array(z.looseObject({ type: z.string().nullish() })).nullish(),
  popularity: z.number().nullish(),
});

/** GET /v2/tags: results.tags[] with id, name, type, parents[].type. */
export const TagsResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ tags: z.array(Tag) }),
});

/** A tag on an insights entity. A tag with no name is skipped by the tools, not a mismatch. */
export const EntityTag = z.looseObject({
  id: z.string().nullish(),
  tag_id: z.string().nullish(),
  name: z.string().nullish(),
  type: z.string().nullish(),
});

/**
 * An insights entity. Documented forms: type "urn:entity" + subtype + query.affinity, or
 * type "urn:entity:place" + properties.affinity. Live sends `types` (an array) and may leave
 * out the affinity. All pass; a missing score reads as 0.
 */
export const InsightsEntity = z.looseObject({
  name: z.string(),
  entity_id: z.string(),
  type: z.string().nullish(),
  types: z.array(z.string()).nullish(),
  subtype: z.string().nullish(),
  popularity: z.number().nullish(),
  properties: Properties.nullish(),
  // Live places send { lat, lon, geohash }; read by pointOf, never required.
  location: z.unknown().optional(),
  tags: z.array(EntityTag).nullish(),
  query: z
    .looseObject({
      affinity: z.number().nullish(),
      explainability: z.unknown().optional(),
    })
    .nullish(),
});

/** GET /v2/insights: results.entities[] (a 200 with an empty list is valid). */
export const InsightsResponse = z.looseObject({
  success: z.boolean().optional(),
  results: z.looseObject({ entities: z.array(InsightsEntity) }),
});

/** The documented error body (search and entities reference): all fields optional. */
export const QlooErrorBody = z.looseObject({
  code: z.number().nullish(),
  reason: z.string().nullish(),
  message: z.string().nullish(),
});

export type SearchResponse = z.infer<typeof SearchResponse>;
export type TagsResponse = z.infer<typeof TagsResponse>;
export type InsightsResponse = z.infer<typeof InsightsResponse>;
export type InsightsEntity = z.infer<typeof InsightsEntity>;
export type Tag = z.infer<typeof Tag>;

export type Endpoint = "search" | "tags" | "insights";
export const ENDPOINT_PATHS: Record<Endpoint, string> = { search: "/search", tags: "/v2/tags", insights: "/v2/insights" };
const SCHEMAS = { search: SearchResponse, tags: TagsResponse, insights: InsightsResponse } as const;

/** The score of an insights entity: query.affinity, else properties.affinity, else 0. */
export function affinityOf(e: InsightsEntity): number {
  return e.query?.affinity ?? e.properties?.affinity ?? 0;
}

/**
 * A town name without the administrative suffix Mauritius geocodes carry: "Le Morne VCA",
 * "Grand Baie VCA, East" and "Cascavelle VCA West" read "Le Morne", "Grand Baie", "Cascavelle".
 */
export function cleanTown(town: string): string {
  const bare = town.replace(/\s+(VCA|Village Council Area|District Council|District|Municipal Council|Municipality)\b.*$/i, "").trim();
  return bare || town.trim();
}

/** The town of a place: geocode.city, else geocode.name, cleaned; undefined if both are missing, null or empty. */
export function townOf(e: InsightsEntity): string | undefined {
  const raw = e.properties?.geocode?.city || e.properties?.geocode?.name;
  return raw ? cleanTown(raw) : undefined;
}

/** A place's coordinates from `location.lat` and `location.lon`; undefined unless both are finite numbers. */
export function pointOf(e: InsightsEntity): { lat: number; lon: number } | undefined {
  const loc = e.location as { lat?: unknown; lon?: unknown } | null | undefined;
  const lat = loc?.lat;
  const lon = loc?.lon;
  return typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
}

/**
 * Per-signal contributions from query.explainability, read leniently: any array item with
 * an id (entity_id, tag_id or id) and a numeric score (score, contribution or affinity).
 * The docs describe the section but show no example, so unknown forms give [].
 */
export function explainedBy(e: InsightsEntity): Array<{ id: string; score: number }> {
  const out: Array<{ id: string; score: number }> = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const id = [o.entity_id, o.tag_id, o.id].find((x) => typeof x === "string") as string | undefined;
    const score = [o.score, o.contribution, o.affinity].find((x) => typeof x === "number") as number | undefined;
    if (id && score !== undefined) {
      out.push({ id, score });
      return;
    }
    for (const child of Object.values(o)) walk(child, depth + 1);
  };
  walk(e.query?.explainability, 0);
  return out.sort((a, b) => b.score - a.score);
}

function typeName(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function pathOf(path: PropertyKey[]): string {
  let s = "$";
  for (const p of path) s += typeof p === "number" ? `[${p}]` : `.${String(p)}`;
  return s;
}

function valueAt(json: unknown, path: PropertyKey[]): unknown {
  let v: unknown = json;
  for (const p of path) v = v && typeof v === "object" ? (v as Record<PropertyKey, unknown>)[p] : undefined;
  return v;
}

/**
 * Check a response body against the contract. Each mismatch is a path plus the expected
 * type, e.g. "$.results[0].entity_id expected string, got missing". Never includes values.
 */
export function checkShape(endpoint: Endpoint, json: unknown): { ok: boolean; mismatches: string[] } {
  const parsed = SCHEMAS[endpoint].safeParse(json);
  if (parsed.success) return { ok: true, mismatches: [] };
  const mismatches = parsed.error.issues.slice(0, 10).map((i) => {
    const expected = "expected" in i && typeof i.expected === "string" ? i.expected : i.code;
    return `${pathOf(i.path)} expected ${expected}, got ${typeName(valueAt(json, i.path))}`;
  });
  return { ok: false, mismatches };
}
