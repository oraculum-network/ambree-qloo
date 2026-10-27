// plan_day: the whole agentic chain in one call. Tastes -> Qloo signals (resolve) -> one
// Qloo Insights call per kind of stop (things to do, restaurants, bars; see places.ts) ->
// a day of 3 or 4 stops: morning and afternoon are things to do, lunch a restaurant, the
// evening a bar or restaurant. A hotel is never a sight; for a meal it comes after every
// stand-alone place. No place is used twice. The things to do are the ones whose Qloo tags
// best echo the tastes' own Qloo tags (fit.ts), Qloo's order breaking ties. The first stop
// is the best of them on the island; every later call asks Qloo for places within
// REGION_KM of it (filter.location), widened once to WIDE_KM when a slot would be empty.

import { z } from "zod";
import { PLACE_TYPE, type QlooReply } from "../qloo/client.ts";
import { distanceKm } from "../geo.ts";
import { type InsightsEntity, affinityOf, explainedBy, pointOf } from "../qloo/contract.ts";
import { type ToolDeps, type ToolOutcome, modeOut, noticeOut, qlooCallsOut, qlooFailure, tastesInput } from "./context.ts";
import { type Fit, type Link, type Profile, fitAll, fitOf, profileOf } from "./fit.ts";
import { FILTER_TAGS, cuisineOf, cuisineTag, isBar, isHotel, isMainlyBar, isRestaurant, isThingToDo, liveMusicTag, primaryGenre, tellingTags } from "./places.ts";
import { type Signal, type Unresolved, resolveAll, signalOut, unresolvedOut } from "./resolve-tastes.ts";
import { type RankedPlace, type SignalNames, fetchInMU, toRanked } from "./rank-places.ts";
import { capitalise, joinNames, speak, spokenName } from "./speech.ts";

export const SLOTS = ["morning", "lunch", "afternoon", "evening"] as const;
export type Slot = (typeof SLOTS)[number];
const RELAXED: Slot[] = ["morning", "lunch", "evening"];
/** Results per Insights call (live returned 20 to 25 for each filter). */
export const PLAN_TAKE = 25;
/** After the first stop the day stays within this many km of it; once widened to WIDE_KM if a slot is empty. */
export const REGION_KM = 15;
export const WIDE_KM = 25;
/**
 * Qloo calls one plan may make, cached ones included: one per taste (6 at most) and 3
 * Insights calls always fit; the afternoon's radius call and the widening calls only
 * while there is room. The per-client and daily caps (src/qloo/client.ts) still apply.
 */
export const PLAN_CALL_BUDGET = 10;

export const STOP_KINDS = ["thing_to_do", "restaurant", "bar"] as const;
export type StopKind = (typeof STOP_KINDS)[number];

export const planDayInput = z.object({
  tastes: tastesInput,
  pace: z.enum(["relaxed", "full"]).default("full").describe("relaxed: 3 stops (morning, lunch, evening). full: 4 stops."),
  town: z.string().trim().min(1).max(40).optional().describe("Keep the day in one town, e.g. 'Flic en Flac'."),
});
export type PlanDayInput = z.infer<typeof planDayInput>;

export const stopOut = z.object({
  slot: z.enum(SLOTS),
  kind: z.enum(STOP_KINDS).describe("thing_to_do (a sight, beach, walk...), restaurant or bar."),
  place: z.string(),
  place_id: z.string(),
  town: z.string().optional(),
  km_from_start: z.number().optional().describe("Straight-line kilometres from the day's first stop."),
  affinity: z.number().describe("Qloo's affinity score, 0 to 1 (0 when Qloo sent none)."),
  tags: z.array(z.string()).describe("Up to 4 Qloo tag names that best say what the place is; a tag matching a taste first."),
  why: z.string().describe("Why Qloo suggests this stop for these tastes."),
  location_unverified: z.boolean().optional().describe("true when Qloo gave no country code for this place."),
});
export type Stop = z.infer<typeof stopOut>;

export const areaOut = z.object({ around: z.string(), radius_km: z.number() });
export type Area = z.infer<typeof areaOut>;

export const planDayOutput = z.object({
  mode: modeOut,
  notice: noticeOut,
  day: z.array(stopOut).describe("The stops in order."),
  area: areaOut.optional().describe("The region the day keeps to: around the first stop, within radius_km. Unset when a town was given."),
  signals: z.array(signalOut),
  unresolved: z.array(unresolvedOut),
  qloo_calls: qlooCallsOut,
  speech: z.string(),
});
export type PlanDayOutput = z.infer<typeof planDayOutput>;

/** things: the island (or the town), for the first stop; nearThings: around it, for the afternoon. */
type Pool = "things" | "nearThings" | "restaurants" | "bars";

/** A place from one pool's Insights call. */
export interface Candidate {
  e: InsightsEntity;
  place: RankedPlace;
  pool: Pool;
  hotel: boolean;
  /** Its place in that call's list (by Qloo affinity, after the kind and radius checks), of `of`, `scope`. */
  rank: number;
  of: number;
  scope: string;
  /** How well its tags echo the tastes' tags, within that list (fit.ts). */
  fit: Fit;
}

const POOL_FILTER: Record<Pool, string> = { things: FILTER_TAGS.thingsToDo, nearThings: FILTER_TAGS.thingsToDo, restaurants: FILTER_TAGS.restaurant, bars: FILTER_TAGS.bar };
const POOL_KEEPS: Record<Pool, (e: InsightsEntity) => boolean> = {
  things: isThingToDo,
  nearThings: isThingToDo,
  restaurants: isRestaurant,
  bars: (e) => isBar(e) || isRestaurant(e),
};

type Near = { lat: number; lon: number; radiusM: number };
/** Where an Insights call looks: a town, or a radius around the day's first stop. */
interface Where {
  town?: string;
  near?: Near;
}

/** Inside the radius, or no radius; a place with no coordinates can't be checked and is kept. */
function within(e: InsightsEntity, near: Near | undefined): boolean {
  const at = near && pointOf(e);
  return !near || !at || distanceKm(near, at) * 1000 <= near.radiusM;
}

/** One Insights call for a pool; places that don't fit it are dropped; best affinity first (Qloo's order on ties). */
async function fetchPool(reply: QlooReply, pool: Pool, signals: { entities: string[]; tags: string[] }, where: Where, names: SignalNames, profile: Profile): Promise<Candidate[]> {
  const { entities } = await fetchInMU(reply, { type: PLACE_TYPE, ...signals, filterTags: [POOL_FILTER[pool]], ...where, take: PLAN_TAKE });
  const signalTags = new Set(signals.tags);
  const list = entities
    .filter(POOL_KEEPS[pool])
    // Qloo may ignore a filter it doesn't apply, so the radius is checked here too.
    .filter((e) => within(e, where.near))
    .sort((a, b) => affinityOf(b) - affinityOf(a));
  const scope = where.near ? `within ${Math.round(where.near.radiusM / 1000)} km` : where.town ? `in ${spokenName(where.town)}` : "in Mauritius";
  // Only things to do are chosen by fit; the meals have their own rules.
  const fits = pool === "things" || pool === "nearThings" ? fitAll(list, profile) : new Map<string, Fit>();
  return list.map((e, i) => ({ e, place: toRanked(e, names, signalTags), pool, hotel: isHotel(e), rank: i + 1, of: list.length, scope, fit: fitOf(fits, e) }));
}

/**
 * Qloo's order counts as up to QLOO_ORDER_WEIGHT on top of the fit: its first place gets
 * all of it, its last almost none. One rare tag link (about 2 to 3) outweighs the whole
 * order; with no links at all, Qloo's order decides.
 */
export const QLOO_ORDER_WEIGHT = 1;
/** Ties toward variety: an afternoon of the morning's primary genre (two beaches) loses this much. */
export const SAME_GENRE_COST = 0.5;

/** A thing to do's score; after a morning, the links it already showed count half and its genre costs SAME_GENRE_COST. */
export function sightScore(c: Candidate, after?: Candidate): number {
  const order = QLOO_ORDER_WEIGHT * ((c.of - c.rank + 1) / c.of);
  if (!after) return c.fit.score + order;
  const shown = new Set(after.fit.links.map((l) => l.key));
  const fit = c.fit.links.reduce((s, l) => s + (shown.has(l.key) ? l.score / 2 : l.score), 0);
  const g = primaryGenre(c.e);
  return fit + order - (g && g === primaryGenre(after.e) ? SAME_GENRE_COST : 0);
}

/** Best first; Qloo's order on equal scores. */
export function bySightScore(list: Candidate[], after?: Candidate): Candidate[] {
  return [...list].sort((a, b) => sightScore(b, after) - sightScore(a, after) || a.rank - b.rank);
}

/** Lexicographic: the first lower key wins. */
function byKeys<T>(key: (x: T) => number[]) {
  return (a: T, b: T) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return 0;
  };
}

/** What the traveller asked for that shapes the meals and the evening. */
export interface Prefs {
  /** Food tastes, each with the cuisine its Qloo tag names. */
  foods: Array<{ input: string; cuisine: string }>;
  /** A music taste: the evening prefers a place tagged for live music. */
  music: boolean;
}

/** The tag that ties a stop to one of the tastes: a cuisine at a meal, live music at night. */
export interface Match {
  tag: string;
  /** The food taste it matches; unset for live music. */
  food?: string;
}

export interface Pick {
  slot: Slot;
  c: Candidate;
  match?: Match;
  /** A food taste no place in the pool served (the meal fell back to the best restaurant). */
  missed?: string;
  /** A thing to do's strongest tag links to the tastes (at most 2). */
  links?: Link[];
}

/** How many tag links a why names. */
const WHY_LINKS = 2;

function cuisineMatch(c: Candidate, prefs: Prefs): Match | undefined {
  for (const f of prefs.foods) {
    const t = cuisineTag(c.e, f.cuisine);
    if (t) return { tag: t.name, food: f.input };
  }
  return undefined;
}

function musicMatch(c: Candidate): Match | undefined {
  const t = liveMusicTag(c.e);
  return t && { tag: t.name };
}

/** Evening: live music for a music taste; else dinner in the food taste's cuisine; else a bar. */
function eveningMatch(c: Candidate, prefs: Prefs): Match | undefined {
  if (prefs.music) return musicMatch(c);
  return prefs.foods.length ? cuisineMatch(c, prefs) : undefined;
}

/** The candidates for a slot, best first. Stand-alone places always come before hotels. The afternoon leans away from the morning. */
export function rankForSlot(slot: Slot, pools: Record<Pool, Candidate[]>, prefs: Prefs, morning?: Candidate): Candidate[] {
  const aff = (c: Candidate) => -affinityOf(c.e);
  if (slot === "morning") return bySightScore(pools.things);
  if (slot === "afternoon") return bySightScore(pools.nearThings, morning);
  if (slot === "lunch") {
    return [...pools.restaurants].sort(byKeys((c) => [c.hotel ? 1 : 0, cuisineMatch(c, prefs) ? 0 : 1, isMainlyBar(c.e) ? 1 : 0, aff(c)]));
  }
  const seen = new Set<string>();
  const both = [...pools.bars, ...pools.restaurants].filter((c) => !seen.has(c.place.id) && seen.add(c.place.id));
  // With no music taste the evening is dinner, so a bar has no head start over a restaurant.
  const barFirst = prefs.music || !prefs.foods.length;
  return both.sort(byKeys((c) => [c.hotel ? 1 : 0, eveningMatch(c, prefs) ? 0 : 1, barFirst && !isBar(c.e) ? 1 : 0, aff(c)]));
}

/** Fill the slots in order from the pools, never using a place twice. A slot with no candidate is left out. */
export function fillSlots(slots: readonly Slot[], pools: Record<Pool, Candidate[]>, prefs: Prefs): Pick[] {
  const used = new Set<string>();
  const out: Pick[] = [];
  for (const slot of slots) {
    const morning = out.find((p) => p.slot === "morning")?.c;
    const c = rankForSlot(slot, pools, prefs, morning).find((x) => !used.has(x.place.id));
    if (!c) continue;
    used.add(c.place.id);
    const pick: Pick = { slot, c };
    if (c.fit.links.length) pick.links = c.fit.links.slice(0, WHY_LINKS);
    if (slot === "lunch") {
      const m = cuisineMatch(c, prefs);
      if (m) pick.match = m;
      else if (prefs.foods.length) pick.missed = prefs.foods[0]!.input;
    }
    if (slot === "evening") {
      const m = eveningMatch(c, prefs);
      if (m) pick.match = m;
    }
    out.push(pick);
  }
  return out;
}

function kindOf(slot: Slot, c: Candidate): StopKind {
  if (slot === "morning" || slot === "afternoon") return "thing_to_do";
  return slot === "evening" && isBar(c.e) ? "bar" : "restaurant";
}

const NOUN: Record<Pool, [one: string, many: string]> = {
  things: ["thing to do", "things to do"],
  nearThings: ["thing to do", "things to do"],
  restaurants: ["restaurant", "restaurants"],
  bars: ["bar", "bars"],
};

/** A food word that already names a place ("No cafe came up", not "No cafe place came up"). */
const PLACE_WORD = /\b(cafe|café|coffee shop|bar|pub|bakery|bistro|diner|restaurant|brasserie|tea ?room)s?$/i;

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/**
 * Why Qloo suggests a stop, from what it returned for that place: whose fans tend to like
 * it (the taste Qloo's explainability credits most, else all the tastes), its rank in the
 * list it came from, and the tag that ties it to a food or music taste. Qloo describes what
 * groups of people tend to like, so it never says what this traveller will enjoy.
 */
/** One tag link, said: "Snorkeling (Life of Pi: Swimming underwater)", "Romantic (also on Norwegian Wood)", "Market stalls (your street food)". */
function linkSaid(l: Link): string {
  const taste = spokenName(l.taste);
  if (l.food) return `${l.placeTag} (your ${taste})`;
  if (!l.tasteTag) return `${l.placeTag} (${taste})`;
  return l.tasteTag.toLowerCase() === l.placeTag.toLowerCase() ? `${l.placeTag} (also on ${taste})` : `${l.placeTag} (${taste}: ${l.tasteTag})`;
}

export function whyFor({ c, match, missed, links }: Pick, names: SignalNames, tastes: string[]): string {
  const credited = explainedBy(c.e).flatMap((x) => names.get(x.id) ?? []);
  const fans = (credited.length ? credited.slice(0, 1) : tastes.slice(0, 3)).map(spokenName);
  const [one, many] = NOUN[c.pool];
  const ranked = c.of === 1 ? `it is the only ${one} Qloo returned ${c.scope}` : `Qloo ranks it ${ordinal(c.rank)} of ${c.of} ${many} ${c.scope}`;
  let why = fans.length ? `Fans of ${joinNames(fans)} tend to like it: ${ranked}.` : `${capitalise(ranked)}.`;
  if (links?.length) why += ` Its Qloo tags echo your tastes: ${links.map(linkSaid).join("; ")}.`;
  if (match) why += match.food ? ` Tagged ${match.tag}, matching your ${match.food}.` : ` Tagged ${match.tag}.`;
  if (missed) why += ` No ${missed}${PLACE_WORD.test(missed) ? "" : " place"} came up nearby, so this is Qloo's top restaurant here.`;
  if (c.hotel) why += ` It's a hotel's ${c.pool === "bars" ? "bar" : "restaurant"}: no stand-alone place was left nearby.`;
  return why;
}

const SLOT_SPOKEN: Record<Slot, (name: string) => string> = {
  morning: (n) => `start at ${n}`,
  lunch: (n) => `have lunch at ${n}`,
  afternoon: (n) => `spend the afternoon at ${n}`,
  evening: (n) => `end the evening at ${n}`,
};

export async function planDay(args: PlanDayInput, deps: ToolDeps): Promise<ToolOutcome<PlanDayOutput>> {
  const reply = deps.qloo.reply(deps.client);
  const slots = args.pace === "relaxed" ? RELAXED : SLOTS;
  let signals: Signal[];
  let unresolved: Unresolved[];
  let day: Stop[] = [];
  let area: Area | undefined;
  try {
    let tagsOf: Map<string, string[]>;
    ({ signals, unresolved, tagsOf } = await resolveAll(reply, args.tastes, deps.log));
    if (signals.length) {
      const names: SignalNames = new Map(signals.map((s) => [s.id, s.input]));
      const entities = signals.filter((s) => s.source === "entity").map((s) => s.id);
      // Whose fans a why names when Qloo credits no single taste: the artists, films and books, else the foods.
      const fanOf = (entities.length ? signals.filter((s) => s.source === "entity") : signals).map((s) => s.input);
      const tags = signals.filter((s) => s.source === "tag").map((s) => s.id);
      const prefs: Prefs = {
        foods: signals.filter((s) => s.kind === "food").map((s) => ({ input: s.input, cuisine: cuisineOf(s.id) })),
        music: signals.some((s) => s.kind === "music"),
      };
      // The food tags steer the meal calls only; sights follow the other tastes when there are any.
      const mealSig = { entities, tags };
      const thingsSig = entities.length ? { entities, tags: [] } : mealSig;
      // What the things to do are scored against: each taste's Qloo tags, its kind and a food's cuisine.
      const profile = profileOf(signals.map((s) => ({ input: s.input, kind: s.kind, tags: tagsOf.get(s.id) ?? [], ...(s.kind === "food" ? { cuisine: cuisineOf(s.id) } : {}) })));
      const fetch = (pool: Pool, sig: typeof mealSig, where: Where) => fetchPool(reply, pool, sig, where, names, profile);

      // The thing to do on the island (or in the town) that best fits the tastes starts the day and sets the region.
      const things = bySightScore(await fetch("things", thingsSig, { town: args.town }));
      const first = things[0];
      const center = !args.town && first ? pointOf(first.e) : undefined;
      let km = REGION_KM;
      const where = (): Where => (center ? { near: { ...center, radiusM: km * 1000 } } : { town: args.town });
      const pools: Record<Pool, Candidate[]> = { things, nearThings: things, restaurants: [], bars: [] };
      // Load pools in the order given, within the plan's call budget (later pools are skipped).
      const load = async (which: Pool[]) => {
        const calls: Pool[] = [];
        for (const pool of which) {
          if (pool === "nearThings") {
            // The island list often has a second sight nearby (no call); else ask Qloo around the first stop.
            const near = where().near;
            pools.nearThings = things.filter((c) => c !== first && within(c.e, near));
            if (pools.nearThings.length || !near) continue;
          }
          calls.push(pool);
        }
        const room = Math.max(0, PLAN_CALL_BUDGET - reply.calls.length);
        await Promise.all(
          calls.slice(0, room).map(async (pool) => {
            pools[pool] = await fetch(pool, pool === "nearThings" ? thingsSig : mealSig, where());
          }),
        );
      };
      await load(["restaurants", "bars", ...(slots.includes("afternoon") && center ? (["nearThings"] as const) : [])]);
      let picks = fillSlots(slots, pools, prefs);
      // Too few places nearby: widen once, for the slots left empty.
      const empty = slots.filter((s) => s !== "morning" && !picks.some((p) => p.slot === s));
      if (center && empty.length) {
        km = WIDE_KM;
        // Lunch first: if the budget allows only some calls, the meal matters most.
        await load([...new Set(empty.flatMap((s): Pool[] => (s === "lunch" ? ["restaurants"] : s === "afternoon" ? ["nearThings"] : ["restaurants", "bars"])))]);
        picks = fillSlots(slots, pools, prefs);
      }
      if (center && first) area = { around: first.place.town ?? first.place.name, radius_km: km };

      day = picks.map((pick) => {
        const { slot, c } = pick;
        const at = pointOf(c.e);
        return {
          slot,
          kind: kindOf(slot, c),
          place: c.place.name,
          place_id: c.place.id,
          ...(c.place.town ? { town: c.place.town } : {}),
          ...(center && at && c !== first ? { km_from_start: Math.round(distanceKm(center, at) * 10) / 10 } : {}),
          affinity: c.place.affinity,
          tags: tellingTags(c.e, pick.match ? [pick.match.tag] : (pick.links ?? []).map((l) => l.placeTag)),
          why: whyFor(pick, names, fanOf),
          ...(c.place.location_unverified ? { location_unverified: true } : {}),
        };
      });
    }
  } catch (e) {
    return qlooFailure(e, deps.log);
  }

  const missed = unresolved.map((u) => spokenName(u.input));
  const missedLine = missed.length ? ` I couldn't match ${joinNames(missed, "or")}.` : "";
  let speech: string;
  if (!signals.length) {
    speech = speak(reply.mode, reply.notice, "Qloo had no match for any of those tastes, so I can't plan a day yet. Try naming an artist, a film or a dish another way.", "Qloo had no match for those tastes, so I can't plan a day yet.");
  } else if (!day.length) {
    speech = speak(reply.mode, reply.notice, `Qloo found no places in Mauritius for those tastes${args.town ? ` in ${spokenName(args.town)}` : ""}.`, "Qloo found no places in Mauritius for those tastes.");
  } else {
    const withTown = day.map((s, i) => SLOT_SPOKEN[s.slot](s.town && s.town !== day[i - 1]?.town ? `${spokenName(s.place)} in ${spokenName(s.town)}` : spokenName(s.place)));
    const plain = day.map((s) => SLOT_SPOKEN[s.slot](spokenName(s.place)));
    const first = spokenName(day[0]!.place);
    const last = spokenName(day[day.length - 1]!.place);
    speech = speak(
      reply.mode,
      reply.notice,
      `${capitalise(joinNames(withTown))}.${missedLine}`,
      `${capitalise(joinNames(withTown))}.`,
      `${capitalise(joinNames(plain))}.`,
      `Your day has ${day.length} stops, from ${first} to ${last}.`,
      `Your day has ${day.length} stops.`,
    );
  }
  return {
    ok: true,
    value: { mode: reply.mode, ...(reply.notice ? { notice: reply.notice } : {}), day, ...(area ? { area } : {}), signals, unresolved, qloo_calls: reply.calls, speech },
  };
}
