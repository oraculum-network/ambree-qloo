// The entry point as a process: it boots on PORT=0, logs its mode, and never the key.

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scrubbedEnv } from "./helpers/app.ts";
import { SENTINEL_KEY } from "./helpers/shapes.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Spawn src/server.ts and resolve with its "listening" log line, then stop it. */
function boot(env: Record<string, string>): Promise<{ line: Record<string, unknown>; output: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, ["src/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no listening line: ${output}`));
    }, 10_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split("\n").find((l) => l.includes('"event":"listening"'));
      if (!line) return;
      clearTimeout(timer);
      child.once("exit", () => resolve({ line: JSON.parse(line) as Record<string, unknown>, output }));
      child.kill("SIGTERM");
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", reject);
  });
}

describe("node src/server.ts", () => {
  it("starts with PORT=0 and logs mode: demo", async () => {
    const { line } = await boot(scrubbedEnv({ PORT: "0", HOST: "127.0.0.1" }));
    expect(line).toMatchObject({ event: "listening", mode: "demo", qloo_base: "https://hackathon.api.qloo.com" });
    expect(line.port).toBeGreaterThan(0);
  });

  it("a key in the test shell does not reach a spawned server (scrubbed env)", async () => {
    const before = process.env.QLOO_API_KEY;
    process.env.QLOO_API_KEY = SENTINEL_KEY;
    try {
      const { line, output } = await boot(scrubbedEnv({ PORT: "0", HOST: "127.0.0.1" }));
      expect(line.mode).toBe("demo");
      expect(output).not.toContain(SENTINEL_KEY);
    } finally {
      if (before === undefined) delete process.env.QLOO_API_KEY;
      else process.env.QLOO_API_KEY = before;
    }
  });

  it("with a key it logs mode: live and never the key", async () => {
    const { line, output } = await boot(scrubbedEnv({ PORT: "0", HOST: "127.0.0.1", QLOO_API_KEY: SENTINEL_KEY }));
    expect(line.mode).toBe("live");
    expect(output).not.toContain(SENTINEL_KEY);
  });
});
