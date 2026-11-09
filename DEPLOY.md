# Deploy

**The hosted demo is retired.** It ran at qloo.ambree.ai through the Qloo Agentic Hackathon's judging (30 Oct to
5 Nov 2026) and was taken down on 9 Nov 2026. This page explains how to run the same container on a Kubernetes
cluster of your own. To try the app, the local run in the README (`npm ci && npm start`, demo mode, no key) is enough.

What this repo provides:

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | node:22-alpine (digest-pinned), `npm ci --omit=dev --ignore-scripts`, runs as `node`, read-only root filesystem |
| `deploy/k8s/` | Deployment, Service and Ingress `qloo-web`, namespace `qloo`, image `oraculum/ambree-qloo` (`kubectl kustomize deploy/k8s` renders 3 objects) |
| `deploy/store-key.sh` | Stores the Qloo key in Secret `qloo/qloo-api`, key `QLOO_API_KEY` (hidden prompt on a terminal, else one line on stdin; create empty, then patch; never apply) |
| `scripts/smoke.ts` | `npm run smoke`, or `node scripts/smoke.ts` in the pod: one live call per Qloo endpoint, checked against the contract |

**Safe default.** The Deployment reads `QLOO_API_KEY` from Secret `qloo-api` with `optional: true`. With no Secret,
the pod boots in demo mode: synthetic fixtures, no outbound call, "demo data" on the page and in every spoken reply.

## 1. Build the image

Tag it with the commit's 7-character sha. The manifests use `imagePullPolicy: Never`, so build the image where the
cluster's container runtime can see it (or push it to your registry and change the pull policy):

```bash
T=$(git rev-parse --short=7 HEAD)
docker build -t "oraculum/ambree-qloo:$T" .
```

## 2. DNS and TLS

Point an `A` record for your host name at the cluster's ingress, and set that host in `deploy/k8s/ingress.yaml` and
`PUBLIC_ORIGIN`. The Ingress annotations are Traefik's (`websecure`, TLS on, a Let's Encrypt resolver named `le`);
adapt them to your ingress controller. Make the record resolve before the first apply if your controller requests
its certificate only once.

## 3. Render and apply

Render `deploy/k8s` through an overlay that sets the tag. `kustomization.yaml` ships with `newTag: set-by-deploy`,
which fails with `ErrImageNeverPull` rather than run a stale image:

```bash
O=$(mktemp -d); mkdir "$O/src" "$O/overlay"; git archive HEAD deploy/k8s | tar -x -C "$O/src"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../src/deploy/k8s\nimages:\n  - name: oraculum/ambree-qloo\n    newTag: "%s"\n' "$T" > "$O/overlay/kustomization.yaml"
kubectl kustomize "$O/overlay" > "$O/rendered.yaml"; grep 'image:' "$O/rendered.yaml"
kubectl apply -f "$O/rendered.yaml"
kubectl -n qloo rollout status deployment/qloo-web --timeout=300s
```

The `grep` must print `image: oraculum/ambree-qloo:<T>`. With no Secret yet, the site serves demo mode.

## 4. Store the key (live mode)

`store-key.sh` reads the key from a hidden prompt, or one line on stdin (for example from your password manager's
CLI). The key never goes in a file, argv, shell history or a log:

```bash
bash deploy/store-key.sh
kubectl -n qloo rollout restart deployment/qloo-web
```

## 5. Verify

```bash
kubectl -n qloo exec deploy/qloo-web -- node scripts/smoke.ts
curl -s https://<your host>/healthz
```

The smoke run prints 3 `OK` lines, the Mauritius count and `RESULT: OK`, and exits 0. `FAIL MU check` means no
result had `country_code` MU; README "Check the live contract" says how to switch `MU_FILTER`. Then click the page's
three example chips once: each turn under "Under the hood" should be badged "Live Qloo", not "Demo data".
`/healthz` shows `"mode":"live"`; on its own that shows only that a key is set, not that it works.

## 6. Back to demo mode, or down

```bash
kubectl -n qloo delete secret qloo-api && kubectl -n qloo rollout restart deployment/qloo-web
kubectl -n qloo scale deployment/qloo-web --replicas=0
```

A dead key answers 401/403, and each reply then falls back to labelled demo data on its own
(`notice: live_unavailable`), so the site needs no change when a key expires.
