// The demo page in Chromium, in demo mode: the banner, a chip plan, Under the hood,
// 360 px layout, keyboard submit, screenshots, and no foreign requests.

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
  await page.getByRole("button", { name: "Kaya · seafood · Life of Pi" }).click();
  await expect(page.locator("#day .card")).toHaveCount(4);
  await expect(page.locator("#day .card-slot")).toHaveText(["Morning", "Lunch", "Afternoon", "Evening"]);
  for (const name of await page.locator("#day .card-name").allTextContents()) expect(name).toMatch(/\(demo\)$/);
  const speech = (await page.locator("#speech").textContent()) ?? "";
  expect(speech.endsWith(DEMO_SENTENCE), speech).toBe(true);
  expect(sentences(speech).length).toBeLessThanOrEqual(2);
  expect(speech.length).toBeLessThanOrEqual(280);
  await expect(page.locator("#demo-banner")).toBeVisible();
  await expect(page.locator("#day .card-why").first()).toContainText("Because you like");
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
  await page.getByRole("button", { name: "Moana · street food · Animal Crossing" }).click();
  await expect(page.locator("#day .card")).toHaveCount(4);
  await page.locator("#hood summary").click();
  await expect(page.locator(".hood-turn")).toHaveCount(1);
  await noHorizontalOverflow(page);
});

test("keyboard: Enter submits", async ({ page }) => {
  await page.goto("/");
  const name = page.getByLabel("Taste 1 name");
  await name.fill("Kaya");
  await name.press("Enter");
  await expect(page.locator("#day .card")).toHaveCount(4);
  await expect(page.locator("#speech")).toContainText("demo data");
});
