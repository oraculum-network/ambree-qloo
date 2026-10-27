// The per-client live budget end to end: config → app → /mcp → live transport, against a
// local mock Qloo. One client past QLOO_CLIENT_DAILY_CALLS gets labelled demo data.

import { afterEach, describe, expect, it } from "vitest";
import { type TestApp, connectClient, startTestApp } from "./helpers/app.ts";
import { startQlooMock } from "./helpers/deps.ts";
import type { MockServer } from "./helpers/mock-server.ts";
import { SENTINEL_KEY } from "./helpers/shapes.ts";

let mock: MockServer | undefined;
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  await mock?.close();
  t = undefined;
  mock = undefined;
});

const PLACES = [
  { name: "Morning Spot", town: "Port Louis", country: "MU", tags: ["Museum"], affinity: 0.95 },
  { name: "Lunch Spot", town: "Port Louis", country: "MU", tags: ["Seafood Restaurant"], affinity: 0.9 },
];

describe("QLOO_CLIENT_DAILY_CALLS", () => {
  it("a client past its budget falls back to demo, labelled; cache hits don't count", async () => {
    mock = await startQlooMock({ places: PLACES });
    t = await startTestApp({ env: { QLOO_API_KEY: SENTINEL_KEY, QLOO_API_BASE: mock.url, QLOO_CLIENT_DAILY_CALLS: "4" } });
    const client = await connectClient(t.url);
    const plan = async (name: string) =>
      (await client.callTool({ name: "plan_day", arguments: { tastes: [{ kind: "music", name }] } })).structuredContent as { mode: string; notice?: string };

    // 1 search + 3 insights (things to do, restaurants, bars) = the whole budget.
    expect(await plan("Kaya")).toMatchObject({ mode: "live" });
    expect(mock.requests).toHaveLength(4);

    const over = await plan("Someone Else");
    expect(over).toMatchObject({ mode: "demo", notice: "live_unavailable" });
    expect(mock.requests).toHaveLength(4);
    expect(t.logs).toContainEqual(expect.objectContaining({ event: "qloo_fallback", qloo_fallback: "client_quota" }));

    // The same tastes again are cache hits: still live, no new request.
    expect(await plan("Kaya")).toMatchObject({ mode: "live" });
    expect(mock.requests).toHaveLength(4);
    await client.close();
    // The client key (an IP) is never logged.
    expect(JSON.stringify(t.logs)).not.toContain("127.0.0.1");
  });
});
