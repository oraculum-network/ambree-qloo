// The synthetic demo fixtures: contract-shaped, visibly synthetic, deterministic.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { insightsParams, searchParams, tagsParams } from "../src/qloo/client.ts";
import { InsightsResponse, checkShape } from "../src/qloo/contract.ts";
import { DEMO_FILE, createDemoTransport, loadDemoData, syntheticId } from "../src/qloo/fixtures.ts";

const demo = createDemoTransport();
const data = loadDemoData();
const raw = readFileSync(DEMO_FILE, "utf8");
const SYNTHETIC_ID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;

async function topPlace(entities: string[]) {
  const { body } = await demo.get("insights", insightsParams({ type: "urn:entity:place", entities, countryCode: "MU", take: 5 }));
  return InsightsResponse.parse(body).results.entities;
}

describe("demo fixtures", () => {
  it("every fixture response passes the contract", async () => {
    const calls = [
      ["search", searchParams("Some Band", "urn:entity:artist")],
      ["search", searchParams("???", "urn:entity:movie")],
      ["tags", tagsParams("beach")],
      ["tags", tagsParams("nothing-like-this")],
      ["insights", insightsParams({ type: "urn:entity:place", entities: [syntheticId("a")], countryCode: "MU", take: 10 })],
      ["insights", insightsParams({ type: "urn:entity:destination", entities: [syntheticId("b")], countryCode: "MU", take: 10 })],
      ["insights", insightsParams({ type: "urn:entity:place", tags: ["urn:tag:category:place:beach"], town: "Grand Baie", take: 3 })],
    ] as const;
    for (const [endpoint, params] of calls) {
      const { body } = await demo.get(endpoint, params);
      expect(checkShape(endpoint, body), `${endpoint} ${JSON.stringify(params)}`).toEqual({ ok: true, mismatches: [] });
    }
    for (const e of [...data.places, ...data.destinations]) {
      expect(checkShape("insights", { success: true, results: { entities: [e] } }).ok).toBe(true);
    }
    expect(checkShape("tags", { success: true, results: { tags: data.tags } }).ok).toBe(true);
  });

  it("every ID matches the synthetic pattern, every name ends (demo), synthetic=true", async () => {
    expect(data.synthetic).toBe(true);
    expect(data.note).toBe("Hand-written demo data in the shape of Qloo's documented responses. Not from Qloo.");
    expect(data.places.length).toBeGreaterThanOrEqual(28);
    expect(data.destinations).toHaveLength(6);
    expect(data.tags.length).toBeGreaterThanOrEqual(20);
    // Tag IDs are Qloo's taxonomy (so demo runs the live classification code); every name is invented.
    const TAXONOMY_ID = /^urn:tag:(category:place|genre:place|cuisine:qloo|setting:qloo|ambience:qloo|activity_type:qloo|amenity:qloo):[a-z_:]+$/;
    for (const e of [...data.places, ...data.destinations]) {
      expect(e.entity_id).toMatch(SYNTHETIC_ID);
      expect(e.name).toMatch(/ \(demo\)$/);
      expect(e.properties?.geocode?.country_code).toBe("MU");
      for (const t of e.tags ?? []) {
        expect(t.id).toMatch(TAXONOMY_ID);
        expect(t.name).toMatch(/ \(demo\)$/);
      }
    }
    for (const t of data.tags) {
      expect(t.id).toMatch(TAXONOMY_ID);
      expect(t.name).toMatch(/ \(demo\)$/);
    }
    // Each place says what it is, as live places do.
    for (const e of data.places) expect((e.properties?.primary_genre as { id: string }).id, e.name).toMatch(/^urn:tag:genre:place:/);
    const ids = [...data.places, ...data.destinations].map((e) => e.entity_id);
    expect(new Set(ids).size).toBe(ids.length);
    const towns = new Set(data.places.map((p) => p.properties?.geocode?.city));
    // "Chamarel VCA": the admin suffix live geocodes carry, so demo shows it cleaned.
    expect([...towns].sort()).toEqual(["Chamarel VCA", "Curepipe", "Flic en Flac", "Grand Baie", "Mahébourg", "Port Louis"]);
    const { body } = await demo.get("search", searchParams("Some Band", "urn:entity:artist"));
    const hit = (body as { results: Array<{ entity_id: string; name: string }> }).results[0]!;
    expect(hit.entity_id).toMatch(SYNTHETIC_ID);
    expect(hit.name).toBe("Some Band (demo)");
  });

  it("fixture IDs and names do not include any doc example", () => {
    // Names and IDs quoted in Qloo's docs and recipes (qloo-api-notes.md §3-4).
    const denylist = [
      "Balthazar",
      "Catch NYC",
      "8119141A-D38C-428E-819D-CAA5027120C2",
      "urn:tag:amenity:place:rooftop_bar",
      "Rooftop Bar",
      "urn:tag:genre:restaurant:Italian",
      "Chicago",
      "NYC",
    ];
    for (const word of denylist) expect(raw.toLowerCase(), word).not.toContain(word.toLowerCase());
  });

  it("different tastes → different top place", async () => {
    const tops = new Set<string>();
    for (const seed of ["jazz", "reggae", "sci-fi films", "cookbooks", "indie games", "Sega"]) {
      tops.add((await topPlace([syntheticId(`${seed}|urn:entity:artist`)]))[0]!.entity_id);
    }
    expect(tops.size).toBeGreaterThan(1);
  });

  it("same input → same output", async () => {
    const a = await topPlace([syntheticId("x"), syntheticId("y")]);
    const b = await topPlace([syntheticId("x"), syntheticId("y")]);
    expect(a).toEqual(b);
    const s1 = await demo.get("search", searchParams("Café Jazz", "urn:entity:artist"));
    const s2 = await demo.get("search", searchParams("cafe jazz", "urn:entity:artist"));
    expect((s1.body as { results: Array<{ entity_id: string }> }).results[0]!.entity_id).toBe(
      (s2.body as { results: Array<{ entity_id: string }> }).results[0]!.entity_id,
    );
  });

  it("insights honours take, filter.tags, the town and the country, and explains each signal", async () => {
    const sig = syntheticId("s");
    const { body } = await demo.get("insights", insightsParams({ type: "urn:entity:place", entities: [sig], filterTags: ["urn:tag:category:place:beach"], countryCode: "MU", take: 1 }));
    const ents = InsightsResponse.parse(body).results.entities;
    expect(ents).toHaveLength(1);
    expect(ents[0]!.tags!.map((t) => t.id)).toContain("urn:tag:category:place:beach");
    expect(ents[0]!.query?.explainability).toEqual({ "signal.interests.entities": [{ entity_id: sig, score: 1 }] });
    const inTown = InsightsResponse.parse((await demo.get("insights", insightsParams({ type: "urn:entity:place", entities: [sig], town: "mahebourg", take: 10 }))).body);
    expect(inTown.results.entities.map((e) => e.properties?.geocode?.city)).toEqual(["Mahébourg", "Mahébourg", "Mahébourg", "Mahébourg", "Mahébourg"]);
    const elsewhere = InsightsResponse.parse((await demo.get("insights", insightsParams({ type: "urn:entity:place", entities: [sig], countryCode: "FR", take: 10 }))).body);
    expect(elsewhere.results.entities).toEqual([]);
  });

  it("tags matches by substring, then by word", async () => {
    const names = async (q: string) => ((await demo.get("tags", tagsParams(q, 10))).body as { results: { tags: Array<{ name: string }> } }).results.tags.map((t) => t.name);
    expect(await names("beach")).toEqual(["Beach (demo)"]);
    expect(await names("food")).toEqual(["Seafood (demo)", "Street food (demo)"]);
    expect(await names("spicy street food")).toEqual(["Seafood (demo)", "Street food (demo)"]);
    expect(await names("zzzz")).toEqual([]);
  });

  it("callers can't change the fixtures", async () => {
    const { body } = await demo.get("insights", insightsParams({ type: "urn:entity:place", entities: [syntheticId("m")], take: 1 }));
    (body as { results: { entities: Array<{ name: string }> } }).results.entities[0]!.name = "changed";
    const again = await topPlace([syntheticId("m")]);
    expect(again[0]!.name).not.toBe("changed");
  });
});
