// How well a thing to do fits the traveller's tastes, from Qloo's own tags on both sides.
// /search returns each artist, film or book with its Qloo tags ("Spiritual", "Swimming
// underwater", "Forest imagery", "Relaxed"...); every place carries its own ("Snorkeling",
// "Meditation", "Hiking", "Serene"...). They live in different namespaces (media tags vs
// place tags), so they meet through a few themes, plus any tag name both sides share.
// A link counts more when few places in the list carry it (inverse document frequency),
// so "Nature" or "Quiet", on nearly every sight in Mauritius, tells nothing.

import type { InsightsEntity } from "../qloo/contract.ts";

/** A theme: taste tags that point to it, and the place tags that answer it. Matched on lower-case tag names. */
export interface Theme {
  id: string;
  taste: RegExp;
  place: RegExp;
}

export const THEMES: readonly Theme[] = [
  {
    id: "sea",
    taste: /\b(ocean|sea|seafaring|sailing|sailor|boats?|ships?|voyage|islands?|beach|surf\w*|swim\w*|diving|underwater|coral|lagoon|dolphins?|whales?|canoe|castaway|marine|pacific|tropical|waves?)\b/,
    place: /\b(snorkel\w*|swimming|lagoon|coral\w*|marine\w*|boat\w*|catamaran|water activities|water sports|surf\w*|kayak\w*|beach\w*|island hopping|parasailing|diving)\b/,
  },
  {
    id: "spiritual",
    taste: /\b(spiritual\w*|religio\w*|prayer|meditat\w*|god|gods|deity|hindu|buddh\w*|rastafari\w*|ashram|temples?|church|faith|sacred|mystic\w*)\b/,
    place: /\b(spiritual\w*|religio\w*|prayer|meditation|temple|mosque|church|cathedral|yoga|zen)\b/,
  },
  {
    id: "nature",
    taste: /\b(nature|forests?|forest imagery|environment\w*|conservation|wilderness|jungle|mountains?|outdoors?|hiking|ecolog\w*|trees?|wildlife)\b/,
    place: /\b(forest|hiking\w*|nature preserve|nature reserve|conservation\w*|birdwatching|botan\w*|national park|ecolog\w*|eco ?tourism|mountain climbing|trekking)\b/,
  },
  {
    id: "history",
    taste: /\b(history|historical|heritage|period|colonial|war|\d{4}s|vintage|nostalgi\w*|biograph\w*|mythology)\b/,
    place: /\b(histor\w*|heritage|museum|colonial|fortress|fortification|military|monuments?|architectur\w*|cultural landmark|maritime)\b/,
  },
  {
    id: "calm",
    taste: /\b(introspective|melancholi\w*|reflective|contemplative|poignant|mellow|relaxed|laid ?back|chill|peaceful|serene|calm|meditative|atmospheric|quiet)\b/,
    place: /\b(contemplat\w*|meditation|serene|tranquil|secluded|soothing|reflective|calm|unspoiled|atmospheric)\b/,
  },
  {
    id: "adventure",
    taste: /\b(adventur\w*|action|thrill\w*|energetic|exploration|quest|daring|extreme|survival)\b/,
    place: /\b(adventur\w*|quad\w*|off road\w*|extreme sports|zip ?line|mountain climbing|kayak\w*|thrill\w*|parasailing)\b/,
  },
  {
    id: "family",
    taste: /\b(animation|animated|family|kids|children|disney|pixar|fairy ?tale|playful)\b/,
    place: /\b(family friendly|family activities|amusement\w*|good for kids|playground|zoo|playful)\b/,
  },
  {
    id: "animals",
    // Tags about animals as such ("Animal", "Wildlife"), not one creature in a story ("Crab", "Animal monster").
    taste: /(^|\s)(animals?|zoo|wildlife|safari)$/,
    place: /\b(zoo|safari\w*|wildlife\w*|animals?|animal \w+|birdwatching|tortoises?|aquarium\w*)\b/,
  },
  {
    id: "music",
    taste: /\b(music|musical|singing|songs?|jazz|blues|reggae|concerts?)\b/,
    place: /\b(live music|music\w*|concerts?|jazz|sega)\b/,
  },
  {
    id: "art",
    taste: /\b(art|artistic|painting|surreal\w*|poetry)\b/,
    place: /\b(art|arts and crafts|galler\w*|optical illusions|immersive|craft\w*|sculptures?)\b/,
  },
];

/** Place tags any food lover may enjoy between meals: markets and food stalls. */
const FOOD_PLACE = /\b(markets?|market stalls|food stalls|food vendors|street vendors|food court|street food|tasting\w*)\b/;
/** Extra place words for a few cuisines (the cuisine's own words always count). */
const CUISINE_PLACE: Record<string, RegExp> = {
  cafe: /\b(coffee\w*|tea|cafe|café)\b/,
  seafood: /\b(seafood|fish\w*)\b/,
  street_food: /\b(street food|food stalls|street vendors|food vendors)\b/,
};

/** Names too generic to link anything: Qloo puts them on nearly every place or every work. */
const GENERIC = new Set(["place", "nature", "natural", "casual", "morning", "afternoon", "evening", "midday", "destination", "tourist attraction", "sightseeing", "day trip"]);
/**
 * Place tag types (urn:tag:<kind>:qloo or :place) about access, payment, audience or the
 * neighbours (nearby_attraction names other places), not about what the place is.
 */
const ADMIN_TYPE =
  /^urn:tag:(age_range|accessibility|credit_card|payments?|parking|cost_description|hotel_rating|inclusivity|customer_identity|children|amenities|pets|recycling|planning|place_page_attributes|service_options|offerings|nearby_attraction|noise_level|room_type|time_of_day_fit)(:|$)/;
/** A name with a digit ("18-24", "3 dimensional") is a format or an age band: never a shared-name link. */
const HAS_DIGIT = /\d/;

export const norm = (name: string) =>
  name
    .toLowerCase()
    .replace(/[-&/_]/g, " ")
    .replace(/[^a-z0-9éè ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** One taste as the fit sees it: what was asked, its kind, its Qloo tag names; a food taste's cuisine. */
export interface TasteTags {
  input: string;
  kind: string;
  tags: string[];
  cuisine?: string;
}

/** Why a key counts for these tastes: its weight, and the taste tag that set it off first. */
interface Want {
  weight: number;
  place: RegExp | ((placeTag: string) => boolean);
  taste: string;
  tasteTag?: string;
  food?: boolean;
}

/** What the tastes ask of a place, as link keys: themes, foods and shared tag names. */
export type Profile = Map<string, Want>;

/** Each theme weighs 1 for one matching taste tag, up to 2 for three or more; an explicit food or a music taste adds more. */
export function profileOf(tastes: TasteTags[]): Profile {
  const out: Profile = new Map();
  for (const theme of THEMES) {
    let hits = 0;
    let first: { taste: string; tasteTag: string } | undefined;
    for (const t of tastes) {
      for (const tag of new Set(t.tags.map(norm))) {
        if (!theme.taste.test(tag)) continue;
        hits++;
        first ??= { taste: t.input, tasteTag: t.tags.find((x) => norm(x) === tag)! };
      }
    }
    const music = theme.id === "music" ? tastes.find((t) => t.kind === "music") : undefined;
    if (!hits && !music) continue;
    const weight = (hits ? 1 + 0.5 * Math.min(hits - 1, 2) : 0) + (music ? 1 : 0);
    out.set(`theme:${theme.id}`, { weight, place: theme.place, taste: first?.taste ?? music!.input, ...(first ? { tasteTag: first.tasteTag } : {}) });
  }
  for (const t of tastes) {
    if (t.kind !== "food" || !t.cuisine) continue;
    const words = new RegExp(`\\b${norm(t.cuisine).replace(/ /g, "\\s")}\\b`);
    const extra = CUISINE_PLACE[t.cuisine];
    out.set(`food:${t.cuisine}`, { weight: 1.5, place: (p) => words.test(p) || !!extra?.test(p) || FOOD_PLACE.test(p), taste: t.input, food: true });
  }
  for (const t of tastes) {
    for (const tag of t.tags) {
      const n = norm(tag);
      if (!n || GENERIC.has(n) || HAS_DIGIT.test(n) || out.has(`tag:${n}`)) continue;
      out.set(`tag:${n}`, { weight: 1, place: (p) => p === n, taste: t.input, tasteTag: tag });
    }
  }
  return out;
}

/** One reason a place fits: a key, the place's tag name that answers it, and the taste behind it. */
export interface Link {
  key: string;
  placeTag: string;
  taste: string;
  tasteTag?: string;
  food?: boolean;
  /** What it adds to the fit: the key's weight times how rare it is in the list. */
  score: number;
}

/** The keys a place answers, each once, with the first of its tags that does. A place tag serves one key at most: a theme before a food before a shared name. */
function linksOf(e: InsightsEntity, profile: Profile, rules: Array<[string, Want]>): Array<Omit<Link, "score">> {
  const out: Array<Omit<Link, "score">> = [];
  const keys = new Set<string>();
  const seen = new Set<string>();
  for (const t of e.tags ?? []) {
    if (!t.name || ADMIN_TYPE.test(t.type ?? "")) continue;
    const n = norm(t.name);
    if (!n || GENERIC.has(n) || seen.has(n)) continue;
    seen.add(n);
    const hit = rules.find(([key, want]) => !keys.has(key) && (typeof want.place === "function" ? want.place(n) : want.place.test(n)));
    const key = hit?.[0] ?? `tag:${n}`;
    const want = hit?.[1] ?? profile.get(key);
    if (!want || keys.has(key)) continue;
    keys.add(key);
    out.push({ key, placeTag: t.name, taste: want.taste, ...(want.tasteTag ? { tasteTag: want.tasteTag } : {}), ...(want.food ? { food: true } : {}) });
  }
  return out;
}

export interface Fit {
  score: number;
  /** Strongest first. */
  links: Link[];
}

const NO_FIT: Fit = { score: 0, links: [] };

/**
 * The fit of every place in one Qloo list (keyed by entity_id). A key's rarity is
 * ln(n / places with it): a link on one place of 25 adds about 3.2 times its weight, one on
 * half of them about 0.7, one on all of them nothing.
 */
export function fitAll(list: InsightsEntity[], profile: Profile): Map<string, Fit> {
  const out = new Map<string, Fit>();
  if (!profile.size || !list.length) return out;
  const rules = [...profile].filter(([key]) => !key.startsWith("tag:"));
  const raw = list.map((e) => ({ e, links: linksOf(e, profile, rules) }));
  const df = new Map<string, number>();
  for (const r of raw) for (const l of r.links) df.set(l.key, (df.get(l.key) ?? 0) + 1);
  const n = list.length;
  for (const { e, links } of raw) {
    const scored = links
      .map((l) => ({ ...l, score: profile.get(l.key)!.weight * Math.log(n / df.get(l.key)!) }))
      .filter((l) => l.score > 0)
      .sort((a, b) => b.score - a.score);
    out.set(e.entity_id, { score: scored.reduce((s, l) => s + l.score, 0), links: scored });
  }
  return out;
}

export const fitOf = (fits: Map<string, Fit>, e: InsightsEntity): Fit => fits.get(e.entity_id) ?? NO_FIT;
