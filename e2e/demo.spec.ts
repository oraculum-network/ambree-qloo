// The demo page in Chromium, in demo mode: the banner, a chip plan, Under the hood,
// 360 px layout, keyboard submit, screenshots, and no foreign requests. One test stubs
// plan_day with a live-mode reply to check the cards for places with no score or town.

import { mkdirSync } from "node:fs";
import { type Page, test as base, expect } from "@playwright/test";

const SHOTS = new URL("./screenshots/", import.meta.url);
const DEMO_SENTENCE = "This uses demo data, not live Qloo results.";

// Every test: no console errors and no request to any other origin.
const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const errors: string[] = [];
      const foreign: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("request", (r) => {
        const url = r.url();
        if (!url.startsWith("data:") && new URL(url).origin !== origin) foreign.push(url);
      });
      await use();
      expect(foreign, "requests to other origins").toEqual([]);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

/** Sentences, split after . ! or ? followed by a space (as src/tools/speech.ts). */
const sentences = (t: string) => t.trim().split(/(?<=[.!?])\s+(?=\S)/).filter(Boolean);

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, "horizontal overflow").toBeLessThanOrEqual(client);
}

test("demo banner visible", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#demo-banner")).toBeVisible();
  await expect(page.locator("#demo-banner strong")).toHaveText("Demo data: synthetic, not from Qloo.");
  await expect(page.getByText("Taste data powered by Qloo's API.")).toBeVisible();
});

test("chip → plan shows 4 day cards and speech with ≤2 sentences that mentions demo data", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Bob Marley · seafood · Life of Pi" }).click();
  await expect(page.locator("#day .card")).toHaveCount(4);
  await expect(page.locator("#day .card-slot")).toHaveText(["Morning · Thing to do", "Lunch · Restaurant", "Afternoon · Thing to do", "Evening · Bar"]);
  // One region: the area line, and each later stop's distance from the first.
  await expect(page.locator("#area")).toHaveText(/^A day around .+: every stop within 15 km of the first\.$/);
  for (const line of (await page.locator("#day .card-town").allTextContents()).slice(1)) expect(line).toMatch(/ · \d+(\.\d)? km from the first stop$/);
  // The seafood taste shaped lunch.
  await expect(page.locator("#day .card").nth(1).locator(".card-tags li").first()).toHaveText("Seafood (demo)");
  await expect(page.locator("#day")).not.toContainText("VCA");
  for (const name of await page.locator("#day .card-name").allTextContents()) expect(name).toMatch(/\(demo\)$/);
  const speech = (await page.locator("#speech").textContent()) ?? "";
  expect(speech.endsWith(DEMO_SENTENCE), speech).toBe(true);
  expect(sentences(speech).length).toBeLessThanOrEqual(2);
  expect(speech.length).toBeLessThanOrEqual(280);
  await expect(page.locator("#demo-banner")).toBeVisible();
  await expect(page.locator("#day .card-why").first()).toContainText(/^Fans of .+ tend to like it: /);
  const whys = await page.locator("#day .card-why").allTextContents();
  expect(new Set(whys).size).toBe(whys.length);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: new URL("demo-desktop.png", SHOTS).pathname, fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 360, height: 780 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: new URL("demo-360.png", SHOTS).pathname, fullPage: true, animations: "disabled" });
});

test("under-the-hood lists resolve/insights calls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.locator("#hood")).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Miles Davis · cafe · Norwegian Wood" }).click();
  await expect(page.locator("#day .card")).toHaveCount(4);
  const turn = page.locator(".hood-turn").first();
  await expect(turn.locator(".badge")).toHaveText("Demo data");
  const lines = await turn.locator(".calls li").allTextContents();
  expect(lines[0]).toMatch(/^initialize · \d+ ms · ok$/);
  expect(lines.some((l) => /^tools\/call plan_day · \d+ ms · ok$/.test(l))).toBe(true);
  expect(lines.some((l) => l.includes("Qloo GET /search"))).toBe(true);
  expect(lines.some((l) => l.includes("Qloo GET /v2/tags"))).toBe(true);
  expect(lines.some((l) => l.includes("Qloo GET /v2/insights"))).toBe(true);
});

test("360 px: no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await noHorizontalOverflow(page);
  await expect(page.locator("#hood")).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Moana · street food · Jack Johnson" }).click();
  await expect(page.locator("#day .card")).toHaveCount(4);
  await page.locator("#hood summary").click();
  await expect(page.locator(".hood-turn")).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test("live cards: no score line when Qloo sent no affinity, no town line when it sent no town", async ({ page }) => {
  // plan_day's reply is stubbed (same origin) with the shape the tools give for live insights
  // with no query.affinity and a null city/name (test/tools.test.ts "live shapes").
  const out = {
    mode: "live",
    day: [
      { slot: "morning", place: "Live Shape Place 0 (demo)", place_id: "00000000-0000-4000-8000-000000000600", town: "Port Louis", affinity: 0, tags: ["Test tag 0 (demo)"], why: "Because you like seafood." },
      { slot: "lunch", place: "Live Shape Place 1 (demo)", place_id: "00000000-0000-4000-8000-000000000601", affinity: 0.42, tags: [], why: "A strong Qloo match for your tastes." },
    ],
    signals: [],
    unresolved: [],
    qloo_calls: [{ endpoint: "/v2/insights", ms: 5, cached: false }],
    speech: "Start at Live Shape Place 0 in Port Louis and have lunch at Live Shape Place 1.",
  };
  await page.route("**/mcp", async (route) => {
    const msg = route.request().postDataJSON();
    if (msg?.method !== "tools/call") return route.fallback();
    await route.fulfill({ json: { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Bob Marley · seafood · Life of Pi" }).click();
  const cards = page.locator("#day .card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".card-town")).toHaveText("Port Louis");
  await expect(cards.nth(0).locator(".card-score")).toHaveCount(0);
  await expect(cards.nth(1).locator(".card-town")).toHaveCount(0);
  await expect(cards.nth(1).locator(".card-score")).toHaveText("Qloo affinity 0.42");
  await expect(page.locator("#day")).not.toContainText("null");
  // A reply without `kind`, `area` or km_from_start (no region) shows neither, and nothing "undefined".
  await expect(page.locator("#area")).toBeHidden();
  await expect(cards.nth(0).locator(".card-slot")).toHaveText("Morning");
  await expect(page.locator("#day")).not.toContainText("undefined");
  await expect(page.locator(".hood-turn .badge").first()).toHaveText("Live Qloo");
});

test("keyboard: Enter submits", async ({ page }) => {
  await page.goto("/");
  const name = page.getByLabel("Taste 1 name");
  await name.fill("Bob Marley");
  await name.press("Enter");
  await expect(page.locator("#day .card")).toHaveCount(4);
  await expect(page.locator("#speech")).toContainText("demo data");
});
