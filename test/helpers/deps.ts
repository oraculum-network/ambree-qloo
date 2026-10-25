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
  tags?: string[];
  affinity: number;
  explain?: Array<{ entity_id?: string; tag_id?: string; score: number }>;
}

/** An insights entity in the documented shape A, from a short spec. */
export function mockEntity(p: MockPlace, i: number) {
  return {
    name: p.name,
    entity_id: id(700 + i),
    type: "urn:entity",
    subtype: "urn:entity:place",
    properties: { geocode: { ...(p.town ? { name: p.town } : {}), ...(p.country ? { country_code: p.country } : {}) } },
    tags: (p.tags ?? []).map((t) => ({ id: `urn:tag:test:${t.toLowerCase().replace(/\W+/g, "_")}`, name: t, type: "urn:tag:test" })),
    query: { affinity: p.affinity, ...(p.explain ? { explainability: { "signal.interests.entities": p.explain } } : {}) },
  };
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
      return json(res, 200, { success: true, results: { entities: (script.places ?? []).map(mockEntity) } });
    }
    json(res, 404, {});
  };
}

export async function startQlooMock(script: QlooScript = {}): Promise<MockServer> {
  return startMockServer(qlooHandler(script));
}
