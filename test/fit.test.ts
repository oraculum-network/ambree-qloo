// How a thing to do fits the tastes: Qloo's tags on the tastes (from /search) against the
// places' tags. Synthetic places only: invented names, all-zero IDs.

import { describe, expect, it } from "vitest";
import type { InsightsEntity } from "../src/qloo/contract.ts";
import { fitAll, fitOf, norm, profileOf } from "../src/tools/fit.ts";
import { id } from "./helpers/shapes.ts";

let n = 0;
/** A place with tags given as "type/Name" (type defaults to activity_type). */
function place(name: string, tags: string[]): InsightsEntity {
  return {
    name: `${name} (demo)`,
    entity_id: id(500 + n++),
    tags: tags.map((t) => {
      const [type, tagName] = t.includes("/") ? t.split("/") : ["activity_type", t];
      return { id: `urn:tag:${type}:qloo:${norm(tagName!).replace(/ /g, "_")}`, name: tagName, type: `urn:tag:${type}:qloo` };
    }),
  };
}

const film = (tags: string[]) => ({ input: "Some Film", kind: "film", tags });

describe("fit", () => {
  it("a theme weighs 1 for one taste tag, 1.5 for two, 2 for three or more; a music taste adds 1 to music", () => {
    const one = profileOf([film(["Scuba diving"])]);
    expect(one.get("theme:sea")).toMatchObject({ weight: 1, taste: "Some Film", tasteTag: "Scuba diving" });
    expect(profileOf([film(["Ocean", "Island"])]).get("theme:sea")!.weight).toBe(1.5);
    expect(profileOf([film(["Ocean", "Island", "Canoe", "Lagoon", "Coral"])]).get("theme:sea")!.weight).toBe(2);
    expect(profileOf([{ input: "Some Band", kind: "music", tags: [] }]).get("theme:music")).toMatchObject({ weight: 1, taste: "Some Band" });
    expect(profileOf([{ input: "Some Band", kind: "music", tags: ["Jazz"] }]).get("theme:music")!.weight).toBe(2);
  });

  it("shared names skip generic words and anything with a digit (age bands, formats)", () => {
    const p = profileOf([film(["Nature", "Casual", "18-24", "3 dimensional", "Romantic"])]);
    expect([...p.keys()].filter((k) => k.startsWith("tag:"))).toEqual(["tag:romantic"]);
  });

  it("a food taste links to its cuisine's words and to markets and food stalls", () => {
    const p = profileOf([{ input: "street food", kind: "food", tags: [], cuisine: "street_food" }]);
    const list = [place("Market", ["amenity/Market stalls"]), place("Beach", ["Swimming"]), place("Hill", ["Hiking"])];
    const fits = fitAll(list, p);
    expect(fitOf(fits, list[0]!).links).toMatchObject([{ key: "food:street_food", placeTag: "Market stalls", taste: "street food", food: true }]);
    expect(fitOf(fits, list[1]!).score).toBe(0);
  });

  it("a link counts more the fewer places carry it, and nothing when every place does", () => {
    const p = profileOf([film(["Scuba diving", "Spirituality"])]);
    const list = [
      place("Temple", ["Meditation", "Swimming"]),
      place("Beach A", ["Snorkeling"]),
      place("Beach B", ["Snorkeling"]),
      place("Beach C", ["Lagoon"]),
    ];
    const fits = fitAll(list, p);
    // Spiritual: 1 of 4 places, ln 4; the sea is on all four, ln 1 = 0.
    expect(fitOf(fits, list[0]!).score).toBeCloseTo(Math.log(4));
    expect(fitOf(fits, list[0]!).links.map((l) => l.key)).toEqual(["theme:spiritual"]);
    expect(fitOf(fits, list[1]!).score).toBe(0);
  });

  it("each key once per place; one place tag serves one key; admin tag types never link", () => {
    const p = profileOf([film(["Ocean", "Romantic"])]);
    const list = [
      place("Bay", ["Snorkeling", "Swimming", "ambience/Romantic"]),
      place("Hill", ["Hiking", "age_range/Romantic"]),
      place("Town", ["Shopping"]),
    ];
    const fits = fitAll(list, p);
    expect(fitOf(fits, list[0]!).links.map((l) => [l.key, l.placeTag])).toEqual([
      ["theme:sea", "Snorkeling"],
      ["tag:romantic", "Romantic"],
    ]);
    expect(fitOf(fits, list[1]!).links).toEqual([]);
  });

  it("no tastes with tags and no food or music: no fits, so Qloo's order decides", () => {
    const list = [place("Bay", ["Snorkeling"])];
    expect(fitAll(list, profileOf([film([])])).size).toBe(0);
    expect(fitOf(new Map(), list[0]!)).toEqual({ score: 0, links: [] });
  });
});
