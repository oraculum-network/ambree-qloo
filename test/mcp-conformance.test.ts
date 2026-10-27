// SDK conformance: the official SDK client against our /mcp over Streamable HTTP (demo mode).

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS, SERVER_NAME, SERVER_TITLE } from "../src/mcp/server.ts";
import { VERSION } from "../src/meta.ts";
import { planDayOutput } from "../src/tools/plan-day.ts";
import { rankPlacesOutput } from "../src/tools/rank-places.ts";
import { resolveTastesOutput } from "../src/tools/resolve-tastes.ts";
import { DEMO_SENTENCE, sentences } from "../src/tools/speech.ts";
import { type TestApp, connectClient, startTestApp } from "./helpers/app.ts";
import { json, queryOf, startMockServer } from "./helpers/mock-server.ts";
import { SENTINEL_KEY, liveInsightsBody, liveSearchBody, liveTagsBody } from "./helpers/shapes.ts";

let t: TestApp;
let client: Client;

beforeAll(async () => {
  t = await startTestApp({ env: { RATE_LIMIT_SCALE: "10" } });
  client = await connectClient(t.url);
});
afterAll(async () => {
  await client.close();
  await t.close();
});

describe("initialize", () => {
  it("negotiates 2025-11-25", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    const transport = client.transport as unknown as { protocolVersion?: string };
    expect(transport.protocolVersion).toBe("2025-11-25");
  });

  it("serverInfo, instructions, icons", () => {
    const info = client.getServerVersion()!;
    expect(info.name).toBe(SERVER_NAME);
    expect(info.title).toBe(SERVER_TITLE);
    expect(info.version).toBe(VERSION);
    expect(info.websiteUrl).toBe("https://qloo.ambree.ai");
    expect(info.description).toMatch(/Qloo/);
    expect(info.icons?.map((i) => i.theme)).toEqual(["light", "dark"]);
    expect(info.icons?.[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(client.getInstructions()).toMatch(/speech/);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });
});

describe("tools/list", () => {
  it("lists exactly resolve_tastes, rank_places, plan_day with 2020-12 schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(["plan_day", "rank_places", "resolve_tastes"]);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.$schema).toMatch(/\/draft\/2020-12\/schema$/);
      expect(tool.outputSchema?.$schema).toMatch(/\/draft\/2020-12\/schema$/);
      expect(tool.outputSchema?.properties).toHaveProperty("speech");
      expect(tool.outputSchema?.properties).toHaveProperty("mode");
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      expect(tool.icons?.length).toBe(2);
    }
    const plan = tools.find((x) => x.name === "plan_day")!;
    expect(plan.inputSchema.required).toEqual(["tastes"]);
  });
});

describe("tools/call", () => {
  const cases: Array<[string, Record<string, unknown>, { parse: (v: unknown) => unknown }]> = [
    ["resolve_tastes", { tastes: [{ kind: "music", name: "Kaya" }, { kind: "food", name: "street food" }] }, resolveTastesOutput],
    ["rank_places", { vibe: "beach", take: 3 }, rankPlacesOutput],
    ["plan_day", { tastes: [{ kind: "film", name: "Amelie" }, { kind: "music", name: "Kaya" }] }, planDayOutput],
  ];

  for (const [name, args, schema] of cases) {
    it(`${name}: structuredContent validates, a matching text block, and demo-labelled speech`, async () => {
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      expect(() => schema.parse(res.structuredContent)).not.toThrow();
      const text = res.content.find((c) => c.type === "text");
      expect(text && "text" in text && JSON.parse(text.text)).toEqual(res.structuredContent);
      const out = res.structuredContent as { speech: string; mode: string };
      expect(out.mode).toBe("demo");
      expect(out.speech.endsWith(DEMO_SENTENCE)).toBe(true);
      expect(sentences(out.speech).length).toBeLessThanOrEqual(2);
    });
  }

  it("structuredContent validates against outputSchema (Ajv)", async () => {
    const { tools } = await client.listTools();
    const ajv = new AjvJsonSchemaValidator();
    for (const [name, args] of cases) {
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const validate = ajv.getValidator(tools.find((x) => x.name === name)!.outputSchema!);
      expect(validate(res.structuredContent).valid, name).toBe(true);
      const { speech: _dropped, ...broken } = res.structuredContent as { speech: string };
      expect(validate(broken).valid, name).toBe(false);
    }
  });

  it("live mode, Qloo in the live shapes (no success, null regions, no affinity): every tool's structuredContent validates", async () => {
    const mock = await startMockServer((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, liveSearchBody([`${queryOf(req).query} (demo)`]));
      if (path === "/v2/tags") return json(res, 200, liveTagsBody(3));
      if (path === "/v2/insights") return json(res, 200, liveInsightsBody(5));
      json(res, 404, {});
    });
    const live = await startTestApp({ env: { QLOO_API_KEY: SENTINEL_KEY, QLOO_API_BASE: mock.url, RATE_LIMIT_SCALE: "10" } });
    const liveClient = await connectClient(live.url);
    try {
      const { tools } = await liveClient.listTools();
      const ajv = new AjvJsonSchemaValidator();
      for (const [name, args] of cases) {
        const res = (await liveClient.callTool({ name, arguments: args })) as CallToolResult;
        expect(res.isError, `${name}: ${JSON.stringify(res.content)}`).toBeFalsy();
        expect(res.structuredContent, name).toMatchObject({ mode: "live" });
        expect(ajv.getValidator(tools.find((x) => x.name === name)!.outputSchema!)(res.structuredContent).valid, name).toBe(true);
      }
      expect(live.logs.some((l) => l.event === "qloo_shape_mismatch")).toBe(false);
    } finally {
      await liveClient.close();
      await live.close();
      await mock.close();
    }
  });

  it("unknown tool → -32602", async () => {
    await expect(client.callTool({ name: "book_hotel", arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });
});
