// The Qloo response contract: lenient zod schemas for the documented shapes of
// GET /search, GET /v2/tags and GET /v2/insights (hackathon developer guide, the API
// reference and its recipes). Objects are loose: unknown fields are kept, and only what
// the tools read is required. Fields the docs name but never showed on a place
// (address, lat/lon, price level) stay optional until a live smoke run confirms them.

import { z } from "zod";

const Geocode = z.looseObject({
  name: z.string().optional(),
  city: z.string().optional(),
  country_code: z.string().optional(),
  admin1_region: z.string().optional(),
  admin2_region: z.string().optional(),
});

const Properties = z.looseObject({
  geocode: Geocode.optional(),
  // One recipe puts the score here instead of query.affinity.
  affinity: z.number().optional(),
});

export const SearchEntity = z.looseObject({
  name: z.string(),
  entity_id: z.string(),
  types: z.array(z.string()).optional(),
  popularity: z.number().optional(),
  properties: z.looseObject({}).optional(),
});

/** GET /search: `results` is a flat array (not results.entities). */
export const SearchResponse = z.looseObject({
  success: z.boolean(),
  results: z.array(SearchEntity),
});

export const Tag = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  parents: z.array(z.looseObject({ type: z.string().optional() })).optional(),
  popularity: z.number().optional(),
});

/** GET /v2/tags: results.tags[] with id, name, type, parents[].type. */
export const TagsResponse = z.looseObject({
  success: z.boolean(),
  results: z.looseObject({ tags: z.array(Tag) }),
});

export const EntityTag = z.looseObject({
  id: z.string().optional(),
  tag_id: z.string().optional(),
  name: z.string(),
  type: z.string().optional(),
});

/**
 * An insights entity. Two documented forms: type "urn:entity" + subtype + query.affinity,
 * or type "urn:entity:place" + properties.affinity. Both pass.
 */
export const InsightsEntity = z.looseObject({
  name: z.string(),
  entity_id: z.string(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  popularity: z.number().optional(),
  properties: Properties.optional(),
  tags: z.array(EntityTag).optional(),
  query: z
    .looseObject({
      affinity: z.number().optional(),
      explainability: z.unknown().optional(),
    })
    .optional(),
});

/** GET /v2/insights: results.entities[] (a 200 with an empty list is valid). */
export const InsightsResponse = z.looseObject({
  success: z.boolean(),
  results: z.looseObject({ entities: z.array(InsightsEntity) }),
});

/** The documented error body (search and entities reference): all fields optional. */
export const QlooErrorBody = z.looseObject({
  code: z.number().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
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

/** The town of a place: geocode.city, else geocode.name. */
export function townOf(e: InsightsEntity): string | undefined {
  return e.properties?.geocode?.city ?? e.properties?.geocode?.name;
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
