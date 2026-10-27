# Ambree Taste Planner

**A day in Mauritius from what you love, planned by Qloo's Taste AI.** An MCP server (Streamable HTTP, spec
2025-11-25) with three tools, plus a demo page that is itself an MCP client of the server.

Tell it a few tastes: an artist, a film, a book, a dish. Qloo resolves them to entities and tags, Qloo Insights
ranks real places on the island for those tastes, and the planner fills a morning, lunch, afternoon and evening
with distinct places, saying which of your tastes led to each one. Every reply has a `speech` field of at most two
sentences, written to be read aloud, plus the structured detail.

- **Site:** https://qloo.ambree.ai (planned; see `DEPLOY.md`)
- **MCP endpoint:** `https://qloo.ambree.ai/mcp` (open; no login)
- **Licence:** MIT (`LICENSE`); third-party notices in `NOTICE.md`

## The tools

| Tool | What it does | Qloo endpoints |
|---|---|---|
| `resolve_tastes` | 1 to 6 tastes (`music`, `film`, `tv`, `book`, `podcast`, `game`, `brand`, `person`, `place`, `food`) → Qloo entity IDs, or place tags for food. A taste Qloo can't match goes in `unresolved`, never guessed. | `GET /search`, `GET /v2/tags` |
| `rank_places` | Entity and tag signals (and an optional vibe such as "beach", and a town) → places or destinations in Mauritius ranked by Qloo affinity, with tags and the tastes each came from. | `GET /v2/tags`, `GET /v2/insights` |
| `plan_day` | The whole chain in one call: resolve → Insights for things to do, restaurants and bars → 4 stops (or 3 at a relaxed pace) in one region. Morning and afternoon are things to do (never a hotel), lunch a restaurant in your food taste, the evening a bar or restaurant (live music for a music taste). At most 10 Qloo calls. | all three |

All three are read-only (`readOnlyHint`) and open-world. Each result carries `mode` (`live` or `demo`), the Qloo
calls behind it (`qloo_calls`: endpoint, ms, cached) and `speech`.

## Why Qloo is essential

Without Qloo there is nothing to plan with. The server has no list of places of its own: every place in a live
reply comes from Qloo Insights (`filter.type=urn:entity:place`, `filter.geocode.country_code=MU`), ranked by Qloo's
affinity for the traveller's own signals (`signal.interests.entities` from `/search`, `signal.interests.tags` from
`/v2/tags`, the food tag on the meal calls only). Qloo's tags decide what each place is: `filter.tags` asks for
things to do (`urn:tag:category:place:tourist_attraction`), restaurants (`urn:tag:genre:place:restaurant`) and bars
(`urn:tag:category:place:bar`); `properties.primary_genre` keeps hotels out of the sights; a cuisine tag such as
`urn:tag:cuisine:qloo:seafood` picks lunch. Qloo's `filter.location` keeps the day within 15 km of the first stop.
Each stop's "why" is built from what Qloo returned for it: whose fans tend to like it (the taste Qloo's
`feature.explainability` credits most, when it sends one), its rank in that list, and the tag that matched a taste.
Without a key the app does not pretend: it switches to clearly labelled synthetic demo data.

## Run it locally (no key needed)

Node 22.18 or later (it runs TypeScript directly).

```bash
npm ci
npm start
```

Then open http://localhost:8080. With no `QLOO_API_KEY` it runs in **demo mode**: the page shows a "Demo data:
synthetic, not from Qloo" banner, every place is invented and named "… (demo)", and every spoken reply ends with
"This uses demo data, not live Qloo results." Nothing leaves the machine.

For live mode, put the key in the environment (it is read only by the server and sent only in the `X-Api-Key`
header to `QLOO_API_BASE`), then start the server.

## Connect an MCP client

Any MCP client that speaks Streamable HTTP can connect to `/mcp`. For example, with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP" and URL `https://qloo.ambree.ai/mcp` (or `http://localhost:8080/mcp`), then call
`plan_day` with `{"tastes":[{"kind":"music","name":"Bob Marley"},{"kind":"food","name":"seafood"}]}`.

The server is stateless: each POST is answered on its own, so a raw JSON-RPC `tools/call` works without a session.
Send `Accept: application/json, text/event-stream` and `MCP-Protocol-Version: 2025-11-25`.

## Configuration

Every value is optional. Empty counts as unset.

| Env | Default | What it does |
|---|---|---|
| `PORT` | `8080` | HTTP port (`0` = any free port) |
| `HOST` | all interfaces | Bind address |
| `PUBLIC_ORIGIN` | `http://localhost:<port>` | The site's origin, e.g. `https://qloo.ambree.ai`; browser requests from other origins are refused |
| `ALLOWED_ORIGINS` | none | Extra allowed origins, comma-separated |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front (1 behind Traefik), for per-IP rate limits |
| `RATE_LIMIT_SCALE` | `1` | Multiplies the `/mcp` limit (120 a minute, burst 30, per IP) |
| `QLOO_API_KEY` | unset = demo mode | The Qloo hackathon key. Never logged, never sent to the page |
| `QLOO_API_BASE` | `https://hackathon.api.qloo.com` | Qloo base URL; must be https (plain http only for a loopback test server) |
| `QLOO_DAILY_CALLS` | `3000` | Live Qloo calls a day (cache hits don't count); past it, replies fall back to labelled demo data |
| `QLOO_CLIENT_DAILY_CALLS` | `300` | Live Qloo calls a day for one client (per IP, IPv6 per /64), so one client can't use up `QLOO_DAILY_CALLS`; past it, that client's replies fall back to labelled demo data |

## Demo mode and live mode

| | Demo (no key) | Live (key set) |
|---|---|---|
| Data | `fixtures/qloo-demo.json`: hand-written, synthetic, in the shape of Qloo's documented responses | Qloo's API |
| Outbound calls | none | `GET /search`, `/v2/tags`, `/v2/insights` with `X-Api-Key` |
| Page | "Demo data" banner | no banner |
| Speech | always ends "This uses demo data, not live Qloo results." | never says demo |

If live access fails with 401 or 403 (a wrong or expired key) or the daily cap is reached, that one reply falls back
to demo data and says so: `notice: "live_unavailable"`, and the speech ends "Live Qloo access isn't available right
now, so this uses demo data." Other failures (429, 5xx, timeouts) are spoken errors, never invented places.

## Check the live contract: `npm run smoke`

Once a key exists:

```bash
npm run smoke
```

It asks for the key at a hidden prompt (or reads `QLOO_API_KEY` from the environment, or one line on stdin; never
from the command line). It makes exactly three calls, one per endpoint, checks each response against the contract
in `src/qloo/contract.ts`, and prints `OK` lines or the exact mismatched paths, how many results are in Mauritius,
and which optional place fields appeared. It never prints bodies, names, headers or the key, and writes no files.
Exit codes: 0 all OK, 1 a mismatch, an HTTP error or a failed Mauritius check, 2 no key or bad config.

`FAIL MU check` means no insights result had `country_code` MU: Qloo ignored the country filter, or gives places no
country code. Smoke sends the app's own filter, `MU_FILTER` in `src/tools/rank-places.ts`. To try the other one, set
it to `MU_BY_LOCATION` (`filter.location.query=Mauritius`), run `npm test`, then rerun smoke.

## Data policy

- **No Qloo response data in this repo.** The fixtures are invented: every name ends "(demo)", every ID is in the
  all-zero range `00000000-0000-4000-8000-…`, and every tag name ends "(demo)". Tags carry Qloo's public taxonomy
  IDs (such as `urn:tag:category:place:beach`) so demo runs the same classification code as live. A test checks that
  no example from Qloo's docs appears in them.
- Live responses are cached **in process memory only** (6 hours, 500 entries) and never written to disk.
- Logs record route, status, timings, mode and tool names; never what people type, replies, IPs or the key.
- Qloo results describe aggregate affinities; they are not evidence of a person's identity, preferences or future
  behaviour.

## Tests

```bash
npm test             # unit, contract, MCP conformance, transport, smoke and deploy-script tests; offline
npm run typecheck
npx playwright test  # the demo page in Chromium, demo mode
```

Every test stubs the network: Qloo is a local mock server or the fixtures. Tests build their config from explicit
env objects and spawned processes get an environment without `QLOO_*`, so a key exported in your shell can't make a
test call Qloo.

## Layout

```
src/server.ts          entry point (the only reader of process.env)
src/app.ts             HTTP routes: POST /mcp, GET /healthz, static page
src/mcp/               MCP server, stateless Streamable HTTP endpoint, icons
src/tools/             resolve_tastes, rank_places, plan_day, speech rules
src/qloo/              contract (zod), live client, cache, capped fetch, demo fixtures transport
fixtures/              synthetic demo data
public/                the demo page (an MCP client; no build step)
scripts/smoke.ts       npm run smoke
deploy/                k8s manifests and the key-storing script; see DEPLOY.md
```

## Limitations

- Coverage of Mauritius in Qloo's graph is unknown until the first live run; the planner says so when Qloo finds no
  places rather than inventing any.
- Qloo's documentation describes `query.explainability` but shows no example; the reader is lenient, and a stop
  without it says "A strong Qloo match for your tastes."
- There is no language model in the loop. The MCP server is the agentic tool: any MCP client or agent can call it,
  and `plan_day` does the orchestration itself.
- Slots are assigned by tag keywords (restaurant, cafe and food for lunch; bar, restaurant and music for the
  evening), not by opening hours or travel time.

## Licence

MIT, © 2026 The Ambree authors. Not affiliated with or endorsed by Qloo; "Qloo" is used only to name the API this
project calls.
