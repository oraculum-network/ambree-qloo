// What every tool needs, injected so the logic stays testable, and the shared pieces:
// taste kinds, the outcome type and the spoken messages for Qloo failures.

import { z } from "zod";
import type { Logger } from "../log.ts";
import { type Qloo, QlooError } from "../qloo/client.ts";
import { capSpeech } from "./speech.ts";

export interface ToolDeps {
  qloo: Qloo;
  log: Logger;
  /** The caller's rate-limit key, for the per-client live Qloo budget (never logged). */
  client?: string;
}

export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export function fail<T>(message: string): ToolOutcome<T> {
  return { ok: false, message: capSpeech(message) };
}

export const TASTE_KINDS = ["music", "film", "tv", "book", "podcast", "game", "brand", "person", "food", "place"] as const;
export type TasteKind = (typeof TASTE_KINDS)[number];

/**
 * The /search type for each kind. Search spells video games "videogame" (Insights says
 * "video_game"); food goes to /v2/tags instead, as Qloo has no food entity type.
 */
export const SEARCH_TYPES: Record<Exclude<TasteKind, "food">, string> = {
  music: "urn:entity:artist",
  film: "urn:entity:movie",
  tv: "urn:entity:tv_show",
  book: "urn:entity:book",
  podcast: "urn:entity:podcast",
  game: "urn:entity:videogame",
  brand: "urn:entity:brand",
  person: "urn:entity:person",
  place: "urn:entity:place",
};

export const taste = z.object({
  kind: z.enum(TASTE_KINDS).describe("What kind of taste: music (an artist), film, tv, book, podcast, game, brand, person, food (a cuisine or dish), or place."),
  name: z.string().trim().min(1).max(60).describe("The name as the traveller said it, e.g. 'Kaya', 'Amélie', 'street food'."),
});
export const tastesInput = z.array(taste).min(1).max(6).describe("1 to 6 things the traveller likes.");
export type Taste = z.infer<typeof taste>;

export const modeOut = z.enum(["live", "demo"]).describe("live: Qloo's API. demo: synthetic fixtures, not Qloo data.");
export const noticeOut = z.literal("live_unavailable").optional().describe("Set when live Qloo access failed and this reply fell back to demo data.");
export const qlooCallsOut = z.array(z.object({ endpoint: z.string(), ms: z.int(), cached: z.boolean() })).describe("The Qloo calls behind this reply.");

/** Search or tags found nothing: 404 "No results", or a 400 when a name matches nothing. */
export function isNoMatch(e: unknown): boolean {
  return e instanceof QlooError && e.kind === "http" && (e.status === 404 || e.status === 400);
}

/** The spoken message for a Qloo failure that ends the tool call. */
export function qlooFailure<T>(e: unknown, log: Logger): ToolOutcome<T> {
  if (!(e instanceof QlooError)) throw e;
  log({ level: "warn", event: "qloo_error", kind: e.kind, status: e.status });
  if (e.kind === "http" && e.status === 429) return fail("Qloo is busy right now, so I can't do that. Please try again in a minute.");
  if (e.kind === "bad_response") return fail("Qloo sent an answer I couldn't read, so I can't do that right now.");
  return fail("I couldn't reach Qloo just now. Please try again in a moment.");
}
