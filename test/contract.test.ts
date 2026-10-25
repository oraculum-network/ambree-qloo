// The Qloo contract against hand-written bodies in each documented shape.

import { describe, expect, it } from "vitest";
import { InsightsResponse, QlooErrorBody, affinityOf, checkShape, explainedBy, townOf } from "../src/qloo/contract.ts";
import { id, insightsBodyA, insightsBodyB, searchBody, tagsBody } from "./helpers/shapes.ts";

describe("search", () => {
  it("search shape: flat results array passes", () => {
    expect(checkShape("search", searchBody(["A (demo)", "B (demo)"]))).toEqual({ ok: true, mismatches: [] });
  });

  it("search nested `results.entities` fails with a path", () => {
    const r = checkShape("search", { success: true, results: { entities: [] } });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(["$.results expected array, got object"]);
  });
});

describe("insights", () => {
  it("insights shape A (type urn:entity + subtype + query.affinity) passes", () => {
    expect(checkShape("insights", insightsBodyA(3)).ok).toBe(true);
  });

  it("insights shape B (type urn:entity:place + properties.affinity) passes", () => {
    expect(checkShape("insights", insightsBodyB()).ok).toBe(true);
  });

  it("empty entities is valid", () => {
    expect(checkShape("insights", { success: true, results: { entities: [] } }).ok).toBe(true);
  });

  it("unknown extra fields are kept", () => {
    const body = insightsBodyA(1);
    const withExtra = { ...body, duration: 0.2, results: { ...body.results, entities: [{ ...body.results.entities[0], external: { x: 1 }, disambiguation: "d" }] } };
    const parsed = InsightsResponse.parse(withExtra);
    expect(parsed.results.entities[0]).toHaveProperty("external", { x: 1 });
    expect(parsed).toHaveProperty("duration", 0.2);
  });

  it("missing entity_id is a mismatch", () => {
    const body = insightsBodyA(2);
    delete (body.results.entities[1] as { entity_id?: string }).entity_id;
    expect(checkShape("insights", body)).toEqual({ ok: false, mismatches: ["$.results.entities[1].entity_id expected string, got missing"] });
  });

  it("affinityOf prefers query.affinity", () => {
    const e = InsightsResponse.parse(insightsBodyA(1)).results.entities[0]!;
    expect(affinityOf({ ...e, query: { affinity: 0.5 }, properties: { affinity: 0.1 } })).toBe(0.5);
    expect(affinityOf(InsightsResponse.parse(insightsBodyB()).results.entities[0]!)).toBe(0.77);
    expect(affinityOf({ name: "x", entity_id: id(1) })).toBe(0);
  });

  it("townOf uses geocode.city, then geocode.name", () => {
    expect(townOf({ name: "x", entity_id: id(1), properties: { geocode: { city: "Curepipe", name: "Other" } } })).toBe("Curepipe");
    expect(townOf({ name: "x", entity_id: id(1), properties: { geocode: { name: "Chamarel" } } })).toBe("Chamarel");
  });

  it("explainedBy reads per-signal scores and ignores unknown forms", () => {
    const e = { name: "x", entity_id: id(1), query: { explainability: { "signal.interests.entities": [{ entity_id: id(2), score: 0.3 }, { entity_id: id(3), score: 0.7 }] } } };
    expect(explainedBy(e)).toEqual([
      { id: id(3), score: 0.7 },
      { id: id(2), score: 0.3 },
    ]);
    expect(explainedBy({ name: "x", entity_id: id(1), query: { explainability: { warning: "n/a" } } })).toEqual([]);
  });
});

describe("tags", () => {
  it("tags shape passes", () => {
    expect(checkShape("tags", tagsBody(3)).ok).toBe(true);
  });

  it("tags-from-insights shape (tag_id, types) is not mistaken for /v2/tags", () => {
    const r = checkShape("tags", { success: true, results: { tags: [{ tag_id: "urn:tag:demo:x", name: "X (demo)", types: ["urn:entity:place"], subtype: "s" }] } });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(["$.results.tags[0].id expected string, got missing"]);
  });
});

describe("errors", () => {
  it("error body {code, reason, message} parses", () => {
    expect(QlooErrorBody.parse({ code: 429, reason: "Too Many Requests", message: "Rate limit exceeded" })).toEqual({
      code: 429,
      reason: "Too Many Requests",
      message: "Rate limit exceeded",
    });
    expect(QlooErrorBody.safeParse({}).success).toBe(true);
  });

  it("mismatches never include values", () => {
    const r = checkShape("search", { success: "yes-secret-looking-value", results: [] });
    expect(r.mismatches.join(" ")).not.toContain("secret");
    expect(r.mismatches).toEqual(["$.success expected boolean, got string"]);
  });
});
