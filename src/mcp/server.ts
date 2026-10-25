// Builds the MCP server: serverInfo, instructions and the 3 read-only tools.
// A new instance per request (stateless Streamable HTTP); building one is cheap.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SITE_URL, VERSION } from "../meta.ts";
import type { ToolDeps, ToolOutcome } from "../tools/context.ts";
import { planDay, planDayInput, planDayOutput } from "../tools/plan-day.ts";
import { rankPlaces, rankPlacesInput, rankPlacesOutput } from "../tools/rank-places.ts";
import { resolveTastes, resolveTastesInput, resolveTastesOutput } from "../tools/resolve-tastes.ts";
import { type Icon, SERVER_ICONS, TOOL_ICONS } from "./icons.ts";

export const SERVER_NAME = "ambree-qloo";
export const SERVER_TITLE = "Ambree Taste Planner: Mauritius days powered by Qloo";
export const SERVER_DESCRIPTION =
  "Turns a traveller's tastes in music, film, books and food into a day in Mauritius: Qloo's Taste AI resolves the tastes and ranks real places on the island, and every answer is written to be spoken.";

export const INSTRUCTIONS =
  "These tools plan days in Mauritius from a traveller's tastes, using Qloo's Taste AI. Use plan_day for a whole day in one call; use resolve_tastes then rank_places to explore step by step. " +
  "Every result has a speech field: plain text of at most 2 sentences, written to be read aloud as it is. " +
  "Recommend only places these tools return, and when mode is demo, say the data is demo data, not live Qloo results.";

export const TOOL_NAMES = ["resolve_tastes", "rank_places", "plan_day"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const TOOL_SCHEMAS: Record<ToolName, { input: z.ZodType; output: z.ZodType }> = {
  resolve_tastes: { input: resolveTastesInput, output: resolveTastesOutput },
  rank_places: { input: rankPlacesInput, output: rankPlacesOutput },
  plan_day: { input: planDayInput, output: planDayOutput },
};

/**
 * The schemas we list, as JSON Schema 2020-12 (the 2025-11-25 default dialect, SEP-1613),
 * generated once from the same zod schemas the SDK validates with. The SDK itself would
 * list draft-07.
 */
export const LISTED_SCHEMAS: Record<ToolName, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = Object.fromEntries(
  TOOL_NAMES.map((name) => [
    name,
    {
      inputSchema: z.toJSONSchema(TOOL_SCHEMAS[name].input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(TOOL_SCHEMAS[name].output, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>,
    },
  ]),
) as Record<ToolName, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }>;

// Read-only, and open-world: every tool asks Qloo (or, in demo mode, its stand-in).
const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function toResult<T extends Record<string, unknown>>(outcome: ToolOutcome<T>): CallToolResult {
  if (!outcome.ok) return { content: [{ type: "text", text: outcome.message }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: outcome.value };
}

export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: VERSION,
      description: SERVER_DESCRIPTION,
      websiteUrl: SITE_URL,
      icons: SERVER_ICONS,
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "resolve_tastes",
    {
      title: "Resolve tastes",
      description:
        "Turn up to 6 things a traveller likes (an artist, a film, a TV show, a book, a podcast, a game, a brand, a person, a place or a food) into Qloo signals: entity IDs from Qloo search, or place tags for food. " +
        "Tastes Qloo can't match are listed in unresolved, never guessed. Pass the IDs to rank_places. Read the speech field aloud.",
      inputSchema: resolveTastesInput,
      outputSchema: resolveTastesOutput,
      annotations: ANNOTATIONS,
    },
    async (args) => toResult(await resolveTastes(args, deps)),
  );

  server.registerTool(
    "rank_places",
    {
      title: "Rank places in Mauritius",
      description:
        "Rank real places (or destinations) in Mauritius for taste signals with Qloo Insights: give entity_ids and tag_ids from resolve_tastes, optionally a vibe such as 'beach' and a town. " +
        "Each result has Qloo's affinity score, its tags and which tastes it came from. Read the speech field aloud.",
      inputSchema: rankPlacesInput,
      outputSchema: rankPlacesOutput,
      annotations: ANNOTATIONS,
    },
    async (args) => toResult(await rankPlaces(args, deps)),
  );

  server.registerTool(
    "plan_day",
    {
      title: "Plan a day",
      description:
        "Plan a day in Mauritius from a traveller's tastes in one call: it resolves the tastes on Qloo, has Qloo Insights rank places on the island, and fills morning, lunch, afternoon and evening (or 3 stops at a relaxed pace) with distinct places, saying which taste led to each. " +
        "Prefer this tool when someone asks what to do. Read the speech field aloud.",
      inputSchema: planDayInput,
      outputSchema: planDayOutput,
      annotations: ANNOTATIONS,
    },
    async (args) => toResult(await planDay(args, deps)),
  );

  patchToolHandlers(server, TOOL_ICONS);
  return server;
}

/**
 * A JSON-RPC error whose message is exactly `message`: the SDK sends `code` and `message`
 * as they are, while McpError would prefix "MCP error <code>: " to the message.
 */
function protocolError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

/**
 * Errors from the SDK's tools/call path, made readable: a request that fails the SDK's
 * own request schema (a bare ZodError, which would go out as -32603 with an issue dump)
 * becomes -32602, and an McpError loses its "MCP error <code>: " prefix.
 */
function cleanProtocolError(e: unknown): unknown {
  const issues = (e as { issues?: unknown })?.issues;
  if (Array.isArray(issues)) {
    const detail = issues
      .slice(0, 3)
      .map((i: { path?: unknown[]; message?: string }) => `${(i.path ?? []).join(".") || "request"}: ${i.message ?? "invalid"}`)
      .join("; ");
    return protocolError(ErrorCode.InvalidParams, `Invalid tools/call request: ${detail}`);
  }
  if (!(e instanceof Error) || !Number.isSafeInteger((e as { code?: unknown }).code)) return e;
  const code = (e as unknown as { code: number }).code;
  return protocolError(code, e.message.replace(/^MCP error -?\d+: /, ""), (e as { data?: unknown }).data);
}

type RawRequest = { method: string; params?: Record<string, unknown> };
type RawHandler = (request: RawRequest, extra: unknown) => Promise<unknown>;

/**
 * Gaps in SDK 1.32.1's McpServer, closed by wrapping its own handlers:
 *  - tools/list drops `icons` (the 2025-11-25 Tool field), so we add them, and lists
 *    draft-07 schemas, so we list our 2020-12 ones (validation stays the SDK's);
 *  - tools/call turns an unknown tool name into an `isError` result, but the spec
 *    makes it a protocol error, so we answer -32602 first. Input that fails a schema
 *    stays an `isError` result (SEP-1303), with the SDK's message tidied for the reader;
 *  - protocol error messages lose the duplicated "MCP error <code>: " prefix.
 * The SDK keeps handlers in a private map; if that ever moves, fail at startup.
 */
function patchToolHandlers(server: McpServer, icons: Record<string, Icon[]>): void {
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map) || !handlers.has("tools/list") || !handlers.has("tools/call")) {
    throw new Error("Unsupported MCP SDK: the tool request handlers were not found");
  }
  const list = handlers.get("tools/list") as RawHandler;
  const call = handlers.get("tools/call") as RawHandler;
  const known = new Set<string>(TOOL_NAMES);

  handlers.set("tools/list", async (request: RawRequest, extra: unknown) => {
    const result = (await list(request, extra)) as { tools: Array<{ name: string }> };
    return {
      ...result,
      tools: result.tools.map((t) => {
        const listed = known.has(t.name) ? LISTED_SCHEMAS[t.name as ToolName] : undefined;
        return { ...t, ...listed, ...(icons[t.name] ? { icons: icons[t.name] } : {}) };
      }),
    };
  });

  handlers.set("tools/call", async (request: RawRequest, extra: unknown) => {
    const name = request.params?.name;
    if (typeof name !== "string") {
      throw protocolError(ErrorCode.InvalidParams, `Invalid tool name: expected a string. Available tools: ${TOOL_NAMES.join(", ")}`);
    }
    if (!known.has(name)) {
      throw protocolError(ErrorCode.InvalidParams, `Unknown tool: ${name.slice(0, 64)}. Available tools: ${TOOL_NAMES.join(", ")}`);
    }
    let result: CallToolResult;
    try {
      result = (await call(request, extra)) as CallToolResult;
    } catch (e) {
      throw cleanProtocolError(e);
    }
    if (result.isError && result.content[0]?.type === "text") {
      const text = result.content[0].text
        .replace(/^MCP error -?\d+: /, "")
        .replace(/^Input validation error: Invalid arguments for tool (\w+): /, "Invalid arguments for $1: ");
      return { ...result, content: [{ type: "text", text }, ...result.content.slice(1)] };
    }
    return result;
  });
}
