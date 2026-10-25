# Notices

Ambree Taste Planner is MIT-licensed (see `LICENSE`). It bundles or uses the following.

## Code adapted from Ambree for Alexa+ (MIT)

The HTTP helpers (`src/http/`), the stateless MCP endpoint and SDK patches (`src/mcp/`), the speech
helpers (`src/tools/speech.ts`), the capped fetch (`src/qloo/fetch.ts`), the logger and the test helpers
are adapted from Ambree for Alexa+ (`ambree-alexa`), also MIT-licensed and by the same authors.

## Fonts (SIL Open Font License 1.1)

Self-hosted in `public/fonts/`, each with its licence file next to it:

- **Instrument Serif** (regular and italic): `public/fonts/OFL-InstrumentSerif.txt`
- **Instrument Sans**: `public/fonts/OFL-InstrumentSans.txt`
- **IBM Plex Mono**: `public/fonts/OFL-IBMPlexMono.txt`

## Qloo

Taste data comes from Qloo's API when a key is configured. This project is **not affiliated with or
endorsed by Qloo**. It uses no Qloo logo or mark; it says "powered by Qloo's API" in text only.

The repository holds **no Qloo response data**. `fixtures/qloo-demo.json` is hand-written, synthetic demo
data in the shape of Qloo's documented responses: every name ends in "(demo)" and every ID is in the
all-zero synthetic range. Live responses are cached only in process memory and are never written to disk.

## Brand

The Ambree name and logo (`public/favicon.svg`) belong to the Ambree authors. The MIT licence covers the
code, not the brand.
