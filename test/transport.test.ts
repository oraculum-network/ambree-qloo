// Transport behaviour of POST /mcp: methods, Origin/Host, limits, errors.

import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, INIT_PARAMS, MCP_HEADERS, rpc, startTestApp } from "./helpers/app.ts";

let t: TestApp;

beforeAll(async () => {
  // RATE_LIMIT_SCALE: this suite sends many /mcp requests from one loopback client.
  t = await startTestApp({ env: { PUBLIC_ORIGIN: "https://qloo.ambree.ai", ALLOWED_ORIGINS: "https://ambree.ai", RATE_LIMIT_SCALE: "10" } });
});
afterAll(() => t.close());

const post = (body: string, headers: Record<string, string> = {}, url = t.url) =>
  fetch(`${url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body });

/** A raw request with a custom Host header (fetch won't let us set Host). */
function rawPost(host: string, body: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(t.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...MCP_HEADERS, Host: host, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("methods", () => {
  it("GET /mcp 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${t.url}/mcp`, { method, headers: { Accept: "application/json, text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("Origin and Host", () => {
  it("foreign Origin 403", async () => {
    for (const origin of ["https://evil.example", "http://qloo.ambree.ai", "http://localhost:1"]) {
      const res = await post(rpc("initialize", INIT_PARAMS), { Origin: origin });
      expect(res.status, origin).toBe(403);
      expect((await res.json()).error.code).toBe(-32000);
    }
  });

  it("accepts PUBLIC_ORIGIN, ALLOWED_ORIGINS, localhost, and no Origin", async () => {
    const { port } = new URL(t.url);
    for (const origin of ["https://qloo.ambree.ai", "https://ambree.ai", `http://127.0.0.1:${port}`]) {
      expect((await post(rpc("initialize", INIT_PARAMS), { Origin: origin })).status, origin).toBe(200);
    }
    const res = await post(rpc("initialize", INIT_PARAMS));
    expect((await res.json()).result.protocolVersion).toBe("2025-11-25");
  });

  it("bad Host 403", async () => {
    const bad = await rawPost("hackathon.api.qloo.com", rpc("initialize", INIT_PARAMS));
    expect(bad.status).toBe(403);
    expect(JSON.parse(bad.body).error.message).toMatch(/Host/);
    expect((await rawPost("qloo.ambree.ai", rpc("initialize", INIT_PARAMS))).status).toBe(200);
  });
});

describe("bodies and errors", () => {
  it("batch 400", async () => {
    const one = JSON.parse(rpc("tools/list"));
    const res = await post(JSON.stringify([one, { ...one, id: 2 }]));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });

  it("body > 64 KB 413", async () => {
    const res = await post(rpc("tools/call", { name: "plan_day", arguments: { tastes: [{ kind: "music", name: "x".repeat(70 * 1024) }] } }));
    expect(res.status).toBe(413);
  });

  it("the SDK's Accept check stays (406), so the page must send both types", async () => {
    const res = await fetch(`${t.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: rpc("tools/list") });
    expect(res.status).toBe(406);
  });

  it("invalid arguments are an isError result, not a JSON-RPC error", async () => {
    const body = await (await post(rpc("tools/call", { name: "plan_day", arguments: { tastes: [] } }))).json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/^Invalid arguments for plan_day:/);
  });

  it("raw tools/call without initialize works (the page relies on this)", async () => {
    const res = await post(rpc("tools/call", { name: "plan_day", arguments: { tastes: [{ kind: "music", name: "Kaya" }] } }), { "MCP-Protocol-Version": "2025-11-25" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.structuredContent.mode).toBe("demo");
    expect(body.result.structuredContent.day).toHaveLength(4);
  });

  it("logs the tool name, never the arguments", async () => {
    await post(rpc("tools/call", { name: "resolve_tastes", arguments: { tastes: [{ kind: "music", name: "Secret Taste Words" }] } }));
    expect(t.logs.some((l) => Array.isArray(l.tools) && l.tools.includes("resolve_tastes"))).toBe(true);
    expect(JSON.stringify(t.logs)).not.toContain("Secret Taste Words");
  });
});

describe("rate limit", () => {
  it("429 after the burst", async () => {
    const small = await startTestApp();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await post(rpc("tools/list"), {}, small.url)).status);
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses[31]).toBe(429);
      const res = await post(rpc("tools/list"), {}, small.url);
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    } finally {
      await small.close();
    }
  });
});
