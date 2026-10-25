// The deploy files: manifest text checks (there is no YAML library here), the Dockerfile,
// and deploy/store-key.sh run against a fake kubectl that records argv and stdin.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubbedEnv } from "./helpers/app.ts";
import { SENTINEL_KEY } from "./helpers/shapes.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const deployment = read("deploy/k8s/deployment.yaml");
const ingress = read("deploy/k8s/ingress.yaml");
const dockerfile = read("Dockerfile");
const FAKE = join(ROOT, "test/fakes/kubectl");

describe("manifests", () => {
  it("secretKeyRef optional true", () => {
    expect(deployment).toMatch(/- name: QLOO_API_KEY\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: qloo-api\n\s+key: QLOO_API_KEY\n\s+optional: true/);
  });

  it("imagePullPolicy Never", () => {
    expect(deployment).toMatch(/image: ambree-qloo:CHANGEME-sha7\n\s+imagePullPolicy: Never/);
    // The tag is set in one place, the kustomization, by DEPLOY.md step 4's sed.
    expect(read("deploy/k8s/kustomization.yaml")).toMatch(/images:\n\s+- name: ambree-qloo\n\s+newTag: CHANGEME-sha7\n/);
    expect(read("DEPLOY.md")).toContain('sed -i "s/newTag: CHANGEME-sha7/newTag: $(git rev-parse --short=7 HEAD)/" deploy/k8s/kustomization.yaml');
  });

  it("readOnlyRootFilesystem", () => {
    expect(deployment).toContain("readOnlyRootFilesystem: true");
    expect(deployment).toContain("runAsNonRoot: true");
    expect(deployment).toContain("allowPrivilegeEscalation: false");
    expect(deployment).toMatch(/drop:\n\s+- ALL/);
    expect(deployment).toContain("type: RuntimeDefault");
    expect(deployment).toContain("priorityClassName: qloo-low");
    expect(deployment).toMatch(/requests:\n\s+cpu: 25m\n\s+memory: 64Mi\n\s+limits:\n\s+cpu: 100m\n\s+memory: 192Mi/);
  });

  it("host qloo.ambree.ai", () => {
    expect(ingress).toContain("host: qloo.ambree.ai");
    expect(deployment).toContain("value: https://qloo.ambree.ai");
    expect(read("deploy/k8s/kustomization.yaml")).toContain("namespace: qloo");
  });

  it("no literal secret data", () => {
    for (const file of readdirSync(join(ROOT, "deploy/k8s"))) {
      const text = read(`deploy/k8s/${file}`);
      expect(text, file).not.toMatch(/kind:\s*Secret/);
      expect(text, file).not.toMatch(/^\s*(data|stringData):/m);
    }
  });

  it("Dockerfile copies scripts and fixtures", () => {
    for (const dir of ["src", "public", "fixtures", "scripts"]) expect(dockerfile).toContain(`COPY ${dir} ./${dir}`);
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toContain(".npmrc");
    expect(dockerfile).toMatch(/FROM node:22-alpine@sha256:[0-9a-f]{64}/);
  });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  /** What the fake read on stdin: the dry-run create (the key) and the patch (the JSON). */
  createStdin?: string;
  patchStdin?: string;
}

const read0 = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-key-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function storeKey(stdin: string, opts: { secretExists?: boolean } = {}): Promise<Run> {
  const log = join(dir, "argv.log");
  writeFileSync(log, "");
  return new Promise((resolve, reject) => {
    const env = scrubbedEnv({ KUBECTL: FAKE, FAKE_LOG: log, FAKE_DIR: dir, FAKE_SECRET_EXISTS: opts.secretExists ? "1" : "0" });
    const child = spawn("bash", ["deploy/store-key.sh"], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
      resolve({ code, stdout, stderr, calls, createStdin: read0(join(dir, "stdin-create")), patchStdin: read0(join(dir, "stdin-patch")) });
    });
    child.stdin.end(stdin);
  });
}

describe("deploy/store-key.sh", () => {
  it("store-key.sh never passes the key in argv", async () => {
    const r = await storeKey(`${SENTINEL_KEY}\n`);
    expect(r.code, r.stderr).toBe(0);
    expect(r.calls.join("\n")).not.toContain(SENTINEL_KEY);
    expect(r.stdout + r.stderr).not.toContain(SENTINEL_KEY);
    // It arrived on the create --dry-run call's stdin, without the newline.
    expect(r.createStdin).toBe(SENTINEL_KEY);
    // The patch carries only {data: {QLOO_API_KEY: base64(key)}}.
    expect(JSON.parse(r.patchStdin!)).toEqual({ data: { QLOO_API_KEY: Buffer.from(SENTINEL_KEY).toString("base64") } });
  });

  it("store-key.sh never calls apply, and patches qloo-api", async () => {
    const r = await storeKey(`${SENTINEL_KEY}\n`);
    // The first two run in order; the last two are one pipeline, so either order.
    expect(r.calls.slice(0, 2)).toEqual(["-n qloo get secret qloo-api -o name", "-n qloo create secret generic qloo-api"]);
    expect(r.calls.slice(2).sort()).toEqual([
      "-n qloo create secret generic qloo-api --from-file=QLOO_API_KEY=/dev/stdin --dry-run=client -o json",
      "-n qloo patch secret qloo-api --patch-file /dev/stdin",
    ]);
    expect(r.calls.some((c) => /\bapply\b/.test(c))).toBe(false);
  });

  it("an existing Secret is patched, not created again", async () => {
    const r = await storeKey(`${SENTINEL_KEY}\r\n`, { secretExists: true });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(3);
    expect(r.calls.filter((c) => c === "-n qloo create secret generic qloo-api")).toEqual([]);
    expect(r.calls).toContain("-n qloo patch secret qloo-api --patch-file /dev/stdin");
    expect(r.createStdin).toBe(SENTINEL_KEY);
  });

  it("refuses empty input and calls nothing", async () => {
    const r = await storeKey("\n");
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
    expect(r.stderr).toMatch(/no key given/);
  });
});
