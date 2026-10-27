// What kind of place a Qloo insights entity is, read from the IDs live Qloo sends for
// Mauritius (checked against live responses on 27 Oct 2026, none kept): every place has
// properties.primary_genre.id (e.g. urn:tag:genre:place:hotel:resort, ...:restaurant:cafe,
// ...:tourist_attraction) and category/genre tags. The tag IDs used as filter.tags each
// returned 20 to 25 Mauritius places; a beach, museum or park category returned 2 or 3.

import type { InsightsEntity } from "../qloo/contract.ts";

/** filter.tags for each kind of stop. */
export const FILTER_TAGS = {
  /** Beaches, viewpoints, waterfalls, nature reserves, museums, markets: Qloo files them all here. */
  thingsToDo: "urn:tag:category:place:tourist_attraction",
  /** Restaurants and cafes; hotels with a restaurant come back too, so isHotel sorts them last. */
  restaurant: "urn:tag:genre:place:restaurant",
  bar: "urn:tag:category:place:bar",
} as const;

const HOTEL_GENRE = "urn:tag:genre:place:hotel";
const RESTAURANT_GENRE = "urn:tag:genre:place:restaurant";
/** Primary genres of places to eat or drink: never a morning or afternoon stop. */
const MEAL_GENRES = [RESTAURANT_GENRE, "urn:tag:genre:place:bar", "urn:tag:genre:place:pub", "urn:tag:genre:place:lounge", "urn:tag:genre:place:night_club"];
const HOTEL_TAGS = ["urn:tag:category:place:hotel", "urn:tag:category:place:resort_hotel", HOTEL_GENRE, "urn:tag:genre:place:hotel:resort"];
const RESTAURANT_TAGS = [RESTAURANT_GENRE, "urn:tag:category:place:restaurant"];
const BAR_TAGS = [
  FILTER_TAGS.bar,
  "urn:tag:genre:place:restaurant:bar",
  "urn:tag:category:place:pub",
  "urn:tag:category:place:cocktail_bar",
  "urn:tag:category:place:lounge",
  "urn:tag:category:place:night_club",
  "urn:tag:category:place:live_music_bar",
];

const under = (id: string, root: string) => id === root || id.startsWith(`${root}:`);

/** The tag IDs on a place (id, else tag_id). */
export function tagIds(e: InsightsEntity): Set<string> {
  const out = new Set<string>();
  for (const t of e.tags ?? []) {
    const id = t.id ?? t.tag_id;
    if (id) out.add(id);
  }
  return out;
}

/** properties.primary_genre.id, if Qloo sent one. */
export function primaryGenre(e: InsightsEntity): string | undefined {
  const g = e.properties?.primary_genre as { id?: unknown } | null | undefined;
  return typeof g?.id === "string" && g.id ? g.id : undefined;
}

const hasAny = (ids: Set<string>, list: readonly string[]) => list.some((id) => ids.has(id));

/** A hotel, resort, lodge or guest house: by primary genre, else by its hotel tags. */
export function isHotel(e: InsightsEntity): boolean {
  const g = primaryGenre(e);
  return g ? under(g, HOTEL_GENRE) : hasAny(tagIds(e), HOTEL_TAGS);
}

/** Tagged as a restaurant (or cafe): a hotel can be one too. */
export function isRestaurant(e: InsightsEntity): boolean {
  const g = primaryGenre(e);
  if (g && under(g, RESTAURANT_GENRE)) return true;
  const ids = tagIds(e);
  return hasAny(ids, RESTAURANT_TAGS) || [...ids].some((id) => /^urn:tag:category:place:\w+_restaurant$/.test(id));
}

const BAR_GENRE = "urn:tag:genre:place:restaurant:bar";

export function isBar(e: InsightsEntity): boolean {
  return primaryGenre(e) === BAR_GENRE || hasAny(tagIds(e), BAR_TAGS);
}

/** A bar first and foremost (Qloo files bars under the restaurant genre): lunch takes one last. */
export function isMainlyBar(e: InsightsEntity): boolean {
  const g = primaryGenre(e);
  return g ? g === BAR_GENRE : isBar(e) && !isRestaurant(e);
}

/** Something to do between meals: not a hotel, and not mainly a place to eat or drink. */
export function isThingToDo(e: InsightsEntity): boolean {
  if (isHotel(e)) return false;
  const g = primaryGenre(e);
  if (g) return !MEAL_GENRES.some((m) => under(g, m));
  return !isRestaurant(e) && !isBar(e);
}
