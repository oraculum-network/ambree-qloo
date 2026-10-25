// Speech: the helpers, and every tool's speech within the limits in every mode.

import { afterEach, describe, expect, it } from "vitest";
import { type DemoData, loadDemoData } from "../src/qloo/fixtures.ts";
import type { ToolDeps, ToolOutcome } from "../src/tools/context.ts";
import { planDay, planDayInput } from "../src/tools/plan-day.ts";
import { rankPlaces, rankPlacesInput } from "../src/tools/rank-places.ts";
import { resolveTastes, resolveTastesInput } from "../src/tools/resolve-tastes.ts";
import {
  DEMO_SENTENCE,
  LIVE_UNAVAILABLE_SENTENCE,
  SPEECH_MAX_CHARS,
  capSpeech,
  fitSpeech,
  plainText,
  sentences,
  speak,
  spokenName,
} from "../src/tools/speech.ts";
import { demoDeps, liveDeps, startQlooMock } from "./helpers/deps.ts";
import { type MockServer, json } from "./helpers/mock-server.ts";

let mock: MockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function speechOf(o: ToolOutcome<{ speech: string }>): string {
  if (!o.ok) throw new Error(`expected ok, got: ${o.message}`);
  return o.value.speech;
}

function expectSpeakable(s: string, label: string) {
  expect(s.length, label).toBeGreaterThan(10);
  expect(s.length, label).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
  expect(sentences(s).length, label).toBeLessThanOrEqual(2);
  expect(s, label).not.toMatch(/https?:|www\.|[*_#`]|\p{Extended_Pictographic}/u);
}

const SIX_LONG = Array.from({ length: 6 }, (_, i) => ({ kind: "music" as const, name: `Extraordinarily Long Artist Name Number ${i} `.padEnd(60, "x") }));

async function allSpeech(deps: ToolDeps): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  out.push(["resolve", speechOf(await resolveTastes(resolveTastesInput.parse({ tastes: SIX_LONG }), deps))]);
  out.push(["resolve short", speechOf(await resolveTastes(resolveTastesInput.parse({ tastes: [{ kind: "film", name: "Amelie" }] }), deps))]);
  out.push(["rank", speechOf(await rankPlaces(rankPlacesInput.parse({ entity_ids: ["00000000-0000-4000-8000-000100000001"], take: 10 }), deps))]);
  out.push(["plan", speechOf(await planDay(planDayInput.parse({ tastes: SIX_LONG }), deps))]);
  out.push(["plan relaxed", speechOf(await planDay(planDayInput.parse({ tastes: [{ kind: "food", name: "seafood" }], pace: "relaxed" }), deps))]);
  return out;
}

/** Fixtures with very long place and town names: the worst case for the demo label. */
function longNamedData(): DemoData {
  const d = loadDemoData();
  return {
    ...d,
    places: d.places.map((p) => ({
      ...p,
      name: `The Remarkably Long And Winding Name Of ${p.name.replace(" (demo)", "")} (demo)`,
      properties: { geocode: { ...p.properties!.geocode, city: `Greater ${p.properties!.geocode!.city} District` } },
    })),
  };
}

describe("speech helpers", () => {
  it("strips markdown, URLs and emoji", () => {
    expect(plainText("## Hi **there** — see [this](https://example.com/x) 🌴 https://example.com/y")).toBe("Hi there — see this");
  });

  it("caps at 2 sentences and 280 characters", () => {
    expect(capSpeech("One. Two! Three?")).toBe("One. Two!");
    const long = capSpeech("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(280);
    expect(fitSpeech("x ".repeat(200), "Short one.")).toBe("Short one.");
  });

  it("speak: demo keeps the label even when the body is far too long", () => {
    const s = speak("demo", undefined, "word ".repeat(200), "Another. Two sentences here. Three.");
    expect(s.endsWith(` ${DEMO_SENTENCE}`)).toBe(true);
    expect(s.length).toBeLessThanOrEqual(280);
    expect(sentences(s)).toHaveLength(2);
    expect(speak("live", undefined, "One. Two.")).toBe("One. Two.");
  });

  it("spokenName drops (demo) and sentence marks", () => {
    expect(spokenName("Blue Hour Terrace (demo)")).toBe("Blue Hour Terrace");
    expect(spokenName("Mr. Robot")).toBe("Mr Robot");
    expect(spokenName("**Bold** [x](https://e.com)")).toBe("Bold x");
  });
});

describe("tool speech", () => {
  it("every tool's speech ≤2 sentences, ≤280 chars, no URLs", async () => {
    for (const [label, s] of await allSpeech(demoDeps())) expectSpeakable(s, `demo ${label}`);
    mock = await startQlooMock({
      places: Array.from({ length: 6 }, (_, i) => ({ name: `A Very Long Live Place Name For Testing Purposes ${i}`, town: "Somewhere Quite Far Away", country: "MU", tags: ["Museum"], affinity: 0.9 - i / 20 })),
    });
    for (const [label, s] of await allSpeech(liveDeps(mock))) expectSpeakable(s, `live ${label}`);
  });

  it("demo-mode speech always says demo data, even at worst case (6 tastes × 60-char names, 4 long stops)", async () => {
    expect(SIX_LONG.every((t) => t.name.length === 60)).toBe(true);
    for (const deps of [demoDeps(), demoDeps([], longNamedData())]) {
      for (const [label, s] of await allSpeech(deps)) {
        expectSpeakable(s, label);
        expect(s.endsWith(` ${DEMO_SENTENCE}`), `${label}: ${s}`).toBe(true);
      }
    }
  });

  it("live_unavailable speech is still ≤2 sentences", async () => {
    mock = await startQlooMock();
    mock.setHandler((_q, res) => json(res, 403, { code: 403, reason: "Forbidden" }));
    for (const [label, s] of await allSpeech(liveDeps(mock, [], { data: longNamedData() }))) {
      expectSpeakable(s, label);
      expect(s.endsWith(` ${LIVE_UNAVAILABLE_SENTENCE}`), `${label}: ${s}`).toBe(true);
    }
  });

  it("live-mode speech never says demo", async () => {
    mock = await startQlooMock({ places: [{ name: "Live Place", town: "Curepipe", country: "MU", tags: ["Museum"], affinity: 0.9 }] });
    for (const [label, s] of await allSpeech(liveDeps(mock))) expect(s.toLowerCase(), label).not.toContain("demo");
  });
});
