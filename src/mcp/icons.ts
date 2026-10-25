// Icons for serverInfo and each tool (MCP 2025-11-25), as SVG data URIs.

import { readFileSync } from "node:fs";

export interface Icon {
  src: string;
  mimeType: string;
  sizes: string[];
  theme?: "light" | "dark";
}

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const svgFile = (name: string) => readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8");

export const SERVER_ICONS: Icon[] = [
  { src: dataUri(svgFile("ambree-avatar.svg")), mimeType: "image/svg+xml", sizes: ["any"], theme: "light" },
  { src: dataUri(svgFile("ambree-avatar-dark.svg")), mimeType: "image/svg+xml", sizes: ["any"], theme: "dark" },
];

function glyph(body: string, theme: "light" | "dark"): Icon {
  const bg = theme === "light" ? "#F7F2E8" : "#10292B";
  const ink = theme === "light" ? "#10292B" : "#F7F2E8";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    `<rect width="24" height="24" rx="6" fill="${bg}"/>` +
    `<g fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
  return { src: dataUri(svg), mimeType: "image/svg+xml", sizes: ["any"], theme };
}

const GLYPHS: Record<string, string> = {
  // A heart: what the traveller likes.
  resolve_tastes: `<path d="M12 18.5s-6-3.6-6-8a3.2 3.2 0 0 1 6-1.6 3.2 3.2 0 0 1 6 1.6c0 4.4-6 8-6 8z"/>`,
  // Three bars, tallest first: a ranking.
  rank_places: `<path d="M7 18V8"/><path d="M12 18v-7"/><path d="M17 18v-4"/>`,
  // A sun over a line: a day.
  plan_day: `<circle cx="12" cy="11" r="3.5"/><path d="M5 18h14"/><path d="M12 4.5v1.5M6.5 7l1 1M17.5 7l-1 1"/>`,
};

export const TOOL_ICONS: Record<string, Icon[]> = Object.fromEntries(
  Object.entries(GLYPHS).map(([name, body]) => [name, [glyph(body, "light"), glyph(body, "dark")]]),
);
