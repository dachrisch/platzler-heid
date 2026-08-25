import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AvailabilitySnapshot } from "./types.js";

/** Serialized filter state, mirroring the dashboard's URL filter params. */
export interface SubscriptionFilter {
  tents: string[];
  shifts: string[];
  areas: string[];
  from: string;
  to: string;
  weekend: boolean;
  search: string;
}

export type SubscriptionStatus = "pending" | "active";

export interface Subscription {
  id: string;
  email: string;
  /** Unsubscribe token — embedded in the unsubscribe link of every email. */
  token: string;
  /** Confirmation token — embedded in the double opt-in confirmation email. */
  confirmToken: string;
  /**
   * Double opt-in status. Subscriptions start as "pending" and only become
   * "active" once the user confirms their email address (required by law).
   */
  status: SubscriptionStatus;
  filter: SubscriptionFilter;
  createdAt: string;
}

export interface AvailabilityOption {
  portalId: string;
  portalName: string;
  portalUrl: string;
  date: string;
  dateLabel: string;
  shift: string;
  areas: string[];
  pax: string[];
  startTimes: string[];
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function flatten(snapshot: AvailabilitySnapshot): AvailabilityOption[] {
  const out: AvailabilityOption[] = [];
  for (const p of snapshot.portals ?? []) {
    if (p.closed || p.error) continue;
    for (const d of p.dates ?? []) {
      for (const bl of d.bookingLists ?? []) {
        out.push({
          portalId: p.portalId,
          portalName: p.name,
          portalUrl: p.url,
          date: d.date,
          dateLabel: d.label,
          shift: bl.label,
          areas: dedupe([...(bl.seatplanGroups ?? []), ...(bl.seatplanAreas ?? [])].map((x) => x.label)),
          pax: dedupe([...(bl.paxOptions ?? []), ...(bl.simplePax ?? [])].map((x) => x.label)),
          startTimes: dedupe((bl.startTimes ?? []).map((x) => x.label)),
        });
      }
    }
  }
  out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.portalName.localeCompare(b.portalName) ||
      a.shift.localeCompare(b.shift),
  );
  return out;
}

export function isWeekend(isoDate: string): boolean {
  const day = new Date(isoDate + "T12:00:00").getUTCDay();
  return day === 0 || day === 6;
}

export function matches(o: AvailabilityOption, f: SubscriptionFilter): boolean {
  if (f.tents.length && !f.tents.includes(o.portalId)) return false;
  if (f.shifts.length && !f.shifts.includes(o.shift)) return false;
  if (f.areas.length && !o.areas.some((a) => f.areas.includes(a))) return false;
  if (f.from && o.date < f.from) return false;
  if (f.to && o.date > f.to) return false;
  if (f.weekend && !isWeekend(o.date)) return false;
  if (f.search) {
    const hay = `${o.portalName} ${o.dateLabel} ${o.shift} ${o.areas.join(" ")} ${o.pax.join(" ")}`.toLowerCase();
    if (!hay.includes(f.search.toLowerCase())) return false;
  }
  return true;
}

export function optionKey(o: AvailabilityOption): string {
  return [
    o.portalId,
    o.date,
    o.shift,
    [...o.areas].sort().join(","),
    [...o.pax].sort().join(","),
    [...o.startTimes].sort().join(","),
  ].join("|");
}

export interface OptionDiff {
  added: AvailabilityOption[];
  removed: AvailabilityOption[];
}

/** Entries in `cur` that match the filter but weren't in `prev` (and vice versa). */
export function diffOptions(
  prev: AvailabilityOption[],
  cur: AvailabilityOption[],
  filter: SubscriptionFilter,
): OptionDiff {
  const prevMap = new Map<string, AvailabilityOption>();
  for (const o of prev) if (matches(o, filter)) prevMap.set(optionKey(o), o);
  const curMap = new Map<string, AvailabilityOption>();
  for (const o of cur) if (matches(o, filter)) curMap.set(optionKey(o), o);

  const added: AvailabilityOption[] = [];
  for (const [k, o] of curMap) if (!prevMap.has(k)) added.push(o);
  const removed: AvailabilityOption[] = [];
  for (const [k, o] of prevMap) if (!curMap.has(k)) removed.push(o);
  return { added, removed };
}

export function describeOption(o: AvailabilityOption): string {
  const parts = [o.portalName, o.dateLabel, o.shift];
  if (o.areas.length) parts.push(o.areas.join(", "));
  return parts.join(" · ");
}

/** Builds the dashboard URL for a filter, mirroring the client's syncParams(). */
export function filterToUrl(filter: SubscriptionFilter, baseUrl: string): string {
  const p = new URLSearchParams();
  for (const v of filter.tents) p.append("t", v);
  for (const v of filter.shifts) p.append("s", v);
  for (const v of filter.areas) p.append("a", v);
  if (filter.from) p.set("from", filter.from);
  if (filter.to) p.set("to", filter.to);
  if (filter.weekend) p.set("w", "1");
  if (filter.search) p.set("q", filter.search);
  return p.toString() ? `${baseUrl}/?${p.toString()}` : `${baseUrl}/`;
}

export function describeFilter(filter: SubscriptionFilter): string {
  const parts: string[] = [];
  if (filter.tents.length) parts.push(`${filter.tents.length} Festzelt`);
  if (filter.shifts.length) parts.push(`Zeit: ${filter.shifts.join(", ")}`);
  if (filter.areas.length) parts.push(`Bereich: ${filter.areas.join(", ")}`);
  if (filter.from || filter.to) parts.push(`${filter.from || "…"} – ${filter.to || "…"}`);
  if (filter.weekend) parts.push("nur Wochenenden");
  if (filter.search) parts.push(`Suche: „${filter.search}"`);
  return parts.join(" · ") || "alle Reservierungen";
}

export interface NotificationEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildNotificationEmail(opts: {
  filter: SubscriptionFilter;
  diff: OptionDiff;
  baseUrl: string;
  token: string;
}): NotificationEmail {
  const { filter, diff, baseUrl, token } = opts;
  const plural = (n: number, s: string) => (n === 1 ? s : `${s}n`);
  const addedHead = diff.added.length
    ? `Neu verfügbar (${diff.added.length}):\n` + diff.added.map((o) => `  + ${describeOption(o)}`).join("\n")
    : "";
  const removedHead = diff.removed.length
    ? `Nicht mehr verfügbar (${diff.removed.length}):\n` + diff.removed.map((o) => `  - ${describeOption(o)}`).join("\n")
    : "";
  const sections = [addedHead, removedHead].filter(Boolean).join("\n\n");

  const subject =
    diff.added.length && diff.removed.length
      ? `Tisch-Reservierungen: ${diff.added.length} neue, ${diff.removed.length} weg`
      : diff.added.length
        ? `Tisch-Reservierungen: ${diff.added.length} neue verfügbare ${plural(diff.added.length, "Reservierung")}`
        : `Tisch-Reservierungen: ${diff.removed.length} nicht mehr verfügbare ${plural(diff.removed.length, "Reservierung")}`;

  const text = `Deine gespeicherten Filter: ${describeFilter(filter)}\n\n${sections}\n\nAnsehen: ${filterToUrl(filter, baseUrl)}\n\nAbmelden: ${baseUrl}/api/unsubscribe?token=${token}`;

  const list = (items: AvailabilityOption[], cls: string) =>
    items
      .map((o) => `<li class="${cls}">${escapeHtml(describeOption(o))}</li>`)
      .join("");
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#1c1917">
      <h2>Änderungen bei deinen gespeicherten Filtern</h2>
      <p style="color:#78716c">${escapeHtml(describeFilter(filter))}</p>
      ${diff.added.length ? `<h3 style="color:#15803d">Neu verfügbar (${diff.added.length})</h3><ul>${list(diff.added, "added")}</ul>` : ""}
      ${diff.removed.length ? `<h3 style="color:#b45309">Nicht mehr verfügbar (${diff.removed.length})</h3><ul>${list(diff.removed, "removed")}</ul>` : ""}
      <p><a href="${escapeHtml(filterToUrl(filter, baseUrl))}">Zur Ansicht</a></p>
      <p style="font-size:12px;color:#78716c"><a href="${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}">Abmelden</a></p>
    </div>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c;
  });
}

export function buildConfirmationEmail(opts: {
  filter: SubscriptionFilter;
  baseUrl: string;
  confirmToken: string;
  token: string;
}): NotificationEmail {
  const { filter, baseUrl, confirmToken, token } = opts;
  const confirmUrl = `${baseUrl}/api/confirm?token=${encodeURIComponent(confirmToken)}`;
  const text = `Bestätige deine E-Mail-Adresse, um Benachrichtigungen zu aktivieren.\n\nDeine gespeicherten Filter: ${describeFilter(filter)}\n\nBestätigen: ${confirmUrl}\n\nSolltest du das nicht angefordert haben, kannst du diese E-Mail ignorieren.\n\nAbmelden: ${baseUrl}/api/unsubscribe?token=${token}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#1c1917">
      <h2>Bestätige deine E-Mail-Adresse</h2>
      <p style="color:#78716c">${escapeHtml(describeFilter(filter))}</p>
      <p>Klicke auf den Button, um deine E-Mail-Benachrichtigung zu aktivieren:</p>
      <p><a href="${confirmUrl}" style="display:inline-block;padding:10px 18px;background:#b91c1c;color:#fff;text-decoration:none;border-radius:6px">Abonnement bestätigen</a></p>
      <p style="font-size:12px;color:#78716c">Falls du das nicht angefordert hast, kannst du diese E-Mail ignorieren. <a href="${baseUrl}/api/unsubscribe?token=${encodeURIComponent(token)}">Abmelden</a></p>
    </div>`;

  return { subject: "Bitte bestätige deine E-Mail-Adresse", text, html };
}

/* ---------------- Storage ---------------- */

export class SubscriberStore {
  private subs: Subscription[];

  constructor(private file: string) {
    this.subs = this.load();
  }

  private load(): Subscription[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(raw) ? (raw as Subscription[]).map((s) => this.normalize(s)) : [];
    } catch {
      return [];
    }
  }

  /** Backfills fields for subscriptions persisted before double opt-in existed. */
  private normalize(s: Subscription): Subscription {
    return {
      ...s,
      // Legacy subscriptions were already opt-in at the time of writing.
      status: s.status ?? "active",
      confirmToken: s.confirmToken ?? randomUUID(),
    };
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.subs, null, 2));
  }

  list(): Subscription[] {
    return this.subs;
  }

  getByToken(token: string): Subscription | undefined {
    return this.subs.find((s) => s.token === token);
  }

  getByConfirmToken(token: string): Subscription | undefined {
    return this.subs.find((s) => s.confirmToken === token);
  }

  /** First pending subscription for the email (used to resend the confirmation). */
  pendingByEmail(email: string): Subscription | undefined {
    return this.subs.find((s) => s.email === email && s.status === "pending");
  }

  add(email: string, filter: SubscriptionFilter): Subscription {
    const sub: Subscription = {
      id: randomUUID(),
      email,
      token: randomUUID(),
      confirmToken: randomUUID(),
      status: "pending",
      filter,
      createdAt: new Date().toISOString(),
    };
    this.subs.push(sub);
    this.save();
    return sub;
  }

  /** Activates the subscription for a matching confirmation token (double opt-in). */
  confirmByToken(token: string): Subscription | undefined {
    const sub = this.getByConfirmToken(token);
    if (sub) {
      sub.status = "active";
      this.save();
    }
    return sub;
  }

  removeByToken(token: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.token !== token);
    if (this.subs.length !== before) {
      this.save();
      return true;
    }
    return false;
  }
}