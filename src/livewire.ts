import { curlRequest, isChallenge, type HttpResponse } from "./http.js";
import type { PortalConfig, SelectOption } from "./types.js";

/** Decodes HTML entity escaping found inside the wire:snapshot attribute. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export interface InitialPageState {
  csrf: string;
  snapshot: string;
  componentId: string;
  dateOptions: SelectOption[];
  bookingListGroupId?: string;
  url: string;
}

export interface LivewireUpdateResult {
  snapshot: string;
  html?: string;
}

export interface LivewireClientOptions {
  throttleMs?: number;
  maxRetries?: number;
  cookieJar: string;
}

/**
 * Minimal driver for the Livewire 3 / Filament protocol used by Festzelt OS
 * reservation portals.
 *
 * A single page load yields a `wire:snapshot` JSON attribute plus a CSRF token.
 * Model changes are pushed back to `/livewire/update` via the `updates` field;
 * every response carries a fresh snapshot that must be used for the next call.
 */
export class LivewireClient {
  private readonly options: Required<LivewireClientOptions>;
  private csrf = "";
  private snapshot: string | null = null;
  private readonly cookieJar: string;
  private url: string;

  constructor(
    private readonly portal: PortalConfig,
    options: LivewireClientOptions,
  ) {
    this.options = {
      throttleMs: options.throttleMs ?? 600,
      maxRetries: options.maxRetries ?? 5,
      cookieJar: options.cookieJar,
    };
    this.cookieJar = options.cookieJar;
    this.url = portal.url;
  }

  get currentUrl(): string {
    return this.url;
  }

  private async getWithRetry(url: string): Promise<HttpResponse> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const res = await curlRequest(url, {
          cookieJar: this.cookieJar,
          throttleMs: this.options.throttleMs,
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
          },
        });
        if (res.status === 200 && !isChallenge(res.body)) return res;
        if (res.status === 429 || res.status === 403 || isChallenge(res.body)) {
          lastError = new Error("blocked by Cloudflare/bot protection (" + res.status + ")");
          await sleep(3000 * (attempt + 1));
          continue;
        }
        return res;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleep(2000 * (attempt + 1));
      }
    }
    throw lastError ?? new Error("request failed");
  }

  /** Loads the booking page and extracts the initial Livewire state. */
  async init(): Promise<InitialPageState> {
    let res = await this.getWithRetry(this.url);
    let page = res.body;
    let tries = 0;

    while (!page.includes("createBookingStepOneForm") && tries < 3) {
      const link = findBookingLink(page);
      if (!link) break;
      const next = new URL(link, this.url).href;
      res = await this.getWithRetry(next);
      page = res.body;
      this.url = next;
      tries++;
    }

    if (!page.includes("createBookingStepOneForm")) {
      throw new Error("no booking form found on " + this.url);
    }

    const csrf =
      page.match(/name="csrf-token"\s+content="([^"]+)"/)?.[1] ??
      page.match(/data-csrf="([^"]+)"/)?.[1];
    if (!csrf) throw new Error("could not find CSRF token");

    const found = findSnapshotAttr(page);
    const snapshot = decodeEntities(found.value);
    let bookingListGroupId: string | undefined;
    try {
      bookingListGroupId = extractBookingListGroupId(JSON.parse(snapshot));
    } catch {
      // snapshot is still usable without introspection
    }

    this.csrf = csrf;
    this.snapshot = snapshot;

    return {
      csrf,
      snapshot,
      componentId: found.componentId,
      dateOptions: parseSelectOptions(page, "data.createBookingStepOneForm.date"),
      bookingListGroupId,
      url: this.url,
    };
  }

  /** Pushes Livewire model updates; returns the re-rendered component HTML. */
  async update(updates: Record<string, string>): Promise<LivewireUpdateResult> {
    if (!this.snapshot) throw new Error("init() must be called first");
    const body = JSON.stringify({
      _token: this.csrf,
      components: [
        {
          snapshot: this.snapshot,
          updates,
          calls: [],
        },
      ],
    });
    const res = await curlRequest(new URL("/livewire/update", this.url).href, {
      cookieJar: this.cookieJar,
      throttleMs: this.options.throttleMs,
      headers: {
        Accept: "text/html, application/xhtml+xml, application/json",
        "X-CSRF-TOKEN": this.csrf,
        "X-Livewire": "1",
      },
      body,
    });

    if (res.status === 419) throw new Error("Livewire session expired (419)");
    if (res.status !== 200) throw new Error("livewire update failed (" + res.status + ")");
    if (isChallenge(res.body)) throw new Error("Cloudflare challenge during update");

    const parsed = JSON.parse(res.body) as {
      components: Array<{ snapshot: string; effects?: { html?: string } }>;
    };
    const comp = parsed.components[0];
    this.snapshot = comp.snapshot;
    return { snapshot: comp.snapshot, html: comp.effects?.html };
  }

  async selectDate(date: string): Promise<string | undefined> {
    const result = await this.update({ "data.createBookingStepOneForm.date": date });
    return result.html;
  }

  async selectBookingList(bookingListId: string): Promise<string | undefined> {
    const result = await this.update({
      "data.createBookingStepOneForm.booking_list_id": bookingListId,
    });
    return result.html;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractBookingListGroupId(snapshot: unknown): string | undefined {
  const walk = (node: unknown): string | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const r = walk(item);
        if (r !== undefined) return r;
      }
      return undefined;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (typeof obj.booking_list_group_id === "number") {
        return String(obj.booking_list_group_id);
      }
      for (const value of Object.values(obj)) {
        const r = walk(value);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  };
  return walk(snapshot);
}

export function findSnapshotAttr(html: string): { componentId: string; value: string } {
  const idx = html.indexOf("createBookingStepOneForm");
  const open = html.lastIndexOf("<div", idx);
  if (open === -1) throw new Error("no component div found");
  const tag = html.slice(open, html.indexOf(">", open) + 1);
  const componentId = tag.match(/wire:id="([^"]+)"/)?.[1] ?? "";
  const value = tag.match(/wire:snapshot="([^"]*)"/)?.[1] ?? "";
  if (!value) throw new Error("no wire:snapshot found");
  return { componentId, value };
}

export function parseSelectOptions(html: string, selectId: string): SelectOption[] {
  const re = new RegExp(
    "<select[^>]*id=[\"']" + escapeRegExp(selectId) + "[\"'][^>]*>([^]*?)</select>",
  );
  const m = html.match(re);
  if (!m) return [];
  const options: SelectOption[] = [];
  const optionRe = /<option\s+value="([^"]*)"[^>]*>([^]*?)<\/option>/g;
  let om: RegExpExecArray | null;
  while ((om = optionRe.exec(m[1]))) {
    const label = om[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    options.push({ value: om[1], label });
  }
  return options;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findBookingLink(html: string): string | null {
  const hrefs: string[] = [];
  const linkRe = /<a[^>]+href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) hrefs.push(m[1]);
  const booking = hrefs.find((href) =>
    /\/?(reservierung|reservation|reservations|booking|reservieren)(\/|$|[?#])/i.test(href),
  );
  return booking ?? null;
}