// The demo transport: answers the same GET requests as Qloo from fixtures/qloo-demo.json,
// a hand-written, synthetic file (no Qloo data). It reads the same query parameters the
// live transport sends, so demo mode exercises the real request-building code.
//  - /search: one synthetic entity per (query, type), named after the user's own text;
//  - /v2/tags: substring match on the demo tag names;
//  - /v2/insights: each demo place scored by a stable hash of (signal IDs, place ID), plus a
//    bonus for matching tag signals, so different tastes give different days.

import { readFileSync } from "node:fs";
import type { Endpoint, InsightsEntity, Tag } from "./contract.ts";
import type { Params, QlooTransport } from "./client.ts";

export const DEMO_FILE = new URL("../../fixtures/qloo-demo.json", import.meta.url);
export const DEMO_SUFFIX = " (demo)";

export interface DemoData {
  synthetic: true;
  note: string;
  tags: Tag[];
  places: InsightsEntity[];
  destinations: InsightsEntity[];
}

export function loadDemoData(file: URL = DEMO_FILE): DemoData {
  const data = JSON.parse(readFileSync(file, "utf8")) as DemoData;
  if (data.synthetic !== true) throw new Error("The demo fixtures must be marked synthetic");
  return data;
}

/** 32-bit FNV-1a. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A synthetic entity ID in the fixtures' all-zero range: 00000000-0000-4000-8000-0001xxxxxxxx. */
export function syntheticId(seed: string): string {
  return `00000000-0000-4000-8000-0001${fnv1a(seed).toString(16).padStart(8, "0")}`;
}

/**
 * A stable number in [0, 1) from a string. FNV-1a's high bits barely change when only the
 * last characters differ (as the fixture IDs do), so the hash goes through murmur3's fmix32.
 */
function unit(seed: string): number {
  let h = fnv1a(seed);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 0x1_0000_0000;
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const list = (v: string | undefined) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const bare = (name: string) => (name.endsWith(DEMO_SUFFIX) ? name.slice(0, -DEMO_SUFFIX.length) : name);

export function createDemoTransport(data: DemoData = loadDemoData()): QlooTransport {
  function search(p: Params) {
    const query = (p.query ?? "").trim();
    const type = (p.types ?? "").split(",")[0] ?? "";
    // Text with no letters or digits matches nothing, as a real search would.
    if (!/[\p{L}\p{N}]/u.test(query)) return { success: true, duration: 0, results: [] };
    const take = Math.max(1, Number(p.take ?? "1") || 1);
    const results = [
      {
        name: `${query}${DEMO_SUFFIX}`,
        entity_id: syntheticId(`${fold(query)}|${type}`),
        types: [type],
        popularity: round3(0.3 + unit(`pop|${fold(query)}`) * 0.6),
        properties: {},
      },
    ].slice(0, take);
    return { success: true, duration: 0, results };
  }

  function tags(p: Params) {
    const q = fold(p["filter.query"] ?? "");
    const take = Math.max(1, Math.min(50, Number(p.take ?? "20") || 20));
    let hits = data.tags.filter((t) => fold(bare(t.name)).includes(q));
    if (!hits.length) {
      const words = q.split(/\s+/).filter((w) => w.length >= 3);
      hits = data.tags.filter((t) => words.some((w) => fold(bare(t.name)).includes(w)));
    }
    if (!q) hits = [];
    return { success: true, duration: 0, results: { tags: hits.slice(0, take) } };
  }

  function insights(p: Params) {
    const type = p["filter.type"];
    const pool = type === "urn:entity:destination" ? data.destinations : type === "urn:entity:place" ? data.places : [];
    const entities = list(p["signal.interests.entities"]);
    const signalTags = list(p["signal.interests.tags"]);
    const filterTags = list(p["filter.tags"]);
    const country = p["filter.geocode.country_code"];
    const town = p["filter.geocode.name"];
    const take = Math.max(1, Math.min(50, Number(p.take ?? "20") || 20));

    const kept = pool.filter((e) => {
      const g = e.properties?.geocode ?? {};
      if (country && g.country_code !== country) return false;
      if (town && fold(g.city ?? g.name ?? "") !== fold(town)) return false;
      if (filterTags.length && !(e.tags ?? []).some((t) => t.id && filterTags.includes(t.id))) return false;
      return true;
    });

    const scored = kept.map((e) => {
      const placeTags = new Set((e.tags ?? []).map((t) => t.id));
      const parts = [
        ...entities.map((id) => ({ key: "signal.interests.entities", field: "entity_id", id, raw: unit(`${id}|${e.entity_id}`) })),
        ...signalTags.map((id) => ({ key: "signal.interests.tags", field: "tag_id", id, raw: unit(`${id}|${e.entity_id}`) * 0.5 + (placeTags.has(id) ? 0.5 : 0) })),
      ];
      const affinity = parts.length
        ? round3(0.05 + 0.94 * (parts.reduce((s, x) => s + x.raw, 0) / parts.length))
        : round3(e.popularity ?? 0.5);
      const total = parts.reduce((s, x) => s + x.raw, 0) || 1;
      const explainability: Record<string, Array<Record<string, string | number>>> = {};
      for (const x of parts) (explainability[x.key] ??= []).push({ [x.field]: x.id, score: round3(x.raw / total) });
      return { ...e, query: { affinity, explainability } };
    });
    scored.sort((a, b) => b.query.affinity - a.query.affinity || a.entity_id.localeCompare(b.entity_id));
    return { success: true, duration: 0, results: { entities: scored.slice(0, take) } };
  }

  const handlers: Record<Endpoint, (p: Params) => unknown> = { search, tags, insights };
  return {
    async get(endpoint, params) {
      // A deep copy, so a caller can never change the fixtures.
      return { body: structuredClone(handlers[endpoint](params)), cached: false };
    },
  };
}
