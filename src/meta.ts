// Package metadata shared by the server, the MCP serverInfo and /healthz.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export const VERSION: string = pkg.version;
export const SITE_URL = "https://qloo.ambree.ai";
