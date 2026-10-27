// The page's example chips: each label matches its EXAMPLES entry in public/app.js, and
// every music/film/book name is one Qloo's hackathon /search resolved correctly when the
// CTO checked it live on 27 Oct ("Kaya" matched "Kaya Project", a different artist;
// "Animal Crossing" as a video game matched nothing).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const html = readFileSync(join(ROOT, "public/index.html"), "utf8");
const app = readFileSync(join(ROOT, "public/app.js"), "utf8");

const VERIFIED = ["Life of Pi", "Miles Davis", "Bob Marley", "Jack Johnson", "Alpha Blondy", "Moana", "Norwegian Wood"];

const chips = [...html.matchAll(/<button[^>]*data-example="(\d+)"[^>]*>([^<]+)<\/button>/g)].map((m) => ({ i: Number(m[1]), label: m[2]! }));
const examples = (() => {
  const block = /const EXAMPLES = \[\n([\s\S]*?)\n\];/.exec(app)?.[1] ?? "";
  return block.split("\n").map((line) => [...line.matchAll(/\["(\w+)", "([^"]+)"\]/g)].map((m) => ({ kind: m[1]!, name: m[2]! })));
})();

describe("example chips", () => {
  it("each chip's label is its EXAMPLES entry, in order", () => {
    expect(chips.map((c) => c.i)).toEqual([0, 1, 2]);
    expect(examples).toHaveLength(3);
    for (const c of chips) expect(c.label).toBe(examples[c.i]!.map((t) => t.name).join(" · "));
  });

  it("every chip pairs live-verified names with a food or vibe word", () => {
    for (const ex of examples) {
      const named = ex.filter((t) => t.kind !== "food");
      expect(ex.some((t) => t.kind === "food"), JSON.stringify(ex)).toBe(true);
      for (const t of named) expect(VERIFIED, t.name).toContain(t.name);
    }
    expect(html + app).not.toMatch(/Kaya|Animal Crossing/);
  });
});
