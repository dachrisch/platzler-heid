import { curlRequest, isChallenge } from "./http.js";
import type {
  BookingListAvailability,
  DateAvailability,
  KaeferApiConfig,
  PortalAvailability,
  PortalConfig,
  SelectOption,
} from "./types.js";

export interface KaeferScrapeOptions {
  throttleMs?: number;
  maxRetries?: number;
  /** Maximum number of dates to check per run (undefined = all). */
  maxDates?: number;
  onProgress?: (message: string) => void;
}

interface KaeferSlot {
  slot_id: number;
  zeit_ID: number;
  /** Area name, e.g. "Haus innen". */
  bereich: string;
  /** Comma-separated table sizes still available in `bereich`, or null. */
  tische: string | null;
  /** Second area name, e.g. "Überdachter Freisitz". */
  bereich1: string;
  /** Table sizes still available in `bereich1`, or null. */
  tische1: string | null;
  /** ISO datetime of the reservation day, e.g. "2026-09-21T00:00:00". */
  rDatum: string;
  /** Shift start time, e.g. "11:30:00". */
  res_ab: string;
  /** Shift end time, e.g. "15:00:00". */
  res_bis: string;
}

/**
 * Scrapes the Käfer Wiesn-Schänke reservation portal.
 *
 * The portal is an Angular SPA (https://wiesnresmittag.kaefer-wiesn.de) backed by
 * a custom "iman" JSON API on Azure. It is unrelated to Festzelt OS:
 *
 *   GET {baseUrl}/api/slot  → all days × shifts, with the areas and table sizes
 *                             that still have availability (`tische` / `tische1`)
 *   POST {baseUrl}/api/reservierung → booking (not used, we only read availability)
 *
 * A slot whose areas both have `tische == null` is fully booked and is dropped.
 */
export async function scrapeKaefer(
  cfg: PortalConfig,
  opts: KaeferScrapeOptions = {},
): Promise<PortalAvailability> {
  const progress = opts.onProgress ?? (() => {});
  const result: PortalAvailability = {
    portalId: cfg.id,
    name: cfg.name,
    url: cfg.url,
    closed: true,
    dates: [],
  };

  const api = resolveKaeferConfig(cfg);
  if (!api) {
    result.error = "missing Käfer reservation API config";
    return result;
  }

  try {
    progress(`${cfg.name}: fetching slots …`);
    const slots = await fetchSlots(api, {
      throttleMs: opts.throttleMs ?? 600,
      maxRetries: opts.maxRetries ?? 5,
    });
    if (slots.length === 0) {
      progress(`${cfg.name}: no bookable dates (portal closed or fully booked)`);
      return result;
    }

    const byDate = new Map<string, KaeferSlot[]>();
    for (const slot of slots) {
      const date = (slot.rDatum ?? "").slice(0, 10);
      if (!date) continue;
      const bucket = byDate.get(date) ?? [];
      bucket.push(slot);
      byDate.set(date, bucket);
    }

    const maxDates = opts.maxDates ?? cfg.maxDates;
    const dates: DateAvailability[] = [];
    for (const date of [...byDate.keys()].sort()) {
      if (maxDates && dates.length >= maxDates) break;
      const dateSlots = byDate.get(date) ?? [];
      const bookingLists: BookingListAvailability[] = [];

      for (const slot of dateSlots) {
        const seatplanAreas: SelectOption[] = [];
        const simplePax: SelectOption[] = [];
        addArea(slot.bereich, slot.tische, seatplanAreas, simplePax);
        addArea(slot.bereich1, slot.tische1, seatplanAreas, simplePax);
        if (seatplanAreas.length === 0) continue;

        bookingLists.push({
          id: String(slot.slot_id),
          label: shiftLabel(slot),
          seatplanGroups: [],
          seatplanAreas,
          paxOptions: [],
          simplePax,
          startTimes: [{ value: slot.res_ab.slice(0, 5), label: slot.res_ab.slice(0, 5) }],
        });
      }

      if (bookingLists.length === 0) continue;
      dates.push({ date, label: formatDateLabel(date), bookingLists });
    }

    result.dates = dates;
    result.closed = dates.length === 0;
    result.fetchedAt = new Date().toISOString();
    progress(`${cfg.name}: done (${dates.length} dates)`);
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    progress(`${cfg.name}: failed — ${result.error}`);
    return result;
  }
}

/** Adds a Käfer area to the booking list if it still has table sizes available. */
function addArea(
  name: string,
  tische: string | null,
  seatplanAreas: SelectOption[],
  simplePax: SelectOption[],
): void {
  const pax = (tische ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (pax.length === 0) return;
  seatplanAreas.push({ value: name, label: name });
  for (const p of pax) {
    if (!simplePax.some((o) => o.value === p)) {
      simplePax.push({ value: p, label: `${p} Personen` });
    }
  }
}

/** Käfer offers two shifts: Mittag (from 11:30) and Nachmittag (from 15:30). */
function shiftLabel(slot: KaeferSlot): string {
  return (slot.res_ab ?? "").startsWith("11:") ? "Mittag" : "Nachmittag";
}

function resolveKaeferConfig(cfg: PortalConfig): KaeferApiConfig | undefined {
  const options = (cfg.scraper?.options ?? {}) as unknown as KaeferApiConfig;
  if (typeof options.baseUrl !== "string" || typeof options.apiKey !== "string") {
    return undefined;
  }
  return {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    appVersion: typeof options.appVersion === "string" ? options.appVersion : "1.0",
  };
}

async function fetchSlots(
  api: KaeferApiConfig,
  opts: { throttleMs: number; maxRetries: number },
): Promise<KaeferSlot[]> {
  const base = api.baseUrl.endsWith("/") ? api.baseUrl : api.baseUrl + "/";
  const url = new URL("api/slot", base).href;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      const res = await curlRequest(url, {
        cookieJar: "",
        throttleMs: opts.throttleMs,
        headers: {
          Accept: "application/vnd.iman.v1+json, application/json, text/plain, */*",
          "App-Version": api.appVersion ?? "1.0",
          "X-API-Key": api.apiKey,
        },
      });
      if (res.status === 200 && !isChallenge(res.body)) {
        const parsed = JSON.parse(res.body);
        return Array.isArray(parsed) ? (parsed as KaeferSlot[]) : [];
      }
      if (res.status === 403 || res.status === 429 || isChallenge(res.body)) {
        lastError = new Error("blocked by bot protection (" + res.status + ")");
        await sleep(3000 * (attempt + 1));
        continue;
      }
      lastError = new Error(`request failed (${res.status})`);
      if (res.status !== 404) break;
      await sleep(2000 * (attempt + 1));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("request failed");
}

function formatDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}