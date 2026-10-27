// Tool dependencies for tests: demo (the fixtures) or live against a local mock Qloo.

import type { ServerResponse } from "node:http";
import type { LogRecord } from "../../src/log.ts";
import { createLiveTransport, createQloo } from "../../src/qloo/client.ts";
import { type DemoData, createDemoTransport, loadDemoData } from "../../src/qloo/fixtures.ts";
import type { ToolDeps } from "../../src/tools/context.ts";
import { type MockServer, type RecordedRequest, json, queryOf, startMockServer } from "./mock-server.ts";
import { SENTINEL_KEY, id } from "./shapes.ts";

export function demoDeps(logs: LogRecord[] = [], data?: DemoData): ToolDeps {
  const log = (r: LogRecord) => logs.push(r);
  return { qloo: createQloo({ demo: createDemoTransport(data ?? loadDemoData()), log }), log };
}

export function liveDeps(mock: MockServer, logs: LogRecord[] = [], opts: { timeoutMs?: number; data?: DemoData } = {}): ToolDeps {
  const log = (r: LogRecord) => logs.push(r);
  const live = createLiveTransport({ base: mock.url, key: SENTINEL_KEY, dailyCalls: 1000, log, timeoutMs: opts.timeoutMs });
  return { qloo: createQloo({ live, demo: createDemoTransport(opts.data ?? loadDemoData()), log }), log };
}

export interface MockPlace {
  name: string;
  town?: string;
  country?: string;
  /** Tag names, sent with made-up urn:tag:test: IDs. */
  tags?: string[];
  /** Qloo taxonomy tag IDs, sent with a name made from the last part ("...:street_food" → "Street food"). */
  tagIds?: string[];
  /** properties.primary_genre.id */
  genre?: string;
  lat?: number;
  lon?: number;
  affinity: number;
  explain?: Array<{ entity_id?: string; tag_id?: string; score: number }>;
}

const nameOfTag = (tagId: string) => {
  const last = tagId.split(":").pop()!.replace(/_/g, " ");
  return last.charAt(0).toUpperCase() + last.slice(1);
};

/** An insights entity in the documented shape A, from a short spec. */
export function mockEntity(p: MockPlace, i: number) {
  return {
    name: p.name,
    entity_id: id(700 + i),
    type: "urn:entity",
    subtype: "urn:entity:place",
    properties: {
      geocode: { ...(p.town ? { name: p.town } : {}), ...(p.country ? { country_code: p.country } : {}) },
      ...(p.genre ? { primary_genre: { id: p.genre } } : {}),
    },
    ...(p.lat !== undefined && p.lon !== undefined ? { location: { lat: p.lat, lon: p.lon } } : {}),
    tags: [
      ...(p.tags ?? []).map((t) => ({ id: `urn:tag:test:${t.toLowerCase().replace(/\W+/g, "_")}`, name: t, type: "urn:tag:test" })),
      ...(p.tagIds ?? []).map((t) => ({ id: t, name: nameOfTag(t), type: t.split(":").slice(0, -1).join(":") })),
    ],
    query: { affinity: p.affinity, ...(p.explain ? { explainability: { "signal.interests.entities": p.explain } } : {}) },
  };
}

/** Kilometres between two points (haversine), for the mock's radius filter. */
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** The script's places that pass filter.tags (any listed tag) and filter.location + radius, as Qloo applies them. */
export function mockInsights(places: MockPlace[], q: Record<string, string>) {
  const filterTags = (q["filter.tags"] ?? "").split(",").filter(Boolean);
  const point = /^POINT\((-?[\d.]+) (-?[\d.]+)\)$/.exec(q["filter.location"] ?? "");
  const radius = Number(q["filter.location.radius"] ?? "0");
  return places
    .map((p, i) => ({ p, e: mockEntity(p, i) }))
    .filter(({ p, e }) => {
      if (filterTags.length && !e.tags.some((t) => filterTags.includes(t.id))) return false;
      if (point && radius) {
        if (p.lat === undefined || p.lon === undefined) return false;
        if (km({ lat: Number(point[2]), lon: Number(point[1]) }, { lat: p.lat, lon: p.lon }) * 1000 > radius) return false;
      }
      return true;
    })
    .map(({ e }) => e);
}

export interface QlooScript {
  /** Names with no search match (an empty results list). */
  noMatch?: string[];
  /** Names whose search answers 404 "No results". */
  notFound?: string[];
  places?: MockPlace[];
  insightsStatus?: number;
  tags?: Array<{ id: string; name: string; parents?: Array<{ type: string }> }>;
}

/** A mock Qloo that answers the three endpoints from a script. Search names match "<query> Match". */
export function qlooHandler(script: QlooScript) {
  return (req: RecordedRequest, res: ServerResponse) => {
    const path = new URL(req.url, "http://x").pathname;
    const q = queryOf(req);
    if (path === "/search") {
      const query = q.query ?? "";
      if (script.notFound?.includes(query)) return json(res, 404, { code: 404, reason: "Not Found", message: "No results" });
      if (script.noMatch?.includes(query)) return json(res, 200, { success: true, results: [] });
      return json(res, 200, { success: true, results: [{ name: `${query} Match`, entity_id: id(600 + query.length), types: [q.types], popularity: 0.5, properties: {} }] });
    }
    if (path === "/v2/tags") {
      const tags = script.tags ?? [{ id: "urn:tag:test:street_food", name: "Street Food", parents: [{ type: "urn:entity:place" }] }];
      return json(res, 200, { success: true, results: { tags } });
    }
    if (path === "/v2/insights") {
      if (script.insightsStatus && script.insightsStatus !== 200) return json(res, script.insightsStatus, { code: script.insightsStatus, reason: "Error" });
      return json(res, 200, { success: true, results: { entities: mockInsights(script.places ?? [], q) } });
    }
    json(res, 404, {});
  };
}

export async function startQlooMock(script: QlooScript = {}): Promise<MockServer> {
  return startMockServer(qlooHandler(script));
}
