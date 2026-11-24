# AGENTS.md

## What this repo is

Festzelt Availability (`festzelt-availability`) is a small Node.js/TypeScript tool
that aggregates and displays table-reservation availability from Festzelt OS
Oktoberfest beer-tent portals (Ochsenbraterei, Paulaner, Hofbräu, and others). It
reads each portal's public booking page through the same Livewire/Filament protocol
the portal uses, then exposes the results via a CLI scraper and an Express dashboard
with a JSON/SSE API. There are no separate deployable services — `src/` is the whole
app, `test/` holds its tests, and `data/` is generated output. This is a small, flat
repo, so it needs no per-directory guides.

## Requirements

- Node.js 20+
- `curl` on the `PATH` (all portal requests shell out to the curl binary because the
  portals' Cloudflare bot protection rejects Node's TLS fingerprint)

## Commands

Verified against `package.json` and `README.md`:

```sh
npm install             # install dependencies
npm run scrape          # scrape all portals into data/availability.json
npm run scrape -- --portal ochsenbraterei   # scrape one portal
npm run serve           # dev server / dashboard at http://localhost:3000
npm run dev             # same as serve, with tsx watch (auto-reload)
npm run build           # bundle src/server.ts -> dist-server/server.js (esbuild)
npm start               # run the built server
npm test                # run the vitest suite
npm run lint            # lint with oxlint
```

There is no `typecheck` script; `tsconfig.json` uses `noEmit: true` and strict mode.

## Safety and conventions

- **Never commit generated or secret files:** `data/*.json`, `dist-server/`,
  `node_modules/`, `.tmp/`, `*.log`, and `.env` are gitignored. Do not force-add them
  or put secrets in commits.
- **Keep scraping polite:** requests are rate-limited via `THROTTLE_MS` and
  `CONCURRENCY` (CLI: `--throttle` / `--concurrency`). Preserve these limits rather
  than hammering the portals.
- **Read-only by design:** this tool only reads publicly available reservation
  availability. It must not book, buy, or resell anything, and must not bypass
  authentication, paywalls, or bot challenges beyond the browser-like `curl` request
  already in use. Respect the portals' terms of service.
- **Docs-only changes:** keep edits scoped; do not modify code, config, workflows, or
  `package-lock.json` unless the task explicitly calls for it.
