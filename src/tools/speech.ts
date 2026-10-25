// Text written for the ear: at most 2 sentences and 280 characters, no markdown,
// URLs or emoji (adapted from ambree-alexa). In demo mode every reply ends with a fixed
// sentence saying so: the body is fitted to 1 sentence and the room left, then the
// sentence is appended, so it can never be the part that gets cut.

import type { Mode } from "../config.ts";
import type { Notice } from "../qloo/client.ts";

export const SPEECH_MAX_CHARS = 280;
export const SPEECH_MAX_SENTENCES = 2;

export const DEMO_SENTENCE = "This uses demo data, not live Qloo results.";
export const LIVE_UNAVAILABLE_SENTENCE = "Live Qloo access isn't available right now, so this uses demo data.";

/** Strip markdown, links, URLs and emoji; collapse whitespace. */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, "$1$2")
    .replace(/[*#>|~]/g, " ")
    .replace(/(?<!\w)_|_(?!\w)/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** Sentences, split after . ! or ? followed by a space. */
export function sentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  return t.split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);
}

/** Plain text capped at `maxSentences` and `maxChars`, ending cleanly. */
export function capSpeech(text: string, maxSentences = SPEECH_MAX_SENTENCES, maxChars = SPEECH_MAX_CHARS): string {
  let out = sentences(plainText(text)).slice(0, maxSentences).join(" ");
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars - 1);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (lastStop > maxChars / 3) {
      out = cut.slice(0, lastStop + 1);
    } else {
      const lastSpace = cut.lastIndexOf(" ");
      out = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s-]+$/, "") + ".";
    }
  }
  if (out && !/[.!?]$/.test(out)) out += ".";
  return out;
}

/** Pick the first candidate that fits the limits as written, else cap the last one. */
export function fitWithin(maxSentences: number, maxChars: number, candidates: string[]): string {
  for (const c of candidates) {
    const plain = plainText(c);
    if (plain.length <= maxChars && sentences(plain).length <= maxSentences) return capSpeech(plain, maxSentences, maxChars);
  }
  return capSpeech(candidates[candidates.length - 1] ?? "", maxSentences, maxChars);
}

export function fitSpeech(...candidates: string[]): string {
  return fitWithin(SPEECH_MAX_SENTENCES, SPEECH_MAX_CHARS, candidates);
}

/**
 * The reply's speech. Live: the first candidate that fits 2 sentences. Demo: the first that
 * fits 1 sentence in the room left, then the demo sentence (or, after a live failure, the
 * live-unavailable sentence), so the label always survives and the total stays at 2.
 */
export function speak(mode: Mode, notice: Notice | undefined, ...candidates: string[]): string {
  if (mode === "live") return fitSpeech(...candidates);
  const suffix = notice === "live_unavailable" ? LIVE_UNAVAILABLE_SENTENCE : DEMO_SENTENCE;
  const body = fitWithin(1, SPEECH_MAX_CHARS - suffix.length - 1, candidates);
  return body ? `${body} ${suffix}` : suffix;
}

/** "A", "A and B", "A, B and C" */
export function joinNames(names: string[], conj = "and"): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${conj} ${names[names.length - 1]}`;
}

/** A name for speech: no "(demo)" tag (the demo sentence says it) and no sentence marks. */
export function spokenName(name: string): string {
  return plainText(name.replace(/\s*\(demo\)\s*$/i, ""))
    .replace(/[.!?]+(?=\s|$)/g, "")
    .trim();
}

export function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
