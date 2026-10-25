// rank_places: Qloo Insights ranks places (or destinations) in Mauritius for taste signals.
// Results outside Mauritius are dropped: Qloo silently ignores a parameter it doesn't
// apply, so the country filter is checked again here.

import { z } from "zod";
import { type CountryFilter, DESTINATION_TYPE, type InsightsParams, PLACE_TYPE, QlooError, type QlooReply } from "../qloo/client.ts";
import { type InsightsEntity, affinityOf, explainedBy, townOf } from "../qloo/contract.ts";
import { type ToolDeps, type ToolOutcome, fail, modeOut, noticeOut, qlooCallsOut, qlooFailure } from "./context.ts";
import { joinNames, speak, spokenName } from "./speech.ts";

/** Mauritius's country code in Qloo's results. The guard compares against it, whichever filter is sent. */
export const COUNTRY_CODE = "MU";

/** The two ways to ask Qloo Insights for Mauritius. */
export const MU_BY_COUNTRY: CountryFilter = { countryCode: COUNTRY_CODE };
export const MU_BY_LOCATION: CountryFilter = { locationQuery: "Mauritius" };

/**
 * The filter in use (smoke sends the same one). If `npm run smoke` prints "FAIL MU check",
 * Qloo ignored it: set this to MU_BY_LOCATION, run npm test, then rerun smoke.
 */
export const MU_FILTER: CountryFilter = MU_BY_COUNTRY;
const PLACE = "urn:entity:place";

export const rankPlacesInput = z.object({
  entity_ids: z.array(z.string().min(1).max(64)).max(10).optional().describe("Qloo entity IDs from resolve_tastes (signals)."),
  tag_ids: z.array(z.string().min(1).max(120)).max(10).optional().describe("Qloo tag IDs from resolve_tastes (signals)."),
  vibe: z.string().trim().min(1).max(40).optional().describe("A word or two for the kind of place, e.g. 'beach' or 'live music'. Matched to a Qloo tag and used as a filter."),
  kind: z.enum(["place", "destination"]).default("place").describe("place: venues and sights. destination: areas of the island (needs entity_ids)."),
  town: z.string().trim().min(1).max(40).optional().describe("Only places in this town, e.g. 'Grand Baie'."),
  take: z.int().min(1).max(10).default(5).describe("How many to return (1 to 10)."),
});
export type RankPlacesInput = z.infer<typeof rankPlacesInput>;

export const rankedPlaceOut = z.object({
  id: z.string(),
  name: z.string(),
  town: z.string().optional(),
  affinity: z.number().describe("Qloo's affinity score, 0 to 1."),
  tags: z.array(z.string()).describe("Qloo tag names on the place."),
  why: z.array(z.string()).describe("The tastes that contributed most, strongest first."),
  location_unverified: z.boolean().optional().describe("true when Qloo gave no country code for this result."),
});
export type RankedPlace = z.infer<typeof rankedPlaceOut>;

export const rankPlacesOutput = z.object({
  mode: modeOut,
  notice: noticeOut,
  kind: z.enum(["place", "destination"]),
  places: z.array(rankedPlaceOut),
  dropped_non_mu: z.int().describe("Results Qloo returned from outside Mauritius, dropped."),
  qloo_calls: qlooCallsOut,
  speech: z.string(),
});
export type RankPlacesOutput = z.infer<typeof rankPlacesOutput>;

/** Names for signal IDs, so `why` can say which taste a result came from. */
export type SignalNames = Map<string, string>;

export interface Ranked {
  places: RankedPlace[];
  dropped_non_mu: number;
}

function toRanked(e: InsightsEntity, names: SignalNames, signalTags: Set<string>): RankedPlace {
  const why: string[] = [];
  for (const x of explainedBy(e)) {
    const n = names.get(x.id);
    if (n && !why.includes(n)) why.push(n);
  }
  for (const t of e.tags ?? []) {
    const id = t.id ?? t.tag_id;
    const n = id && signalTags.has(id) ? names.get(id) : undefined;
    if (n && !why.includes(n)) why.push(n);
  }
  const town = townOf(e);
  return {
    id: e.entity_id,
    name: e.name,
    ...(town ? { town } : {}),
    affinity: Math.round(affinityOf(e) * 1000) / 1000,
    tags: (e.tags ?? []).map((t) => t.name).slice(0, 6),
    why,
    ...(e.properties?.geocode?.country_code ? {} : { location_unverified: true }),
  };
}

/** One insights call in Mauritius, the MU guard, then results by affinity. */
export async function rankIn(reply: QlooReply, params: Omit<InsightsParams, keyof CountryFilter>, names: SignalNames): Promise<Ranked> {
  let entities: InsightsEntity[];
  try {
    ({ entities } = (await reply.insights({ ...params, ...MU_FILTER })).results);
  } catch (e) {
    // "At least one valid signal or filter is required": nothing to rank, not a failure.
    if (e instanceof QlooError && e.kind === "http" && e.status === 400 && /signal/i.test(e.message)) entities = [];
    else throw e;
  }
  let dropped = 0;
  const kept = entities.filter((e) => {
    const cc = e.properties?.geocode?.country_code;
    if (cc && cc.toUpperCase() !== COUNTRY_CODE) {
      dropped++;
      return false;
    }
    return true;
  });
  const signalTags = new Set(params.tags ?? []);
  const places = kept.map((e) => toRanked(e, names, signalTags)).sort((a, b) => b.affinity - a.affinity);
  return { places, dropped_non_mu: dropped };
}

export async function rankPlaces(args: RankPlacesInput, deps: ToolDeps): Promise<ToolOutcome<RankPlacesOutput>> {
  const entities = args.entity_ids ?? [];
  const tags = args.tag_ids ?? [];
  if (!entities.length && !tags.length && !args.vibe) {
    return fail("Give me at least one taste signal: entity_ids or tag_ids from resolve_tastes, or a vibe.");
  }
  if (args.kind === "destination" && !entities.length) {
    return fail("Ranking destinations needs entity_ids from resolve_tastes, such as an artist or a film.");
  }
  const reply = deps.qloo.reply(deps.client);
  const names: SignalNames = new Map();
  try {
    let filterTags: string[] = [];
    if (args.vibe) {
      const { results } = await reply.tags(args.vibe, 5).catch((e: unknown) => {
        if (e instanceof QlooError && e.kind === "http" && (e.status === 404 || e.status === 400)) return { results: { tags: [] } };
        throw e;
      });
      const tag = results.tags.find((x) => !x.parents || x.parents.some((p) => p.type === PLACE));
      if (!tag) return fail(`Qloo has no place tag for '${args.vibe.replace(/['"`]/g, "")}'. Try a simpler word, like beach or live music.`);
      filterTags = [tag.id];
      names.set(tag.id, tag.name);
    }
    // A vibe alone is the only signal too.
    const signalTags = tags.length || entities.length ? tags : filterTags;
    const ranked = await rankIn(
      reply,
      {
        type: args.kind === "destination" ? DESTINATION_TYPE : PLACE_TYPE,
        entities,
        tags: signalTags,
        filterTags,
        town: args.town,
        take: Math.min(50, args.take * 3),
      },
      names,
    );
    const places = ranked.places.slice(0, args.take);
    const what = args.kind === "destination" ? "destinations" : "places";
    const top = places.slice(0, 3);
    // "in Mauritius" only when Qloo gave each spoken place a country code.
    const where = top.some((p) => p.location_unverified) ? "" : " in Mauritius";
    const speech = !places.length
      ? speak(reply.mode, reply.notice, `Qloo found no ${what} in Mauritius for those tastes${args.town ? ` in ${spokenName(args.town)}` : ""}.`, `Qloo found no ${what} in Mauritius for those tastes.`)
      : speak(
          reply.mode,
          reply.notice,
          `Qloo's top ${what}${where} for you are ${joinNames(top.map((p) => (p.town ? `${spokenName(p.name)} in ${spokenName(p.town)}` : spokenName(p.name))))}.`,
          `Qloo's top ${what}${where} for you are ${joinNames(top.map((p) => spokenName(p.name)))}.`,
          `Qloo's top pick${where} for you is ${spokenName(top[0]!.name)}.`,
        );
    return {
      ok: true,
      value: {
        mode: reply.mode,
        ...(reply.notice ? { notice: reply.notice } : {}),
        kind: args.kind,
        places,
        dropped_non_mu: ranked.dropped_non_mu,
        qloo_calls: reply.calls,
        speech,
      },
    };
  } catch (e) {
    return qlooFailure(e, deps.log);
  }
}
