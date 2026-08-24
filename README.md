# Festzelt Availability

Aggregates and displays table reservation availability from **Festzelt OS** reservation
portals — the booking system used by many Oktoberfest beer tents in Munich, e.g.
[Ochsenbraterei](https://reservierung.ochsenbraterei.de/reservierungen).

It queries each portal directly through the same Livewire/Filament protocol the
portals' own websites use, so it shows the **actual available options**: which dates
are open for booking, which time slots (e.g. *Mittag* / *Abend*), and which areas /
party sizes are offered.

## Portals covered

| Portal | URL |
| --- | --- |
| Ochsenbraterei | https://reservierung.ochsenbraterei.de/reservierungen |
| Paulaner Festzelt (Stiftl) | https://reservierung.paulanerfestzelt.de/reservierung |
| Hofbräu Festzelt | https://reservierung.hb-festzelt.de/reservierung |
| Volkssängerzelt Schützenlisl | https://reservierung.schuetzenlisl.de/ |
| Hochreiters zur Bratwurst | https://reservierung.zur-bratwurst.de/reservierung |
| Café Kaiserschmarrn | https://kaiserschmarrn.rischart.de/reservierung/ |
| Poschner's Hühnerbraterei | https://reservierung.poschners.de/ |
| Fischer Vroni | https://reservierung.fischer-vroni.de/reservation |
| Boandlkramerei | https://reservierung.boandlkramerei.bayern/ |
| Münchener Stubn Festzelt | https://reservierung.muenchnerstubn-festzelt.de/ |
| Armbrustschützen-Festzelt | https://reservierung.armbrustschuetzenzelt.de/reservierung |
| Bräurosl Festzelt | https://reservierung.braeurosl.de/reservation |
| Löwenbräu-Festzelt | https://reservierung.loewenbraeuzelt.de/reservierung |
| Hacker Festzelt | https://reservierung.derhimmelderbayern.de/reservierung |
| Augustiner Festhalle | https://reservierung.festhalle-augustiner.com/reservierung |
| Schützen-Festzelt | https://reservierung.schuetzenfestzelt.com/reservation |
| Festhalle Schottenhamel | https://reservierung.festhalle-schottenhamel.de/reservation |
| Kufflers Weinzelt | https://reservierung.weinzelt.com/reservation |

## How it works

Most portals use the Festzelt OS booking form (a Livewire/Filament component):

1. **Load** the portal's booking page and read the Livewire snapshot + CSRF token.
2. **Dates** are listed in the booking form's date select — only bookable dates appear.
3. For each date, the scraper selects it (a Livewire `updates` request to
   `/livewire/update`) and reads the offered **booking lists** (time slots).
4. For each booking list it selects it and reads the revealed **options**:
   seat-plan groups/areas, pax counts and start times.

A few newer portals (Schützen-Festzelt, Festhalle Schottenhamel, Kufflers Weinzelt)
are Nuxt SPAs without a server-rendered booking form. They expose a **Festzelt OS 2.0
JSON API** (`https://<tent>-api.festzelt-os.com/lp`) that the scraper queries instead:

1. `GET /guestlists` → available dates + time slots (shifts).
2. `GET /guestlists/{uid}/definitions` → offered areas per slot.

The API requires the portal's company UID via the `x-festzelt-os-Company` header.

All requests go through the `curl` binary: the portals sit behind Cloudflare bot
protection that rejects Node's TLS fingerprint, while curl with a browser user agent
passes. The scraper retries with backoff when a challenge is served.

## Requirements

- Node.js 20+
- `curl` on the `PATH`

## Usage

```sh
npm install

# Scrape all portals into data/availability.json
npm run scrape

# Scrape a single portal
npm run scrape -- --portal ochsenbraterei

# Serve the dashboard (http://localhost:3000)
npm run serve

# Build & run the production server
npm run build
npm start
```

### Webapp

The dashboard (`GET /`) shows all available reservations across every portal and lets
you filter by:

- **Festzelt** (tent) — multi-select
- **Datum von / bis** — date range
- **Zeit** — toggle chips for *Mittag*, *Nachmittag*, *Abend*, *Frühstück*, *Warm Up*
- **Bereich** (area) — multi-select
- **Suche** — free text across tent, date, time slot and area
- **Nur Wochenenden** toggle

Results are grouped by date and the active filters are mirrored to the URL, so a view
can be shared/bookmarked.

Clicking **Aktualisieren** triggers a live scrape whose results are **streamed** to the
browser via [Server-Sent Events](#api): each tent appears in the list as soon as it has
been scraped (`3/10 Festzelte …`), instead of waiting for the whole run.

### Scheduled scraping

The server can re-scrape on an interval and stream the fresh results to all open
browser tabs:

```sh
SCRAPE_INTERVAL_MIN=15 npm run serve
```

This scrapes once at startup and again every 15 minutes. The interval is shown in the
page footer. The CLI always writes to `data/availability.json`, so scheduled runs keep
the cache file fresh too.

### Server environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `THROTTLE_MS` | `600` | Delay between requests to a portal |
| `CONCURRENCY` | `2` | Portals scraped in parallel |
| `SCRAPE_INTERVAL_MIN` | `0` | Re-scrape interval in minutes (`0` disables) |

### CLI options

| Flag | Description |
| --- | --- |
| `--portal <id>` | Scrape only one portal |
| `--max-dates <n>` | Limit the number of dates checked per portal |
| `--out <path>` | Output file (default `data/availability.json`) |
| `--throttle <ms>` | Delay between requests (default 600 ms) |
| `--concurrency <n>` | Portals scraped in parallel (default 2) |

## API

The server exposes:

- `GET /` — dashboard UI
- `GET /api/availability` — last snapshot (JSON, updated live during a scrape)
- `GET /api/status` — scrape status / cache age / progress / schedule interval
- `GET /api/stream` — Server-Sent Events stream (`snapshot`, `started`, `portal`, `done`)
- `POST /api/refresh` — trigger a scrape; results are broadcast to all SSE clients

SSE event flow during a refresh:

```
event: started   data: {"at":"...","total":10}
event: portal    data: {"done":1,"total":10,"portal":{...}}   (repeated per tent)
event: done      data: {"fetchedAt":"..."}
```

On connect, a `snapshot` event with the current data is sent immediately so the view
renders instantly and only updates as new results stream in.

## Tests

```sh
npm test
```

## Data model

```jsonc
{
  "fetchedAt": "2026-08-20T...",
  "portals": [
    {
      "portalId": "ochsenbraterei",
      "name": "Ochsenbraterei",
      "url": "https://reservierung.ochsenbraterei.de/reservierungen",
      "closed": false,
      "dates": [
        {
          "date": "2026-09-21",
          "label": "Montag, 21.09.2026",
          "bookingLists": [
            {
              "id": "3060",
              "label": "Mittag",
              "seatplanGroups": [{ "value": "226", "label": "Innenraum" }],
              "seatplanAreas": [],
              "paxOptions": [],
              "simplePax": [],
              "startTimes": []
            }
          ]
        }
      ]
    }
  ]
}
```

## Disclaimer

This project reads publicly available reservation availability from the portal owners'
own websites. It does not book, buy, or resell anything, and it does not bypass any
paywall or authentication. Please respect the portals' terms of service.