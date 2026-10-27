# Deploy plan: qloo.ambree.ai on oraculum-prod

The pattern is alexa.ambree.ai's (live since 20 Oct):
- the image is built on the host, never on a laptop;
- k3s runs it with `imagePullPolicy: Never`;
- Traefik routes the host and gets its Let's Encrypt certificate.

This repo is not in the monorepo, so the monorepo's `ops/oracle/deploy.sh` can't deploy it (it archives only its own
repo). The steps below send the same deploy-gate requests by hand. The 27 Oct run is scripted in the CTO's
`cw-out/2026-10-27/qloo/deploy-qloo.sh`.

What this repo provides:

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | node:22-alpine (digest-pinned, as ambree-alexa), `npm ci --omit=dev --ignore-scripts`, runs as `node`, read-only root filesystem |
| `deploy/k8s/` | Deployment, Service and Ingress `qloo-web` for `qloo.ambree.ai`, namespace `qloo`, image `oraculum/ambree-qloo` (`kubectl kustomize deploy/k8s` renders 3 objects) |
| `deploy/store-key.sh` | Stores the Qloo key in Secret `qloo/qloo-api`, key `QLOO_API_KEY` (hidden prompt on a terminal, else one line on stdin; create empty, then patch; never apply) |
| `scripts/smoke.ts` | `npm run smoke`, or `node scripts/smoke.ts` in the pod: one live call per Qloo endpoint, checked against the contract |

**Safe default.** The Deployment reads `QLOO_API_KEY` from Secret `qloo-api` with `optional: true`. With no Secret,
the pod boots in demo mode: synthetic fixtures, no outbound call, "demo data" on the page and in every spoken reply.

In the commands below, `K` is the admin's ssh (`ubuntu@130.61.238.6`, key `~/.ssh/oraculum-oci`) and `D` is the
deploy user's (`deploy@130.61.238.6`, key `~/.ssh/oraculum-deploy`), whose forced command is the deploy gate. Run them
from bash, not zsh (zsh doesn't split `${K[@]}`):

```bash
K=(-i ~/.ssh/oraculum-oci -o ConnectTimeout=15 ubuntu@130.61.238.6)
D=(-i ~/.ssh/oraculum-deploy -o IdentitiesOnly=yes -o BatchMode=yes deploy@130.61.238.6)
```

## 1. The monorepo side (branch `ops/qloo-host`)

These were TODO-CHECKs; they were checked against the alexa sources on 27 Oct:

| What | Where (monorepo) | Result |
|---|---|---|
| The gate admits the image and namespace | `ops/oracle/remote/deploy-gate.sh` | `SERVICES` gains `ambree-qloo` (image `oraculum/ambree-qloo:<sha7>`, the alexa rule), `APP_NAMESPACES` gains `qloo` |
| The Ingress host allowlist | `deploy-gate.sh` `INGRESS_HOST_RE` | Admits any subdomain of `ambree.ai`, so `qloo.ambree.ai` needs no change. Every rule needs a host; no `defaultBackend` |
| Namespace, quotas, NetworkPolicies | `ops/oracle/security.sh`, the qloo block | A copy of alexa's: PSA restricted, `qloo-low` = 100 (as `alexa-low`), `qloo-cap`, `qloo-limits`, `qloo-priority-guard`, and these NetworkPolicies: in from Traefik on :8080; out to DNS; out to TCP 443 at `0.0.0.0/0` minus the private ranges, the metadata service and the host's own IP. A NetworkPolicy can't name `hackathon.api.qloo.com`; this is the form alexa uses for OpenRouter |
| Labels the policies select | same | `app.kubernetes.io/name: ambree-qloo` on the pod template (`deploy/k8s/deployment.yaml`) |
| deploy.sh entry | `ops/oracle/deploy.sh` | None that deploys: `deploy.sh ambree-qloo` refuses with a pointer here (step 3 does its job by hand) |
| Ingress TLS | `k8s/oracle/alexa/ingress.yaml` | Annotations `router.entrypoints: websecure`, `router.tls: "true"`, `router.tls.certresolver: le`; no `tls:` stanza (no Ingress on the host has one) |
| `jq` on the host | the gate | The gate's `apply` already needs `jq`, so it is there |
| `exec` and `rollout restart` | the gate's verbs | Not gate verbs. They run as the admin (`ssh "${K[@]}" 'sudo k3s kubectl …'`), as alexa's Secret and restarts did |
| Uptime | none for alexa either | No monitor exists to copy (open question for the CTO) |

Before the first deploy, the CTO:
1. merges `ops/qloo-host`;
2. installs the gate on the host;
3. runs the monorepo's `security.sh`:

```bash
ssh "${K[@]}" 'sudo bash -s' < ops/oracle/security.sh
```

Its last line must read `qloo: psa restricted | netpols allow-dns-egress allow-from-traefik allow-https-egress default-deny | quotas qloo-cap qloo-priority-guard | priorityclass qloo-low=100`.

## 2. DNS

An `A` record `qloo.ambree.ai` → 130.61.238.6, DNS-only (not proxied), the same as `alexa.ambree.ai`. The Cloudflare
token is IP-locked to the host, so the API call runs there with the token piped over ssh (deploy-qloo.sh's `dns`
step). It must resolve publicly **before** the first apply: Traefik asks Let's Encrypt once and doesn't retry a
failed certificate on its own.

## 3. Image and apply, through the gate

From this repo on the Mac, at the commit to deploy. The tag is its 7-char sha. The repo stays private and needs no
remote: `git archive` streams the tree to the gate, which builds it with nerdctl + BuildKit (native arm64) into k3s
containerd, as `deploy.sh` does for alexa:

```bash
T=$(git rev-parse --short=7 HEAD)
ssh "${D[@]}" "images ambree-qloo"
git archive --format=tar HEAD | gzip -c | ssh "${D[@]}" "build ambree-qloo $T"
```

Render `deploy/k8s` through an overlay that sets the tag, the way `deploy.sh` does. `kustomization.yaml` ships with
`newTag: set-by-deploy`, which would fail with `ErrImageNeverPull` rather than run a stale image:

```bash
O=$(mktemp -d); mkdir "$O/src" "$O/overlay"; git archive HEAD deploy/k8s | tar -x -C "$O/src"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - ../src/deploy/k8s\nimages:\n  - name: oraculum/ambree-qloo\n    newTag: "%s"\n' "$T" > "$O/overlay/kustomization.yaml"
kubectl kustomize "$O/overlay" > "$O/rendered.yaml"; grep 'image:' "$O/rendered.yaml"
ssh "${D[@]}" "apply" < "$O/rendered.yaml"
ssh "${D[@]}" "rollout-status qloo deployment/qloo-web 300"
```

The `grep` must print `image: oraculum/ambree-qloo:<T>`. With no Secret yet, the site serves demo mode.

## 4. Store the key

The key travels from the Mac Keychain over ssh stdin into `store-key.sh` on the host. It is never in a file, argv,
shell history or a log. The script itself goes in argv (it holds no secret). `KUBECTL` is the host's `k3s kubectl`:

```bash
security find-generic-password -s oraculum-qloo -a travelbook -w | ssh "${K[@]}" "sudo env KUBECTL='k3s kubectl' bash -c $(printf %q "$(cat deploy/store-key.sh)") store-key"
ssh "${K[@]}" 'sudo k3s kubectl -n qloo rollout restart deployment/qloo-web && sudo k3s kubectl -n qloo rollout status deployment/qloo-web --timeout=300s'
```

## 5. Verify

```bash
ssh "${K[@]}" 'sudo k3s kubectl -n qloo exec deploy/qloo-web -- node scripts/smoke.ts'
curl -s https://qloo.ambree.ai/healthz
```

The smoke run prints 3 `OK` lines, the Mauritius count and `RESULT: OK`, and exits 0. `FAIL MU check` means no
result had `country_code` MU; README "Check the live contract" says how to switch `MU_FILTER`.

Smoke searches one artist only. Then click the page's three example chips once, in live mode: the page should show no
"Qloo had no match for: …" line, and each turn under "Under the hood" should be badged "Live Qloo", not "Demo data".
An unmatched taste shows up in the pod log (`ssh "${K[@]}" 'sudo k3s kubectl -n qloo logs deploy/qloo-web'`) as
`qloo_no_match` with its endpoint, status and type (a 403 there means the key may not use that entity type).
`/healthz` then shows `"mode":"live"`; on its own that shows only that a key is set, not that it works.

## 6. Rollback to demo mode

```bash
ssh "${K[@]}" 'sudo k3s kubectl -n qloo delete secret qloo-api && sudo k3s kubectl -n qloo rollout restart deployment/qloo-web'
```

The pod comes back in demo mode. To take the site down instead:
`ssh "${K[@]}" 'sudo k3s kubectl -n qloo scale deployment/qloo-web --replicas=0'`. A failed image rollout:
`ssh "${D[@]}" "rollout-undo qloo deployment/qloo-web"`.

## Hosting window

Keep it up until judging ends (~5 Nov; possible live finals 1-5 Nov). Qloo deactivates hackathon keys after the
hackathon closes. A dead key answers 401/403, and each reply then falls back to labelled demo data on its own
(`notice: live_unavailable`), so the site needs no change when the key dies. Removal: delete the Deployment, Service,
Ingress and Secret in `qloo`, then the DNS record, then the monorepo's qloo block and gate entries
(monorepo `ops/oracle/README.md`, "Ambree taste planner").
