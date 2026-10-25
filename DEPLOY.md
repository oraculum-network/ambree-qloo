# Deploy plan: qloo.ambree.ai on oraculum-prod

**Status: a plan, never run.** Hosting waits on the CEO's go. Nothing here has touched a server. The pattern copies
alexa.ambree.ai: the image is built on the host (never on a laptop), k3s runs it with `imagePullPolicy: Never`, and
Traefik routes the host. Every detail this repo could not check against alexa's own files is marked **TODO-CHECK**,
with the file to compare against. alexa's `k8s/` and `ops/` files were not readable when this was written; the facts
below come from the run's item-01 plan (`items/01-prod/PLAN.md`).

What this repo provides:

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | node:22-alpine (digest-pinned, as ambree-alexa), `npm ci --omit=dev --ignore-scripts`, runs as `node`, read-only root filesystem |
| `deploy/k8s/` | Deployment `qloo-web`, Service, Ingress for `qloo.ambree.ai`, namespace `qloo` (`kubectl kustomize deploy/k8s` renders 3 objects) |
| `deploy/store-key.sh` | Stores the Qloo key in Secret `qloo/qloo-api`, key `QLOO_API_KEY` (hidden prompt or stdin; create empty, then patch; never apply) |
| `scripts/smoke.ts` | `npm run smoke`, or `node scripts/smoke.ts` in the pod: one live call per Qloo endpoint, checked against the contract |

**Safe default.** The Deployment reads `QLOO_API_KEY` from Secret `qloo-api` with `optional: true`. With no Secret,
the pod boots in demo mode: synthetic fixtures, no outbound call, "demo data" on the page and in every spoken reply.

## 1. Monorepo follow-ups (CTO, in devnet; not done here)

This repo may not edit the monorepo. Before the first deploy:

1. **Deploy gate namespace.** Add `qloo` to `APP_NAMESPACES` in `ops/oracle/deploy-gate.sh` (line 55 allows
   `concierge site bots-system alexa`), with its gate tests.
2. **Ingress host allowlist.** TODO-CHECK `ops/oracle/deploy-gate.sh:81`: item 01 says it "already admits
   `ambree.ai`", so `qloo.ambree.ai` may need no change.
3. **Security block.** A `qloo` block in `ops/oracle/security.sh`, mirroring the alexa block (lines 314-409):
   - the namespace with PSA `restricted`;
   - NetworkPolicies: default deny; ingress from Traefik only; egress to DNS and to TCP 443 outside the cluster
     (a NetworkPolicy can't name a host such as `hackathon.api.qloo.com`; TODO-CHECK how the alexa block allows its
     egress to MET Norway and GDACS, and copy that form);
   - a ResourceQuota of 100m / 256Mi (the pod asks 25m / 64Mi, limit 100m / 192Mi);
   - a PriorityClass `qloo-low` with the same value as `alexa-low`, and the same priority guard.
4. **deploy.sh service entry.** A `qloo-web` entry in `ops/oracle/deploy.sh` that builds this repo the way it builds
   alexa (image `ambree-qloo:<sha7>`, k3s import), with `KDIR=deploy/k8s` and the image tag substituted for
   `CHANGEME-sha7`. TODO-CHECK against alexa's entry: how the repo reaches the host (step 3 below) and the tag rule.
5. **Ingress TLS.** TODO-CHECK `k8s/oracle/alexa*/ingress.yaml`: copy its entrypoint annotation and `tls` stanza into
   `deploy/k8s/ingress.yaml`.
6. **Uptime.** An uptime line for `https://qloo.ambree.ai/healthz` next to alexa's.

## 2. DNS (CEO or CTO)

An `A` record `qloo.ambree.ai` to the oraculum-prod address, the same as `alexa.ambree.ai`.

## 3. Image, built on the host

The repo is private until the CEO says otherwise, so it travels as a bundle, not a clone:

```bash
git -C /Users/haidar.deenmahomed/trp/ambree-qloo bundle create /tmp/ambree-qloo.bundle --all
```

Copy the bundle to the host and build there the way `deploy.sh` builds alexa (TODO-CHECK the exact build and
`k3s ctr images import` commands in deploy.sh's alexa path). The image name is `ambree-qloo:<sha7>`.

## 4. Apply

```bash
kubectl apply -k deploy/k8s
```

After the CTO has set the image tag. With no Secret yet, the site serves demo mode.

## 5. Store the key (when the CEO's Qloo email arrives)

On the host, from the repo checkout:

```bash
bash deploy/store-key.sh
kubectl -n qloo rollout restart deploy/qloo-web
```

Or from the Mac, so the key never lands in a file or shell history: `read -rs k` on the Mac, then pipe
`printf '%s\n' "$k"` over ssh into `bash deploy/store-key.sh` (which reads one line from stdin when it has no terminal).

## 6. Verify

```bash
kubectl -n qloo exec deploy/qloo-web -- node scripts/smoke.ts
curl -s https://qloo.ambree.ai/healthz
```

The smoke run prints 3 `OK` lines, the Mauritius count and `RESULT: OK`, and exits 0. `FAIL MU check` means no
result had `country_code` MU; README "Check the live contract" says how to switch `MU_FILTER`.

Smoke searches one artist only. Then click the page's three example chips once, in live mode: the page should show no
"Qloo had no match for: …" line, and each turn under "Under the hood" should be badged "Live Qloo", not "Demo data".
An unmatched taste shows up in the pod log as
`qloo_no_match` with its endpoint, status and type (a 403 there means the key may not use that entity type).
`/healthz` then shows
`"mode":"live"`; on its own that shows only that a key is set, not that it works. TODO-CHECK: item 01 lists only
`rollout-status`, `revision` and `get` as gate verbs (`items/01-prod/PLAN.md:136`), so `exec` and `rollout restart`
may need host-side kubectl rather than the gate.

## 7. Rollback to demo mode

```bash
kubectl -n qloo patch secret qloo-api --type=json -p '[{"op":"remove","path":"/data/QLOO_API_KEY"}]'
kubectl -n qloo rollout restart deploy/qloo-web
```

This removes the key without deleting the Secret (the gate has no delete verb, `items/01-prod/PLAN.md:56`). The pod
comes back in demo mode. To take the site down instead: `kubectl -n qloo scale deploy/qloo-web --replicas=0`.

## Hosting window

The brief keeps the demo up until 16 Nov. The rules end judging on 5 Nov, and Qloo deactivates hackathon keys after the
hackathon closes. A dead key answers 401/403, and each reply then falls back to labelled demo data on its own
(`notice: live_unavailable`), so the site needs no change when the key dies.
