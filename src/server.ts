import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { PORTALS } from "./config.js";
import { scrapeAll } from "./scraper.js";
import type { AvailabilitySnapshot } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolves to <project>/src/public both when run from source (tsx) and from
// the bundled build in dist-server/.
const PUBLIC_DIR = resolve(__dirname, "..", "src", "public");
const CACHE_FILE = resolve(process.cwd(), "data", "availability.json");

const PORT = Number(process.env.PORT ?? 3000);
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 600);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);

let cache: AvailabilitySnapshot | null = null;
let scraping = false;
let lastError: string | null = null;

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

async function runScrape(): Promise<AvailabilitySnapshot> {
  if (scraping) throw new Error("scrape already in progress");
  scraping = true;
  try {
    const snapshot = await scrapeAll(PORTALS, {
      throttleMs: THROTTLE_MS,
      concurrency: CONCURRENCY,
      onProgress: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
    });
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(snapshot, null, 2));
    cache = snapshot;
    lastError = null;
    return snapshot;
  } finally {
    scraping = false;
  }
}

async function start(): Promise<void> {
  const app = express();

  app.use(express.static(PUBLIC_DIR));

  app.get("/api/availability", (_req, res) => {
    res.json(cache ?? loadCache() ?? { fetchedAt: null, portals: [] });
  });

  app.get("/api/status", (_req, res) => {
    res.json({ scraping, lastError, cachedAt: (cache ?? loadCache())?.fetchedAt ?? null });
  });

  app.post("/api/refresh", async (_req, res) => {
    if (scraping) {
      res.status(409).json({ error: "scrape already in progress" });
      return;
    }
    res.json({ status: "started" });
    runScrape().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("scrape failed:", lastError);
    });
  });

  app.listen(PORT, () => {
    console.log(`Festzelt availability dashboard: http://localhost:${PORT}`);
    cache = loadCache();
    if (!cache) {
      console.log("No cached availability found — starting initial scrape…");
      runScrape().catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        console.error("initial scrape failed:", lastError);
      });
    }
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});