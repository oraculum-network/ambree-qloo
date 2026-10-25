// resolve_tastes: a traveller's tastes as Qloo signals. Music, film, books and the rest go
// to /search (one best match each); food goes to /v2/tags (a place tag). A taste Qloo
// can't match is listed in `unresolved`, never guessed.

import { z } from "zod";
import type { QlooReply } from "../qloo/client.ts";
import {
  SEARCH_TYPES,
  type Taste,
  type ToolDeps,
  type ToolOutcome,
  isNoMatch,
  modeOut,
  noticeOut,
  qlooCallsOut,
  qlooFailure,
  tastesInput,
} from "./context.ts";
import { joinNames, speak, spokenName } from "./speech.ts";

export const resolveTastesInput = z.object({ tastes: tastesInput });
export type ResolveTastesInput = z.infer<typeof resolveTastesInput>;

export const signalOut = z.object({
  input: z.string().describe("The taste as given."),
  kind: z.string(),
  id: z.string().describe("A Qloo entity ID (source entity) or tag ID (source tag)."),
  name: z.string().describe("Qloo's name for it."),
  source: z.enum(["entity", "tag"]),
});
export type Signal = z.infer<typeof signalOut>;

export const unresolvedOut = z.object({ input: z.string(), kind: z.string() });
export type Unresolved = z.infer<typeof unresolvedOut>;

export const resolveTastesOutput = z.object({
  mode: modeOut,
  notice: noticeOut,
  signals: z.array(signalOut),
  unresolved: z.array(unresolvedOut).describe("Tastes Qloo had no match for."),
  qloo_calls: qlooCallsOut,
  speech: z.string(),
});
export type ResolveTastesOutput = z.infer<typeof resolveTastesOutput>;

const PLACE = "urn:entity:place";

async function resolveOne(reply: QlooReply, t: Taste): Promise<Signal | undefined> {
  try {
    if (t.kind === "food") {
      const { results } = await reply.tags(t.name, 5);
      // A food tag is useful only if it can describe a place (parents name urn:entity:place).
      const tag = results.tags.find((x) => !x.parents || x.parents.some((p) => p.type === PLACE));
      return tag && { input: t.name, kind: t.kind, id: tag.id, name: tag.name, source: "tag" };
    }
    const { results } = await reply.search(t.name, SEARCH_TYPES[t.kind], 1);
    const hit = results[0];
    return hit && { input: t.name, kind: t.kind, id: hit.entity_id, name: hit.name, source: "entity" };
  } catch (e) {
    if (isNoMatch(e)) return undefined;
    throw e;
  }
}

/** Resolve every taste (in parallel); throws a QlooError only for a failure that isn't "no match". */
export async function resolveAll(reply: QlooReply, tastes: Taste[]): Promise<{ signals: Signal[]; unresolved: Unresolved[] }> {
  const found = await Promise.all(tastes.map((t) => resolveOne(reply, t)));
  const signals: Signal[] = [];
  const unresolved: Unresolved[] = [];
  found.forEach((s, i) => {
    if (s) signals.push(s);
    else unresolved.push({ input: tastes[i]!.name, kind: tastes[i]!.kind });
  });
  return { signals, unresolved };
}

export async function resolveTastes(args: ResolveTastesInput, deps: ToolDeps): Promise<ToolOutcome<ResolveTastesOutput>> {
  const reply = deps.qloo.reply(deps.client);
  let got: { signals: Signal[]; unresolved: Unresolved[] };
  try {
    got = await resolveAll(reply, args.tastes);
  } catch (e) {
    return qlooFailure(e, deps.log);
  }
  const { signals, unresolved } = got;
  const matched = signals.map((s) => spokenName(s.name));
  const missed = unresolved.map((u) => spokenName(u.input));
  const n = args.tastes.length;
  const speech = !signals.length
    ? speak(reply.mode, reply.notice, `Qloo had no match for ${joinNames(missed, "or")}, so try naming an artist, a film or a dish another way.`, "Qloo had no match for those tastes, so try naming them another way.")
    : speak(
        reply.mode,
        reply.notice,
        missed.length
          ? `I matched ${joinNames(matched)} on Qloo. I couldn't find ${joinNames(missed, "or")}.`
          : `I matched ${joinNames(matched)} on Qloo.`,
        missed.length ? `I matched ${joinNames(matched)} on Qloo, but not ${joinNames(missed, "or")}.` : `I matched all ${n} of your tastes on Qloo.`,
        `I matched ${signals.length} of your ${n} tastes on Qloo.`,
      );
  return {
    ok: true,
    value: { mode: reply.mode, ...(reply.notice ? { notice: reply.notice } : {}), signals, unresolved, qloo_calls: reply.calls, speech },
  };
}
