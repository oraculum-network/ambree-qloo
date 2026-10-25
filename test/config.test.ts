import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, QLOO_HACKATHON_BASE, loadConfig } from "../src/config.ts";
import { SENTINEL_KEY } from "./helpers/shapes.ts";

describe("config", () => {
  it("no key → demo mode", () => {
    const c = loadConfig({});
    expect(c.mode).toBe("demo");
    expect(c.qlooKey).toBeUndefined();
    expect(loadConfig({ QLOO_API_KEY: "   " }).mode).toBe("demo");
  });

  it("a key → live mode, and the key never shows when the config is printed", () => {
    const c = loadConfig({ QLOO_API_KEY: SENTINEL_KEY });
    expect(c.mode).toBe("live");
    expect(c.qlooKey).toBe(SENTINEL_KEY);
    expect(JSON.stringify(c)).not.toContain(SENTINEL_KEY);
    expect(inspect(c)).not.toContain(SENTINEL_KEY);
    expect(Object.keys(c)).not.toContain("qlooKey");
  });

  it("default base is the hackathon host", () => {
    expect(QLOO_HACKATHON_BASE).toBe("https://hackathon.api.qloo.com");
    expect(loadConfig({}).qlooBase).toBe("https://hackathon.api.qloo.com");
    expect(loadConfig({ QLOO_API_BASE: "https://hackathon.api.qloo.com/" }).qlooBase).toBe("https://hackathon.api.qloo.com");
  });

  it("http base rejected unless loopback", () => {
    expect(() => loadConfig({ QLOO_API_BASE: "http://hackathon.api.qloo.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ QLOO_API_BASE: "http://evil.example" })).toThrow(/must be https/);
    expect(loadConfig({ QLOO_API_BASE: "http://127.0.0.1:9999" }).qlooBase).toBe("http://127.0.0.1:9999");
    expect(loadConfig({ QLOO_API_BASE: "http://localhost:9999" }).qlooBase).toBe("http://localhost:9999");
  });

  it("invalid values name the key, never the value", () => {
    try {
      loadConfig({ QLOO_DAILY_CALLS: "lots", QLOO_API_KEY: "x".repeat(600) });
      throw new Error("expected a ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("QLOO_DAILY_CALLS");
      expect((e as Error).message).toContain("QLOO_API_KEY");
      expect((e as Error).message).not.toContain("xxxx");
      expect((e as Error).message).not.toContain("lots");
    }
  });

  it("defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ port: 8080, trustProxyHops: 0, rateLimitScale: 1, qlooDailyCalls: 3000, allowedOrigins: [] });
  });
});
