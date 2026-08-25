import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import express from "express";
import { PORTALS } from "./config.js";
import { scrapeAll } from "./scraper.js";
import type { AvailabilitySnapshot, PortalAvailability } from "./types.js";
import { createEmailSender, type EmailSender } from "./email.js";
import {
  SubscriberStore,
  buildConfirmationEmail,
  buildNotificationEmail,
  diffOptions,
  flatten,
  type SubscriptionFilter,
} from "./subscriptions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolves to <project>/src/public both when run from source (tsx) and from
// the bundled build in dist-server/.
const PUBLIC_DIR = resolve(__dirname, "..", "src", "public");
const CACHE_FILE = resolve(process.cwd(), "data", "availability.json");
const SUBSCRIBERS_FILE = resolve(process.cwd(), "data", "subscribers.json");

const PORT = Number(process.env.PORT ?? 3000);
const THROTTLE_MS = Number(process.env.THROTTLE_MS ?? 600);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 2);
// 0 disables the scheduler (scrape manually via the UI or POST /api/refresh).
const SCRAPE_INTERVAL_MIN = Number(process.env.SCRAPE_INTERVAL_MIN ?? 0);
// Base URL for links in notification emails (dashboard + unsubscribe).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

const emailSender: EmailSender = createEmailSender();
const subscribers = new SubscriberStore(SUBSCRIBERS_FILE);

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
  const previous = cache;
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
    if (previous) notifySubscribers(previous, snapshot);
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

/* ---------------- Email notifications ---------------- */

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

function normalizeFilter(raw: unknown): SubscriptionFilter {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    tents: strArray(f.tents),
    shifts: strArray(f.shifts),
    areas: strArray(f.areas),
    from: typeof f.from === "string" ? f.from : "",
    to: typeof f.to === "string" ? f.to : "",
    weekend: f.weekend === true,
    search: typeof f.search === "string" ? f.search : "",
  };
}

function notifySubscribers(prev: AvailabilitySnapshot, cur: AvailabilitySnapshot): void {
  const prevOptions = flatten(prev);
  const curOptions = flatten(cur);
  for (const sub of subscribers.list()) {
    if (sub.status !== "active") continue;
    try {
      const diff = diffOptions(prevOptions, curOptions, sub.filter);
      if (!diff.added.length && !diff.removed.length) continue;
      const { subject, text, html } = buildNotificationEmail({
        filter: sub.filter,
        diff,
        baseUrl: PUBLIC_BASE_URL,
        token: sub.token,
      });
      emailSender.send(sub.email, subject, text, html).catch((err) => {
        console.error(`Failed to send notification to ${sub.email}:`, err);
      });
    } catch (err) {
      console.error(`Failed to build notification for ${sub.email}:`, err);
    }
  }
}

async function start(): Promise<void> {
  const app = express();

  app.use(express.json());
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

  app.post("/api/subscribe", (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: "invalid email" });
      return;
    }
    const filter = normalizeFilter(req.body?.filter);
    // Reuse a pending subscription for the same address so resubmitting resends
    // the confirmation email instead of piling up duplicates.
    const pending = subscribers.pendingByEmail(email);
    if (pending) pending.filter = filter;
    const sub = pending ?? subscribers.add(email, filter);
    const { subject, text, html } = buildConfirmationEmail({
      filter: sub.filter,
      baseUrl: PUBLIC_BASE_URL,
      confirmToken: sub.confirmToken,
      token: sub.token,
    });
    emailSender.send(sub.email, subject, text, html).catch((err) => {
      console.error(`Failed to send confirmation email to ${sub.email}:`, err);
    });
    res.json({ id: sub.id, status: "pending" });
  });

  app.get("/api/confirm", (req, res) => {
    const token = String(req.query.token ?? "");
    const sub = subscribers.confirmByToken(token);
    res.type("html").send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>${sub ? "Bestätigt" : "Ungültiger Link"}</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#1c1917">
<h1>${sub ? "Abonnement bestätigt ✓" : "Ungültiger Bestätigungslink."}</h1>
<p style="color:#78716c">${sub ? "Du erhältst ab jetzt eine E-Mail bei Änderungen an deinen gespeicherten Filtern." : ""}</p>
<p><a href="${PUBLIC_BASE_URL}/">Zur Ansicht</a></p>
</body></html>`);
  });

  app.get("/api/unsubscribe", (req, res) => {
    const token = String(req.query.token ?? "");
    const removed = subscribers.removeByToken(token);
    res.type("html").send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Abgemeldet</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center;color:#1c1917">
<h1>${removed ? "Du wurdest abgemeldet." : "Ungültiger Abmeldelink."}</h1>
<p style="color:#78716c">${removed ? "Du erhältst ab jetzt keine E-Mail-Benachrichtigungen mehr." : ""}</p>
</body></html>`);
  });

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