// Hand-written response bodies in the documented Qloo shapes, for contract and client
// tests. Synthetic only: invented names and all-zero IDs, no real Qloo data.

export const SENTINEL_KEY = "test-key-not-real-0000";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function searchBody(names: string[] = ["Test Artist (demo)"], type = "urn:entity:artist") {
  return { success: true, duration: 0.01, results: names.map((name, i) => ({ name, entity_id: id(900 + i), types: [type], popularity: 0.5, properties: {} })) };
}

export function tagsBody(n = 2) {
  return {
    success: true,
    results: {
      tags: Array.from({ length: n }, (_, i) => ({
        id: `urn:tag:demo:test_${i}`,
        name: `Test tag ${i} (demo)`,
        type: "urn:tag:demo:place",
        parents: [{ type: "urn:entity:place" }],
        popularity: 0.4,
      })),
    },
  };
}

/** Shape A: type "urn:entity" + subtype + query.affinity. */
export function insightsBodyA(n = 2, country = "MU") {
  return {
    success: true,
    results: {
      entities: Array.from({ length: n }, (_, i) => ({
        name: `Test Place ${i} (demo)`,
        entity_id: id(800 + i),
        type: "urn:entity",
        subtype: "urn:entity:place",
        properties: { geocode: { name: "Port Louis", country_code: country } },
        tags: [{ id: "urn:tag:demo:test_0", name: "Test tag 0 (demo)", type: "urn:tag:demo:place" }],
        query: { affinity: 0.9 - i / 10 },
      })),
    },
  };
}

// The live shapes (27 Oct 2026): the keys the live API sent, with synthetic values.

/** Live /search: top-level `results` only, no `success`. */
export function liveSearchBody(names: string[] = ["Test Artist (demo)"], type = "urn:entity:artist") {
  return { results: names.map((name, i) => ({ name, entity_id: id(700 + i), types: [type] })) };
}

/** Live /v2/tags: duration, success, results.tags. */
export function liveTagsBody(n = 3) {
  return { duration: 0.02, ...tagsBody(n) };
}

/**
 * Live /v2/insights: success + results.entities with `types` and `subtype`, an address, a
 * geocode whose regions are null, tags, and no query.affinity. Place 0 has a town; the rest
 * have only a country code.
 */
export function liveInsightsBody(n = 5, country = "MU") {
  return {
    success: true,
    results: {
      entities: Array.from({ length: n }, (_, i) => ({
        entity_id: id(600 + i),
        name: `Live Shape Place ${i} (demo)`,
        types: ["urn:entity:place"],
        subtype: "urn:entity:place",
        properties: {
          address: `${i} Demo Road (demo)`,
          geocode: { name: i === 0 ? "Port Louis" : null, city: null, country_code: country, admin1_region: null, admin2_region: null },
        },
        tags: [{ id: "urn:tag:demo:test_0", name: "Test tag 0 (demo)", type: "urn:tag:demo:place" }],
      })),
    },
  };
}

/** Shape B: type "urn:entity:place" + properties.affinity. */
export function insightsBodyB() {
  return {
    success: true,
    results: { entities: [{ name: "Test Place B (demo)", entity_id: id(850), type: "urn:entity:place", properties: { affinity: 0.77 } }] },
  };
}
