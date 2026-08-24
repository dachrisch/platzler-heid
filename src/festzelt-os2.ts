import { curlRequest, isChallenge } from "./http.js";
import type {
  BookingListAvailability,
  DateAvailability,
  PortalAvailability,
  PortalConfig,
} from "./types.js";

export interface FestzeltOs2Options {
  throttleMs?: number;
  maxRetries?: number;
  /** Maximum number of dates to check per run (undefined = all). */
  maxDates?: number;
  /** How many booking lists (guest lists) to check in parallel. */
  concurrency?: number;
  onProgress?: (message: string) => void;
}

interface GuestList {
  name: string;
  date: string;
  uid: string;
  shift: { id: number; label: string } | null;
  use_seatplan_in_public: boolean;
}

interface GuestListResponse {
  meta: { curTime: string };
  pagination: { total: number; current: number; perPage: number; pages: number };
  data: GuestList[];
}

interface DefinitionsResponse {
  status?: number;
  data: { areas?: Array<{ id: number; label: string; start?: string; end?: string }> };
}

/**
 * Scrapes a Festzelt OS 2.0 portal through its landing-page JSON API.
 *
 * These portals (e.g. Schützen-Festzelt, Festhalle Schottenhamel, Kufflers
 * Weinzelt) are Nuxt SPAs with no server-rendered booking form, so the
 * Livewire protocol doesn't apply. Instead they expose a JSON API:
 *
 *   GET {baseUrl}/guestlists                      → available dates + shifts
 *   GET {baseUrl}/guestlists/{uid}/definitions    → offered areas per guest list
 *
 * Both require the `x-festzelt-os-Company` header with the portal's company UID.
 */
export async function scrapeFestzeltOs2(
  cfg: PortalConfig,
  opts: FestzeltOs2Options = {},
): Promise<PortalAvailability> {
  const progress = opts.onProgress ?? (() => {});
  const throttleMs = opts.throttleMs ?? 600;
  const maxRetries = opts.maxRetries ?? 5;
  const concurrency = Math.max(1, opts.concurrency ?? 2);

  const result: PortalAvailability = {
    portalId: cfg.id,
    name: cfg.name,
    url: cfg.url,
    closed: true,
    dates: [],
  };

  if (!cfg.api) {
    result.error = "missing Festzelt OS 2.0 API config";
    return result;
  }

  try {
    const lists = await fetchAllGuestLists(cfg, { throttleMs, maxRetries });
    if (lists.length === 0) {
      progress(`${cfg.name}: no bookable dates (portal closed or fully booked)`);
      return result;
    }

    result.closed = false;

    const byDate = new Map<string, GuestList[]>();
    for (const gl of lists) {
      const date = (gl.date ?? "").slice(0, 10);
      if (!date) continue;
      const bucket = byDate.get(date) ?? [];
      bucket.push(gl);
      byDate.set(date, bucket);
    }

    const maxDates = opts.maxDates ?? cfg.maxDates;
    if (maxDates && byDate.size > maxDates) {
      const sortedDates = [...byDate.keys()].sort();
      for (const d of sortedDates.slice(maxDates)) byDate.delete(d);
    }

    const selectedLists = [...byDate.values()].flat();
    const results: DateAvailability[] = [];
    let next = 0;
    async function worker(): Promise<void> {
      while (next < selectedLists.length) {
        const gl = selectedLists[next++];
        const date = (gl.date ?? "").slice(0, 10);
        if (!date) continue;
        progress(`${cfg.name}: ${date} · ${gl.shift?.label ?? gl.name} …`);
        const definitions = await fetchDefinitions(cfg, gl.uid, { throttleMs, maxRetries });
        const bookingList: BookingListAvailability = {
          id: gl.uid,
          label: gl.shift?.label ?? gl.name,
          seatplanGroups: [],
          seatplanAreas: (definitions?.areas ?? []).map((a) => ({
            value: String(a.id),
            label: a.label,
          })),
          paxOptions: [],
          simplePax: [],
          startTimes: [],
        };

        const existing = results.find((d) => d.date === date);
        if (existing) {
          existing.bookingLists.push(bookingList);
        } else {
          results.push({
            date,
            label: formatDateLabel(date),
            bookingLists: [bookingList],
          });
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, byDate.size) },
      () => worker(),
    );
    await Promise.all(workers);

    // Keep dates ordered by date.
    results.sort((a, b) => a.date.localeCompare(b.date));
    result.dates = results;
    result.fetchedAt = new Date().toISOString();
    progress(`${cfg.name}: done (${result.dates.length} dates)`);
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    progress(`${cfg.name}: failed — ${result.error}`);
    return result;
  }
}

async function fetchAllGuestLists(
  cfg: PortalConfig,
  opts: { throttleMs: number; maxRetries: number },
): Promise<GuestList[]> {
  const lists: GuestList[] = [];
  let page = 1;
  let pages = 1;
  do {
    const body = await getJson<GuestListResponse>(cfg, `/guestlists?page=${page}`, opts);
    if (Array.isArray(body?.data)) lists.push(...body.data);
    pages = body?.pagination?.pages ?? 1;
    page++;
  } while (page <= pages);
  return lists;
}

async function fetchDefinitions(
  cfg: PortalConfig,
  uid: string,
  opts: { throttleMs: number; maxRetries: number },
): Promise<DefinitionsResponse["data"] | undefined> {
  const body = await getJson<DefinitionsResponse>(cfg, `/guestlists/${uid}/definitions`, opts);
  return body?.data;
}

async function getJson<T>(
  cfg: PortalConfig,
  path: string,
  opts: { throttleMs: number; maxRetries: number },
): Promise<T> {
  const api = cfg.api!;
  const base = api.baseUrl.endsWith("/") ? api.baseUrl : api.baseUrl + "/";
  const url = new URL(path.replace(/^\//, ""), base).href;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      const res = await curlRequest(url, {
        cookieJar: "",
        throttleMs: opts.throttleMs,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          "x-festzelt-os-Company": api.companyUid,
        },
      });
      if (res.status === 200 && !isChallenge(res.body)) {
        return JSON.parse(res.body) as T;
      }
      if (res.status === 403 || res.status === 429 || isChallenge(res.body)) {
        lastError = new Error("blocked by Cloudflare/bot protection (" + res.status + ")");
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