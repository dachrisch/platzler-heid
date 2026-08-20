import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AvailabilitySnapshot,
  BookingListAvailability,
  DateAvailability,
  PortalAvailability,
  PortalConfig,
  SelectOption,
} from "./types.js";
import { LivewireClient, parseSelectOptions } from "./livewire.js";

export interface ScrapeOptions {
  throttleMs?: number;
  maxRetries?: number;
  maxDates?: number;
  /** How many portals to scrape in parallel (default 2). */
  concurrency?: number;
  onProgress?: (message: string) => void;
  /** Called as soon as a single portal finishes, so results can be streamed. */
  onPortalResult?: (portal: PortalAvailability) => void;
}

function keepNonEmpty(options: SelectOption[]): SelectOption[] {
  return options.filter((o) => o.value !== "" && o.label !== "");
}

/**
 * Scrapes a single Festzelt OS portal:
 * 1. Loads the booking page and reads the available dates.
 * 2. For every date, selects it and reads the offered booking lists (time slots).
 * 3. For every booking list, selects it and reads the revealed options
 *    (seat-plan areas, pax counts, start times, ...).
 */
export async function scrapePortal(
  cfg: PortalConfig,
  opts: ScrapeOptions = {},
): Promise<PortalAvailability> {
  const jarDir = mkdtempSync(join(tmpdir(), "fza-jar-"));
  const cookieJar = join(jarDir, "cookies.txt");
  const progress = opts.onProgress ?? (() => {});
  const maxDates = opts.maxDates ?? cfg.maxDates;

  const result: PortalAvailability = {
    portalId: cfg.id,
    name: cfg.name,
    url: cfg.url,
    closed: true,
    dates: [],
  };

  try {
    const client = new LivewireClient(cfg, {
      cookieJar,
      throttleMs: opts.throttleMs ?? 600,
      maxRetries: opts.maxRetries ?? 5,
    });

    progress(`${cfg.name}: loading booking page …`);
    const initial = await client.init();
    result.bookingListGroupId = initial.bookingListGroupId;
    result.url = initial.url;

    const dateOptions = keepNonEmpty(initial.dateOptions);
    if (dateOptions.length === 0) {
      progress(`${cfg.name}: no bookable dates (portal closed or fully booked)`);
      return result;
    }

    result.closed = false;
    const datesToCheck = maxDates ? dateOptions.slice(0, maxDates) : dateOptions;

    for (const date of datesToCheck) {
      progress(`${cfg.name}: ${date.label} …`);
      const html = await client.selectDate(date.value);
      if (!html) continue;

      const bookingListOptions = keepNonEmpty(
        parseSelectOptions(html, "data.createBookingStepOneForm.booking_list_id"),
      );
      if (bookingListOptions.length === 0) {
        result.dates.push({ date: date.value, label: date.label, bookingLists: [] });
        continue;
      }

      const entry: DateAvailability = {
        date: date.value,
        label: date.label,
        bookingLists: [],
      };

      for (const bl of bookingListOptions) {
        const blHtml = await client.selectBookingList(bl.value);
        if (!blHtml) continue;
        const bookingList: BookingListAvailability = {
          id: bl.value,
          label: bl.label,
          seatplanGroups: keepNonEmpty(
            parseSelectOptions(blHtml, "data.createBookingStepOneForm.seatplan_group_id"),
          ),
          seatplanAreas: keepNonEmpty(
            parseSelectOptions(blHtml, "data.createBookingStepOneForm.seatplan_area_id"),
          ),
          paxOptions: keepNonEmpty(
            parseSelectOptions(blHtml, "data.createBookingStepOneForm.pax_options"),
          ),
          simplePax: keepNonEmpty(
            parseSelectOptions(blHtml, "data.createBookingStepOneForm.simple_pax_planned"),
          ),
          startTimes: keepNonEmpty(
            parseSelectOptions(blHtml, "data.createBookingStepOneForm.custom_start_time"),
          ),
        };
        entry.bookingLists.push(bookingList);
      }

      result.dates.push(entry);
    }

    result.fetchedAt = new Date().toISOString();
    progress(`${cfg.name}: done (${result.dates.length} dates)`);
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    progress(`${cfg.name}: failed — ${result.error}`);
    return result;
  } finally {
    rmSync(jarDir, { recursive: true, force: true });
  }
}

/**
 * Scrapes all configured portals with limited concurrency.
 */
export async function scrapeAll(
  portals: PortalConfig[],
  opts: ScrapeOptions = {},
): Promise<AvailabilitySnapshot> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const results: Array<PortalAvailability | undefined> = Array.from({
    length: portals.length,
  });

  let next = 0;
  async function worker(): Promise<void> {
    while (next < portals.length) {
      const idx = next++;
      const portal = await scrapePortal(portals[idx], opts);
      results[idx] = portal;
      opts.onPortalResult?.(portal);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, portals.length) }, worker);
  await Promise.all(workers);

  return {
    fetchedAt: new Date().toISOString(),
    portals: results.filter((r) => r !== undefined),
  };
}