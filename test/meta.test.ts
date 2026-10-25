import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_URL, VERSION } from "../src/meta.ts";

describe("meta", () => {
  it("VERSION comes from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; license: string };
    expect(VERSION).toBe(pkg.version);
    expect(pkg.license).toBe("MIT");
    expect(SITE_URL).toBe("https://qloo.ambree.ai");
  });
});
