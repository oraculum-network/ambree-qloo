// plan_day: the whole agentic chain in one call. Tastes -> Qloo signals (resolve) -> one
// Qloo Insights call for places in Mauritius -> a day of 3 or 4 stops, each slot filled by
// the highest-affinity place whose tags suit it, with no repeats.

import { z } from "zod";
import { PLACE_TYPE } from "../qloo/client.ts";
import { type ToolDeps, type ToolOutcome, modeOut, noticeOut, qlooCallsOut, qlooFailure, tastesInput } from "./context.ts";
import { type Signal, type Unresolved, resolveAll, signalOut, unresolvedOut } from "./resolve-tastes.ts";
import { type RankedPlace, type SignalNames, rankIn } from "./rank-places.ts";
import { capitalise, joinNames, speak, spokenName } from "./speech.ts";

export const SLOTS = ["morning", "lunch", "afternoon", "evening"] as const;
export type Slot = (typeof SLOTS)[number];
const RELAXED: Slot[] = ["morning", "lunch", "evening"];
export const PLAN_TAKE = 30;

// LUNCH matches inside words on purpose ("Seafood", "Street food", "Cafeteria"). EVENING's
// "bar" is a whole word, so "Barbecue" and "Barachois" are not evening venues.
const LUNCH = /restaurant|cafe|café|food/i;
const EVENING = /\bbars?\b|restaurant|music/i;

export const planDayInput = z.object({
  tastes: tastesInput,
  pace: z.enum(["relaxed", "full"]).default("full").describe("relaxed: 3 stops (morning, lunch, evening). full: 4 stops."),
  town: z.string().trim().min(1).max(40).optional().describe("Keep the day in one town, e.g. 'Flic en Flac'."),
});
export type PlanDayInput = z.infer<typeof planDayInput>;

export const stopOut = z.object({
  slot: z.enum(SLOTS),
  place: z.string(),
  place_id: z.string(),
  town: z.string().optional(),
  affinity: z.number().describe("Qloo's affinity score, 0 to 1 (0 when Qloo sent none)."),
  tags: z.array(z.string()),
  why: z.string().describe("Which of the traveller's tastes led here."),
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

function fits(slot: Slot, p: RankedPlace): boolean {
  const text = p.tags.join(" ");
  if (slot === "lunch") return LUNCH.test(text);
  if (slot === "evening") return EVENING.test(text);
  return !LUNCH.test(text) && !EVENING.test(text);
}

const tie = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);

/** Fill each slot in order: best fitting place, ties to the previous stop's town; else the next best. */
export function assignSlots(places: RankedPlace[], slots: readonly Slot[]): Array<{ slot: Slot; place: RankedPlace }> {
  const left = [...places].sort((a, b) => b.affinity - a.affinity);
  const out: Array<{ slot: Slot; place: RankedPlace }> = [];
  for (const slot of slots) {
    if (!left.length) break;
    const prevTown = out[out.length - 1]?.place.town;
    const pool = left.filter((p) => fits(slot, p));
    const from = pool.length ? pool : left;
    let pick = from[0]!;
    if (prevTown && pick.town !== prevTown) {
      const near = from.find((p) => p.town === prevTown && tie(p.affinity, pick.affinity));
      if (near) pick = near;
    }
    left.splice(left.indexOf(pick), 1);
    out.push({ slot, place: pick });
  }
  return out;
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
  let signals: Signal[];
  let unresolved: Unresolved[];
  let day: Stop[] = [];
  try {
    ({ signals, unresolved } = await resolveAll(reply, args.tastes, deps.log));
    if (signals.length) {
      const names: SignalNames = new Map(signals.map((s) => [s.id, s.input]));
      const ranked = await rankIn(
        reply,
        {
          type: PLACE_TYPE,
          entities: signals.filter((s) => s.source === "entity").map((s) => s.id),
          tags: signals.filter((s) => s.source === "tag").map((s) => s.id),
          town: args.town,
          take: PLAN_TAKE,
        },
        names,
      );
      day = assignSlots(ranked.places, args.pace === "relaxed" ? RELAXED : SLOTS).map(({ slot, place }) => ({
        slot,
        place: place.name,
        place_id: place.id,
        ...(place.town ? { town: place.town } : {}),
        affinity: place.affinity,
        tags: place.tags,
        why: whyFor(place),
        ...(place.location_unverified ? { location_unverified: true } : {}),
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
