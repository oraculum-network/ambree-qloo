// npm run smoke: the live check once a Qloo key exists. Exactly 3 calls, one per endpoint:
//   1. GET /search      ?query=Bob%20Marley&types=urn:entity:artist&take=1
//   2. GET /v2/tags     ?filter.query=beach&take=3
//   3. GET /v2/insights ?filter.type=urn:entity:place&signal.interests.entities=<id from 1>
//                       &<the app's MU_FILTER>&feature.explainability=true&take=5
//      (if call 1 found nothing, signal.interests.tags=<id from 2> instead)
// Each body is checked against the contract (src/qloo/contract.ts). It prints OK or the
// mismatched paths, the Mauritius count and which optional place fields appeared. The
// Mauritius check fails when insights returns nothing or no result has country_code MU.
// It never prints bodies, names, headers or the key, and writes no files.
//
// The key: QLOO_API_KEY from the environment if set (inside the pod); else a hidden prompt
// on a terminal; else one line from stdin. Never from argv.
// Exit codes: 0 all OK, 1 a mismatch or HTTP error, 2 no key or bad config.

import { ConfigError, QLOO_HACKATHON_BASE, qlooBaseOf } from "../src/config.ts";
import { type Params, insightsParams, searchParams, tagsParams } from "../src/qloo/client.ts";
import { ENDPOINT_PATHS, type Endpoint, InsightsResponse, SearchResponse, TagsResponse, checkShape } from "../src/qloo/contract.ts";
import { CappedFetchError, fetchCapped } from "../src/qloo/fetch.ts";
import { COUNTRY_CODE, MU_FILTER } from "../src/tools/rank-places.ts";

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

/** Read the key with no echo from a terminal. */
function hiddenPrompt(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (v: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      resolve(v);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(value);
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** One line from piped stdin (or "" when stdin is empty). */
async function firstLine(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.includes("\n")) break;
  }
  return text.split(/\r?\n/)[0] ?? "";
}

async function readKey(): Promise<string> {
  const fromEnv = process.env.QLOO_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) return (await hiddenPrompt("Qloo API key (hidden): ")).trim();
  return (await firstLine()).trim();
}

interface CallResult {
  ok: boolean;
  body?: unknown;
}

async function call(base: string, key: string, endpoint: Endpoint, params: Params): Promise<CallResult> {
  const path = ENDPOINT_PATHS[endpoint];
  const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
  let res: { status: number; text: string };
  try {
    res = await fetchCapped(url, { "X-Api-Key": key, Accept: "application/json" }, { timeoutMs: 15_000 });
  } catch (e) {
    out(`FAIL ${path}: ${e instanceof CappedFetchError ? e.kind : "network"}${e instanceof CappedFetchError && e.kind === "redirect" ? " (a redirect was refused: check the base URL)" : ""}`);
    return { ok: false };
  }
  if (res.status === 401 || res.status === 403) {
    out(`FAIL ${path} ${res.status}: check base URL and X-Api-Key (hackathon keys work only on ${QLOO_HACKATHON_BASE})`);
    return { ok: false };
  }
  if (res.status === 429) {
    out(`FAIL ${path} 429: rate limited, try again in a minute`);
    return { ok: false };
  }
  if (res.status < 200 || res.status >= 300) {
    out(`FAIL ${path} ${res.status}`);
    return { ok: false };
  }
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    out(`MISMATCH ${path}: $ expected JSON, got text`);
    return { ok: false };
  }
  const shape = checkShape(endpoint, body);
  if (!shape.ok) {
    for (const m of shape.mismatches) out(`MISMATCH ${path}: ${m}`);
    return { ok: false, body };
  }
  return { ok: true, body };
}

const OPTIONAL_PLACE_FIELDS: Array<[string, (e: Record<string, unknown>) => unknown]> = [
  ["properties.geocode.city", (e) => (e.properties as { geocode?: { city?: unknown } })?.geocode?.city],
  ["properties.geocode.name", (e) => (e.properties as { geocode?: { name?: unknown } })?.geocode?.name],
  ["properties.geocode.country_code", (e) => (e.properties as { geocode?: { country_code?: unknown } })?.geocode?.country_code],
  ["properties.address", (e) => (e.properties as { address?: unknown })?.address],
  // plan_day classifies places by it (src/tools/places.ts).
  ["properties.primary_genre", (e) => (e.properties as { primary_genre?: unknown })?.primary_genre],
  ["properties.business_rating", (e) => (e.properties as { business_rating?: unknown })?.business_rating],
  ["properties.price_level", (e) => (e.properties as { price_level?: unknown })?.price_level],
  ["location", (e) => e.location],
  ["tags", (e) => e.tags],
  ["query.affinity", (e) => (e.query as { affinity?: unknown })?.affinity],
  ["properties.affinity", (e) => (e.properties as { affinity?: unknown })?.affinity],
  ["query.explainability", (e) => (e.query as { explainability?: unknown })?.explainability],
];

async function main(): Promise<number> {
  let base: string;
  try {
    base = qlooBaseOf(process.env.QLOO_API_BASE?.trim() || QLOO_HACKATHON_BASE);
  } catch (e) {
    err(`smoke: ${e instanceof ConfigError ? e.message : "QLOO_API_BASE is not a valid URL"}`);
    return 2;
  }
  const key = await readKey();
  if (!key) {
    err("smoke: no Qloo key. Set QLOO_API_KEY in the environment, or type it at the hidden prompt, or pipe it on stdin.");
    return 2;
  }
  out(`smoke: ${base} (key read; it is sent only in the X-Api-Key header)`);
  let failed = false;

  // 1. Search.
  const s = await call(base, key, "search", searchParams("Bob Marley", "urn:entity:artist", 1));
  const searchHits = s.ok ? SearchResponse.parse(s.body).results : [];
  if (s.ok) out(`OK /search 200 ${searchHits.length} results`);
  else failed = true;

  // 2. Tags.
  const t = await call(base, key, "tags", tagsParams("beach", 3));
  const tagHits = t.ok ? TagsResponse.parse(t.body).results.tags : [];
  if (t.ok) out(`OK /v2/tags 200 ${tagHits.length} results`);
  else failed = true;

  // 3. Insights: places in Mauritius, from the artist, else from the tag.
  const entity = searchHits[0]?.entity_id;
  const tag = tagHits[0]?.id;
  if (!entity && !tag) {
    out("SKIP insights: no signal");
    return 1;
  }
  const params = insightsParams({ type: "urn:entity:place", ...(entity ? { entities: [entity] } : { tags: [tag!] }), ...MU_FILTER, take: 5 });
  const filter = Object.entries(params).find(([k]) => k === "filter.geocode.country_code" || k === "filter.location.query");
  const i = await call(base, key, "insights", params);
  if (i.ok) {
    const entities = InsightsResponse.parse(i.body).results.entities;
    out(`OK /v2/insights 200 ${entities.length} results (signal: ${entity ? "entity from /search" : "tag from /v2/tags"})`);
    const mu = entities.filter((e) => e.properties?.geocode?.country_code?.toUpperCase() === COUNTRY_CODE).length;
    const line = `${mu} of ${entities.length} results have country_code ${COUNTRY_CODE} (filter: ${filter ? filter.join("=") : "none"})`;
    if (mu === 0) {
      // Qloo ignored the filter, or gave no country codes: either way the app can't trust its days.
      out(`FAIL MU check: ${line}`);
      failed = true;
    } else out(`MU check: ${line}`);
    const raw = (i.body as { results: { entities: Array<Record<string, unknown>> } }).results.entities;
    // Seen = a value on at least one result; null (live sends admin2_region: null) is not a value.
    const seen = OPTIONAL_PLACE_FIELDS.filter(([, get]) => raw.some((e) => get(e) != null)).map(([name]) => name);
    out(`Optional fields seen: ${seen.length ? seen.join(", ") : "none"}`);
  } else failed = true;

  out(failed ? "RESULT: FAIL" : "RESULT: OK");
  return failed ? 1 : 0;
}

process.exitCode = await main();
