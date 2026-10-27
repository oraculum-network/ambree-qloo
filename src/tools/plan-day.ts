// plan_day: the whole agentic chain in one call. Tastes -> Qloo signals (resolve) -> one
// Qloo Insights call per kind of stop (things to do, restaurants, bars; see places.ts) ->
// a day of 3 or 4 stops: morning and afternoon are things to do, lunch a restaurant, the
// evening a bar or restaurant. A hotel is never a sight; for a meal it comes after every
// stand-alone place. No place is used twice.

import { z } from "zod";
import { PLACE_TYPE, type QlooReply } from "../qloo/client.ts";
import { type InsightsEntity, affinityOf } from "../qloo/contract.ts";
import { type ToolDeps, type ToolOutcome, modeOut, noticeOut, qlooCallsOut, qlooFailure, tastesInput } from "./context.ts";
import { FILTER_TAGS, isBar, isHotel, isMainlyBar, isRestaurant, isThingToDo } from "./places.ts";
import { type Signal, type Unresolved, resolveAll, signalOut, unresolvedOut } from "./resolve-tastes.ts";
import { type RankedPlace, type SignalNames, fetchInMU, toRanked } from "./rank-places.ts";
import { capitalise, joinNames, speak, spokenName } from "./speech.ts";

export const SLOTS = ["morning", "lunch", "afternoon", "evening"] as const;
export type Slot = (typeof SLOTS)[number];
const RELAXED: Slot[] = ["morning", "lunch", "evening"];
/** Results per Insights call (live returned 20 to 25 for each filter). */
export const PLAN_TAKE = 25;

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
  affinity: z.number().describe("Qloo's affinity score, 0 to 1 (0 when Qloo sent none)."),
  tags: z.array(z.string()),
  why: z.string().describe("Why Qloo suggests this stop for these tastes."),
  location_unverified: z.boolean().optional().describe("true when Qloo gave no country code for this place."),
});
export type Stop = z.infer<typeof stopOut>;

export const planDayOutput = z.object({
  mode: modeOut,
  notice: noticeOut,
  day: z.array(stopOut).describe("The stops in order."),
  signals: z.array(signalOut),
  unresolved: z.array(unresolvedOut),
  qloo_calls: qlooCallsOut,
  speech: z.string(),
});
export type PlanDayOutput = z.infer<typeof planDayOutput>;

type Pool = "things" | "restaurants" | "bars";

/** A place from one pool's Insights call. */
export interface Candidate {
  e: InsightsEntity;
  place: RankedPlace;
  pool: Pool;
  hotel: boolean;
}

const POOL_FILTER: Record<Pool, string> = { things: FILTER_TAGS.thingsToDo, restaurants: FILTER_TAGS.restaurant, bars: FILTER_TAGS.bar };
const POOL_KEEPS: Record<Pool, (e: InsightsEntity) => boolean> = {
  things: isThingToDo,
  restaurants: isRestaurant,
  bars: (e) => isBar(e) || isRestaurant(e),
};

/** One Insights call for a pool; places that don't fit it are dropped; best affinity first (Qloo's order on ties). */
async function fetchPool(reply: QlooReply, pool: Pool, signals: { entities: string[]; tags: string[] }, town: string | undefined, names: SignalNames): Promise<Candidate[]> {
  const { entities } = await fetchInMU(reply, { type: PLACE_TYPE, ...signals, filterTags: [POOL_FILTER[pool]], town, take: PLAN_TAKE });
  const signalTags = new Set(signals.tags);
  return entities
    .filter(POOL_KEEPS[pool])
    .map((e) => ({ e, place: toRanked(e, names, signalTags), pool, hotel: isHotel(e) }))
    .sort((a, b) => affinityOf(b.e) - affinityOf(a.e));
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

/** The candidates for a slot, best first. */
export function rankForSlot(slot: Slot, pools: Record<Pool, Candidate[]>): Candidate[] {
  const aff = (c: Candidate) => -affinityOf(c.e);
  if (slot === "morning" || slot === "afternoon") return pools.things;
  if (slot === "lunch") return [...pools.restaurants].sort(byKeys((c) => [c.hotel ? 1 : 0, isMainlyBar(c.e) ? 1 : 0, aff(c)]));
  const seen = new Set<string>();
  const both = [...pools.bars, ...pools.restaurants].filter((c) => !seen.has(c.place.id) && seen.add(c.place.id));
  return both.sort(byKeys((c) => [c.hotel ? 1 : 0, isBar(c.e) ? 0 : 1, aff(c)]));
}

/** Fill the slots in order from the pools, never using a place twice. A slot with no candidate is left out. */
export function fillSlots(slots: readonly Slot[], pools: Record<Pool, Candidate[]>): Array<{ slot: Slot; c: Candidate }> {
  const used = new Set<string>();
  const out: Array<{ slot: Slot; c: Candidate }> = [];
  for (const slot of slots) {
    const c = rankForSlot(slot, pools).find((x) => !used.has(x.place.id));
    if (!c) continue;
    used.add(c.place.id);
    out.push({ slot, c });
  }
  return out;
}

function kindOf(slot: Slot, c: Candidate): StopKind {
  if (slot === "morning" || slot === "afternoon") return "thing_to_do";
  return slot === "evening" && isBar(c.e) ? "bar" : "restaurant";
}

function whyFor(place: RankedPlace): string {
  const names = place.why.slice(0, 2).map(spokenName);
  return names.length ? `Because you like ${joinNames(names)}.` : "A strong Qloo match for your tastes.";
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
  try {
    ({ signals, unresolved } = await resolveAll(reply, args.tastes, deps.log));
    if (signals.length) {
      const names: SignalNames = new Map(signals.map((s) => [s.id, s.input]));
      const sig = {
        entities: signals.filter((s) => s.source === "entity").map((s) => s.id),
        tags: signals.filter((s) => s.source === "tag").map((s) => s.id),
      };
      const [things, restaurants, bars] = await Promise.all(
        (["things", "restaurants", "bars"] as const).map((pool) => fetchPool(reply, pool, sig, args.town, names)),
      );
      day = fillSlots(slots, { things: things!, restaurants: restaurants!, bars: bars! }).map(({ slot, c }) => ({
        slot,
        kind: kindOf(slot, c),
        place: c.place.name,
        place_id: c.place.id,
        ...(c.place.town ? { town: c.place.town } : {}),
        affinity: c.place.affinity,
        tags: c.place.tags,
        why: whyFor(c.place),
        ...(c.place.location_unverified ? { location_unverified: true } : {}),
      }));
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
    value: { mode: reply.mode, ...(reply.notice ? { notice: reply.notice } : {}), day, signals, unresolved, qloo_calls: reply.calls, speech },
  };
}
