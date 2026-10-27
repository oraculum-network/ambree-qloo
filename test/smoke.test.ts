// npm run smoke against a local mock Qloo, as a spawned process with a scrubbed env.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubbedEnv } from "./helpers/app.ts";
import { type MockServer, json, queryOf, startMockServer } from "./helpers/mock-server.ts";
import { SENTINEL_KEY, insightsBodyA, liveInsightsBody, liveSearchBody, liveTagsBody, searchBody, tagsBody } from "./helpers/shapes.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function smoke(opts: { stdin?: string; env?: Record<string, string>; args?: string[] } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke.ts", ...(opts.args ?? [])], { cwd: ROOT, env: scrubbedEnv(opts.env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

let mock: MockServer;
beforeEach(async () => {
  mock = await startMockServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/search") return json(res, 200, searchBody());
    if (path === "/v2/tags") return json(res, 200, tagsBody(3));
    if (path === "/v2/insights") return json(res, 200, insightsBodyA(5));
    json(res, 404, {});
  });
});
afterEach(async () => {
  await mock.close();
});

const withMock = () => ({ QLOO_API_BASE: mock.url });
const paths = () => mock.requests.map((r) => new URL(r.url, "http://x").pathname);

describe("smoke", () => {
  it("the live shapes of 27 Oct (no success on /search, admin2_region null, no affinity) → RESULT: OK; null fields are not 'seen'", async () => {
    mock.setHandler((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, liveSearchBody());
      if (path === "/v2/tags") return json(res, 200, liveTagsBody(3));
      if (path === "/v2/insights") return json(res, 200, liveInsightsBody(5));
      json(res, 404, {});
    });
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("MISMATCH");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("OK "))).toEqual([
      "OK /search 200 1 results",
      "OK /v2/tags 200 3 results",
      "OK /v2/insights 200 5 results (signal: entity from /search)",
    ]);
    expect(r.stdout).toContain("\nMU check: 5 of 5 results have country_code MU (filter: filter.geocode.country_code=MU)\n");
    expect(r.stdout).toContain("\nOptional fields seen: properties.geocode.name, properties.geocode.country_code, properties.address, tags\n");
    expect(r.stdout).toContain("RESULT: OK");
  });

  it("all OK → exit 0, 3 OK lines, and the mock saw X-Api-Key = sentinel on each call", async () => {
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const ok = r.stdout.split("\n").filter((l) => l.startsWith("OK "));
    expect(ok).toEqual(["OK /search 200 1 results", "OK /v2/tags 200 3 results", "OK /v2/insights 200 5 results (signal: entity from /search)"]);
    expect(r.stdout).toContain("\nMU check: 5 of 5 results have country_code MU (filter: filter.geocode.country_code=MU)\n");
    expect(r.stdout).toContain("Optional fields seen: properties.geocode.name, properties.geocode.country_code, tags, query.affinity");
    expect(r.stdout).toContain("RESULT: OK");
    expect(paths()).toEqual(["/search", "/v2/tags", "/v2/insights"]);
    for (const req of mock.requests) {
      expect(req.method).toBe("GET");
      expect(req.headers["x-api-key"]).toBe(SENTINEL_KEY);
      expect(req.headers.authorization).toBeUndefined();
    }
    expect(queryOf(mock.requests[2]!)).toMatchObject({
      "filter.type": "urn:entity:place",
      "signal.interests.entities": "00000000-0000-4000-8000-000000000900",
      "filter.geocode.country_code": "MU",
      "feature.explainability": "true",
      take: "5",
    });
  });

  it("reads the key from QLOO_API_KEY in the environment (the pod case)", async () => {
    const r = await smoke({ env: { ...withMock(), QLOO_API_KEY: SENTINEL_KEY } });
    expect(r.code).toBe(0);
    expect(mock.requests.every((q) => q.headers["x-api-key"] === SENTINEL_KEY)).toBe(true);
  });

  it("shape drift → exit 1 with path", async () => {
    mock.setHandler((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, { success: true, results: { entities: [] } });
      if (path === "/v2/tags") return json(res, 200, tagsBody(1));
      json(res, 200, insightsBodyA(1));
    });
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("MISMATCH /search: $.results expected array, got object");
    expect(r.stdout).toContain("RESULT: FAIL");
  });

  it("401 → exit 1 'check base URL and X-Api-Key'", async () => {
    mock.setHandler((_req, res) => json(res, 401, { code: 401, reason: "Unauthorized", message: "No API key found in request" }));
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL /search 401: check base URL and X-Api-Key");
    expect(r.stdout).toContain("SKIP insights: no signal");
  });

  it("search empty → insights uses the tag signal", async () => {
    mock.setHandler((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, { success: true, results: [] });
      if (path === "/v2/tags") return json(res, 200, tagsBody(2));
      json(res, 200, insightsBodyA(2));
    });
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK /search 200 0 results");
    expect(r.stdout).toContain("(signal: tag from /v2/tags)");
    const q = queryOf(mock.requests[2]!);
    expect(q["signal.interests.tags"]).toBe("urn:tag:demo:test_0");
    expect(q["signal.interests.entities"]).toBeUndefined();
    expect(mock.requests).toHaveLength(3);
  });

  it("insights with no MU results (Qloo ignored the filter) → FAIL MU check, exit 1", async () => {
    mock.setHandler((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, searchBody());
      if (path === "/v2/tags") return json(res, 200, tagsBody(3));
      json(res, 200, insightsBodyA(5, "FR"));
    });
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("OK /v2/insights 200 5 results");
    expect(r.stdout).toContain("FAIL MU check: 0 of 5 results have country_code MU (filter: filter.geocode.country_code=MU)");
    expect(r.stdout).toContain("RESULT: FAIL");
  });

  it("insights with no results at all → FAIL MU check, exit 1", async () => {
    mock.setHandler((req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      if (path === "/search") return json(res, 200, searchBody());
      if (path === "/v2/tags") return json(res, 200, tagsBody(3));
      json(res, 200, insightsBodyA(0));
    });
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL MU check: 0 of 0 results have country_code MU");
    expect(r.stdout).toContain("RESULT: FAIL");
  });

  it("no key, no TTY, empty stdin → exit 2", async () => {
    const r = await smoke({ env: withMock() });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no Qloo key/);
    expect(mock.requests).toHaveLength(0);
  });

  it("stdout and stderr never contain the key sentinel", async () => {
    const runs = [await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() })];
    mock.setHandler((_req, res) => json(res, 400, { code: 400, reason: `bad ${SENTINEL_KEY}`, message: `key ${SENTINEL_KEY} invalid` }));
    runs.push(await smoke({ stdin: `${SENTINEL_KEY}\n`, env: withMock() }));
    for (const r of runs) {
      expect(r.stdout + r.stderr).not.toContain(SENTINEL_KEY);
      // No names or bodies either: the mock's entity names never appear.
      expect(r.stdout).not.toMatch(/\(demo\)/);
    }
  });

  it("a key in argv is ignored", async () => {
    const r = await smoke({ args: [SENTINEL_KEY], env: withMock() });
    expect(r.code).toBe(2);
    expect(mock.requests).toHaveLength(0);
  });

  it("https enforced for non-loopback base", async () => {
    const r = await smoke({ stdin: `${SENTINEL_KEY}\n`, env: { QLOO_API_BASE: "http://hackathon.api.qloo.com" } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/QLOO_API_BASE must be https/);
  });
});
