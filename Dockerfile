# syntax=docker/dockerfile:1
#
# Single container that serves the Express/TypeScript dashboard (see
# src/server.ts). The scraper shells out to the `curl` binary (the portals sit
# behind Cloudflare bot protection that rejects Node's TLS fingerprint), so
# curl is installed in the runtime image.

# ---- deps: install all dependencies (incl. dev) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build: bundle backend with esbuild ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- prod-deps: production-only dependencies (no typescript/vitest/etc) ----
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime: slim image with only what's needed to run the server ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# curl is required by the scraper (src/http.ts shells out to it).
RUN apk add --no-cache curl

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=build /app/dist-server ./dist-server
COPY src/public ./src/public

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1 || exit 1

USER node
CMD ["node", "dist-server/server.js"]
