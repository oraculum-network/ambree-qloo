// What kind of place a Qloo entity is (src/tools/places.ts), on synthetic entities shaped
// like the live ones: properties.primary_genre.id plus category/genre tags.

import { describe, expect, it } from "vitest";
import type { InsightsEntity } from "../src/qloo/contract.ts";
import { FILTER_TAGS, cuisineOf, cuisineTag, isBar, isHotel, isMainlyBar, isRestaurant, isThingToDo, liveMusicTag, primaryGenre } from "../src/tools/places.ts";
import { id } from "./helpers/shapes.ts";

function place(genre: string | undefined, tagIds: string[] = []): InsightsEntity {
  return {
    name: "Somewhere (demo)",
    entity_id: id(500),
    properties: { geocode: { country_code: "MU" }, ...(genre ? { primary_genre: { id: genre, akas: [] } } : {}) },
    tags: tagIds.map((t) => ({ id: t, name: "Tag (demo)", type: t.split(":").slice(0, -1).join(":") })),
  };
}

describe("places", () => {
  it("the filter tags are the ones live Qloo answered with 20 to 25 Mauritius places", () => {
    expect(FILTER_TAGS).toEqual({
      thingsToDo: "urn:tag:category:place:tourist_attraction",
      restaurant: "urn:tag:genre:place:restaurant",
      bar: "urn:tag:category:place:bar",
    });
  });

  it("a resort is a hotel and never a thing to do, even when tagged as an attraction", () => {
    const resort = place("urn:tag:genre:place:hotel:resort", [FILTER_TAGS.thingsToDo, "urn:tag:category:place:resort_hotel"]);
    expect(isHotel(resort)).toBe(true);
    expect(isThingToDo(resort)).toBe(false);
    expect(isHotel(place("urn:tag:genre:place:hotel"))).toBe(true);
    expect(isHotel(place("urn:tag:genre:place:hotel:lodge", [FILTER_TAGS.bar]))).toBe(true);
    // A casino Qloo files under hotels is not a sight either.
    expect(isThingToDo(place("urn:tag:genre:place:hotel:casino", [FILTER_TAGS.thingsToDo]))).toBe(false);
  });

  it("a hotel can also be a restaurant (for a meal, last); a plain hotel is not", () => {
    expect(isRestaurant(place("urn:tag:genre:place:hotel", ["urn:tag:category:place:restaurant"]))).toBe(true);
    expect(isRestaurant(place("urn:tag:genre:place:hotel:resort", ["urn:tag:category:place:vegan_restaurant"]))).toBe(true);
    expect(isRestaurant(place("urn:tag:genre:place:hotel", ["urn:tag:category:place:hotel"]))).toBe(false);
  });

  it("restaurants, cafes and bars are meals, not things to do", () => {
    for (const g of ["urn:tag:genre:place:restaurant", "urn:tag:genre:place:restaurant:cafe", "urn:tag:genre:place:restaurant:seafood"]) {
      expect(isRestaurant(place(g)), g).toBe(true);
      expect(isThingToDo(place(g, [FILTER_TAGS.thingsToDo])), g).toBe(false);
    }
    const pub = place("urn:tag:genre:place:restaurant:bar", [FILTER_TAGS.bar]);
    expect([isBar(pub), isMainlyBar(pub), isThingToDo(pub)]).toEqual([true, true, false]);
    // A restaurant with a bar is a bar for the evening but not mainly a bar.
    const both = place("urn:tag:genre:place:restaurant", [FILTER_TAGS.bar]);
    expect([isBar(both), isMainlyBar(both), isRestaurant(both)]).toEqual([true, false, true]);
    expect(isThingToDo(place("urn:tag:genre:place:lounge"))).toBe(false);
  });

  it("beaches, viewpoints, reserves, museums and markets are things to do", () => {
    for (const g of ["beach", "tourist_attraction", "scenic_spot", "nature_preserve", "museum", "market", "island"]) {
      expect(isThingToDo(place(`urn:tag:genre:place:${g}`, [FILTER_TAGS.thingsToDo])), g).toBe(true);
    }
    // A sight with a restaurant on site (an amenity tag) stays a sight.
    expect(isThingToDo(place("urn:tag:genre:place:tourist_attraction", ["urn:tag:amenities:place:restaurant"]))).toBe(true);
  });

  it("a food tag's cuisine matches the cuisine tags places carry", () => {
    // What /v2/tags answered first for each example food word.
    expect(cuisineOf("urn:tag:genre:place:restaurant:seafood")).toBe("seafood");
    expect(cuisineOf("urn:tag:cuisine:qloo:street_food")).toBe("street_food");
    expect(cuisineOf("urn:tag:genre:place:restaurant:cafe")).toBe("cafe");
    const r = (ids: string[]) => place("urn:tag:genre:place:restaurant", ids);
    expect(cuisineTag(r(["urn:tag:cuisine:qloo:seafood"]), "seafood")?.id).toBe("urn:tag:cuisine:qloo:seafood");
    expect(cuisineTag(r(["urn:tag:category:place:seafood_restaurant"]), "seafood")?.id).toBe("urn:tag:category:place:seafood_restaurant");
    expect(cuisineTag(r(["urn:tag:genre:place:restaurant:street_food"]), "street_food")).toBeDefined();
    expect(cuisineTag(r(["urn:tag:category:place:cafe"]), "cafe")).toBeDefined();
    // Not a near miss: a seafood market, a seafood-themed menu item, or another cuisine.
    expect(cuisineTag(r(["urn:tag:menu_highlight:qloo:seafood_platter", "urn:tag:cuisine:qloo:mauritian"]), "seafood")).toBeUndefined();
    expect(cuisineTag(r(["urn:tag:cuisine:qloo:seafood"]), "")).toBeUndefined();
  });

  it("live music: a live-music tag of any type, or properties.live_music true", () => {
    for (const t of ["urn:tag:amenity:qloo:live_music", "urn:tag:good_for:qloo:live_music", "urn:tag:category:place:live_music_bar", "urn:tag:genre:place:live_music_venue"]) {
      expect(liveMusicTag(place("urn:tag:genre:place:restaurant:bar", [t]))?.id, t).toBe(t);
    }
    expect(liveMusicTag(place("urn:tag:genre:place:restaurant:bar", ["urn:tag:interests:qloo:music_festivals"]))).toBeUndefined();
    const flagged = { ...place("urn:tag:genre:place:restaurant:bar"), properties: { live_music: true } };
    expect(liveMusicTag(flagged)?.name).toBe("Live music");
    expect(liveMusicTag({ ...flagged, properties: { live_music: null } })).toBeUndefined();
  });

  it("with no primary genre, the tags decide", () => {
    expect(primaryGenre(place(undefined))).toBeUndefined();
    expect(isHotel(place(undefined, ["urn:tag:category:place:resort_hotel"]))).toBe(true);
    expect(isRestaurant(place(undefined, ["urn:tag:category:place:seafood_restaurant"]))).toBe(true);
    expect(isThingToDo(place(undefined, ["urn:tag:category:place:seafood_restaurant"]))).toBe(false);
    expect(isThingToDo(place(undefined, [FILTER_TAGS.thingsToDo]))).toBe(true);
    expect(isMainlyBar(place(undefined, [FILTER_TAGS.bar]))).toBe(true);
    // A primary genre that isn't an object with an id is ignored, not a crash.
    const odd = { ...place(undefined, [FILTER_TAGS.thingsToDo]), properties: { primary_genre: "urn:tag:genre:place:hotel" } };
    expect(primaryGenre(odd)).toBeUndefined();
  });
});
