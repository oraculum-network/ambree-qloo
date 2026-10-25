import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "../src/config.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("README", () => {
  it("README env table lists every key in config.ts", () => {
    const listed = [...readme.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...ENV_KEYS].sort());
  });

  it("names the licence and the demo-data label", () => {
    expect(readme).toContain("MIT");
    expect(readme).toContain("This uses demo data, not live Qloo results.");
  });
});
