// Static files, security headers and the health check.

import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGE_CSP } from "../src/http/headers.ts";
import { VERSION } from "../src/meta.ts";
import { type TestApp, startTestApp } from "./helpers/app.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(() => t.close());

/** Send a raw path (fetch would normalize "/../"). */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(t.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("static files", () => {
  it("no path traversal", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/fonts/../../src/app.ts", "/..%2fsrc%2fapp.ts", "/.env", "/%00.html", "/src/app.ts", "/../fixtures/qloo-demo.json"]) {
      const res = await rawGet(path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toMatch(/createApp|"dependencies"|"synthetic"/);
    }
  });

  it("CSP self-only on HTML", async () => {
    const page = await fetch(`${t.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(PAGE_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    for (const path of ["/", "/healthz", "/missing.html"]) {
      const res = await fetch(`${t.url}${path}`);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("permissions-policy"), path).toBe("microphone=(), camera=(), geolocation=()");
    }
  });
});

describe("health", () => {
  it("/healthz shows mode demo without a key", async () => {
    const res = await fetch(`${t.url}/healthz`);
    expect(await res.json()).toEqual({ ok: true, version: VERSION, mode: "demo" });
  });

  it("/healthz shows mode live with a key (and never the key)", async () => {
    const live = await startTestApp({ env: { QLOO_API_KEY: "test-key-not-real-0000" } });
    try {
      const text = await (await fetch(`${live.url}/healthz`)).text();
      expect(JSON.parse(text)).toEqual({ ok: true, version: VERSION, mode: "live" });
      expect(text).not.toContain("test-key-not-real-0000");
    } finally {
      await live.close();
    }
  });

  it("unknown API routes are 404 JSON", async () => {
    const res = await fetch(`${t.url}/api/nope`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"not_found"}');
  });
});
