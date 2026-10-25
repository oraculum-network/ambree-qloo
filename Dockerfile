# Ambree Taste Planner: a small image that runs TypeScript directly (Node 22 type stripping).
# Nothing writes to disk at runtime, so the root filesystem can be read-only.
# Built on the host, never on a laptop (see DEPLOY.md). The base is the same digest-pinned
# node:22-alpine as Ambree for Alexa+ (multi-arch index, linux/amd64 + arm64; resolved 2026-10-15).

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY fixtures ./fixtures
COPY scripts ./scripts
COPY LICENSE NOTICE.md ./
USER node
EXPOSE 8080
CMD ["node","src/server.ts"]
