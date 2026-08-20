import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import express from "express";
import { PORTALS } from "./config.js";
import { scrapeAll } from "./scraper.js";
import type { AvailabilitySnapshot, PortalAvailability } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolves to <project>/src/public both when run from source (tsx) and from
// the bundled build in dist-server/.
const PUBLIC_DIR = resolve(__dirname, "..", "src", "public");
const CACHE_FILE = resolve(process.cwd(), "data", "availability.json");

const PORT = Number(process.env.PORT ?? 3000);
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 600);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
// 0 disables the scheduler (scrape manually via the UI or POST /api/refresh).
const SCRAPE_INTERVAL_MIN = Number(process.env.SCRAPE_INTERVAL_MIN ?? 0);

interface ScrapeProgress {
  done: number;
  total: number;
  currentPortal: string | null;
}

let cache: AvailabilitySnapshot | null = null;
let liveSnapshot: AvailabilitySnapshot = { fetchedAt: "", portals: [] };
let scraping = false;
let lastError: string | null = null;
let scrapeProgress: ScrapeProgress = { done: 0, total: PORTALS.length, currentPortal: null };
const clients = new Set<ServerResponse>();

function loadCache(): AvailabilitySnapshot | null {
  if (existsSync(CACHE_FILE)) {
    try {
      return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as AvailabilitySnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

/* ---------------- SSE ---------------- */

function sendEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown): void {
  for (const res of clients) {
    try {
      sendEvent(res, event, data);
    } catch {
      /* client gone; cleaned up on close */
    }
  }
}

function handleStream(req: express.Request, res: express.Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  clients.add(res);
  sendEvent(res, "snapshot", currentSnapshot());

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

function currentSnapshot(): AvailabilitySnapshot {
  return liveSnapshot;
}

/* ---------------- Scraping ---------------- */

async function runScrape(): Promise<AvailabilitySnapshot> {
  if (scraping) throw new Error("scrape already in progress");
  scraping = true;
  lastError = null;
  scrapeProgress = { done: 0, total: PORTALS.length, currentPortal: null };
  liveSnapshot = { ...(cache ?? { fetchedAt: "", portals: [] }) };
  broadcast("started", { at: new Date().toISOString(), total: PORTALS.length });

  try {
    const snapshot = await scrapeAll(PORTALS, {
      throttleMs: THROTTLE_MS,
      concurrency: CONCURRENCY,
      onProgress: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
      onPortalResult: (portal: PortalAvailability) => {
        scrapeProgress.done += 1;
        scrapeProgress.currentPortal = portal.name;
        const others = liveSnapshot.portals.filter((p) => p.portalId !== portal.portalId);
        liveSnapshot = { fetchedAt: new Date().toISOString(), portals: [...others, portal] };
        broadcast("portal", {
          done: scrapeProgress.done,
          total: PORTALS.length,
          portal,
        });
      },
    });

    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(snapshot, null, 2));
    cache = snapshot;
    liveSnapshot = snapshot;
    scrapeProgress = { done: PORTALS.length, total: PORTALS.length, currentPortal: null };
    broadcast("done", { fetchedAt: snapshot.fetchedAt });
    return snapshot;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    broadcast("error", { message: lastError });
    throw err;
  } finally {
    scraping = false;
    scrapeProgress.currentPortal = null;
  }
}

async function start(): Promise<void> {
  const app = express();

  app.use(express.static(PUBLIC_DIR));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/availability", (_req, res) => {
    res.json(currentSnapshot());
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      scraping,
      lastError,
      cachedAt: currentSnapshot().fetchedAt ?? null,
      progress: scrapeProgress,
      scrapeIntervalMin: SCRAPE_INTERVAL_MIN,
    });
  });

  app.get("/api/stream", handleStream);

  app.post("/api/refresh", async (_req, res) => {
    if (scraping) {
      res.status(409).json({ error: "scrape already in progress" });
      return;
    }
    res.json({ status: "started" });
    runScrape().catch((err) => {
      console.error("scrape failed:", err);
    });
  });

  app.listen(PORT, () => {
    console.log(`Festzelt availability dashboard: http://localhost:${PORT}`);
    cache = loadCache();
    liveSnapshot = cache ?? { fetchedAt: "", portals: [] };

    const scheduled = SCRAPE_INTERVAL_MIN > 0;
    if (scheduled) {
      console.log(`Scheduled scraping every ${SCRAPE_INTERVAL_MIN} minutes`);
      runScrape().catch((err) => console.error("initial scrape failed:", err));
      setInterval(() => {
        if (!scraping) runScrape().catch((err) => console.error("scheduled scrape failed:", err));
      }, SCRAPE_INTERVAL_MIN * 60_000);
    } else if (!cache) {
      console.log("No cached availability found — starting initial scrape…");
      runScrape().catch((err) => {
        console.error("initial scrape failed:", err);
      });
    }
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});