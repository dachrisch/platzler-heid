import { describe, it, expect } from "vitest";
import {
  SubscriberStore,
  buildNotificationEmail,
  diffOptions,
  filterToUrl,
  flatten,
  matches,
  optionKey,
} from "../src/subscriptions.js";
import type { AvailabilityOption, SubscriptionFilter } from "../src/subscriptions.js";
import type { AvailabilitySnapshot } from "../src/types.js";

const emptyFilter: SubscriptionFilter = { tents: [], shifts: [], areas: [], from: "", to: "", weekend: false, search: "" };

function option(partial: Partial<AvailabilityOption>): AvailabilityOption {
  return {
    portalId: "ochsenbraterei",
    portalName: "Ochsenbraterei",
    portalUrl: "https://reservierung.ochsenbraterei.de/reservierungen",
    date: "2026-09-21",
    dateLabel: "Montag, 21.09.2026",
    shift: "Abend",
    areas: ["Innenraum"],
    pax: ["10 Personen"],
    startTimes: [],
    ...partial,
  };
}

function snapshot(options: AvailabilityOption[]): AvailabilitySnapshot {
  const portals = new Map<string, AvailabilityOption[]>();
  for (const o of options) {
    if (!portals.has(o.portalId)) portals.set(o.portalId, []);
    portals.get(o.portalId)!.push(o);
  }
  return {
    fetchedAt: "2026-08-24T12:00:00.000Z",
    portals: [...portals.entries()].map(([portalId, opts]) => ({
      portalId,
      name: opts[0].portalName,
      url: opts[0].portalUrl,
      closed: false,
      dates: opts.map((o) => ({
        date: o.date,
        label: o.dateLabel,
        bookingLists: [
          {
            id: o.shift,
            label: o.shift,
            seatplanGroups: o.areas.map((a) => ({ value: a, label: a })),
            seatplanAreas: [],
            paxOptions: o.pax.map((p) => ({ value: p, label: p })),
            simplePax: [],
            startTimes: o.startTimes.map((s) => ({ value: s, label: s })),
          },
        ],
      })),
    })),
  };
}

describe("flatten", () => {
  it("skips closed or errored portals", () => {
    const snap: AvailabilitySnapshot = {
      fetchedAt: "",
      portals: [
        { portalId: "a", name: "A", url: "u", closed: false, dates: [] },
        { portalId: "b", name: "B", url: "u", closed: true, dates: [] },
        { portalId: "c", name: "C", url: "u", closed: false, error: "boom", dates: [] },
      ],
    };
    expect(flatten(snap)).toHaveLength(0);
  });

  it("flattens booking lists into options", () => {
    const snap = snapshot([option({ shift: "Abend" })]);
    const flat = flatten(snap);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({
      portalId: "ochsenbraterei",
      shift: "Abend",
      areas: ["Innenraum"],
      pax: ["10 Personen"],
    });
  });
});

describe("matches", () => {
  const o = option({ date: "2026-09-21", shift: "Abend", areas: ["Innenraum"], pax: ["10 Personen"] });

  it("matches everything with an empty filter", () => {
    expect(matches(o, emptyFilter)).toBe(true);
  });

  it("filters by tent", () => {
    expect(matches(o, { ...emptyFilter, tents: ["paulaner-festzelt"] })).toBe(false);
    expect(matches(o, { ...emptyFilter, tents: ["ochsenbraterei"] })).toBe(true);
  });

  it("filters by shift", () => {
    expect(matches(o, { ...emptyFilter, shifts: ["Mittag"] })).toBe(false);
    expect(matches(o, { ...emptyFilter, shifts: ["Abend"] })).toBe(true);
  });

  it("filters by area (any match)", () => {
    expect(matches(o, { ...emptyFilter, areas: ["Galerie"] })).toBe(false);
    expect(matches(o, { ...emptyFilter, areas: ["Innenraum"] })).toBe(true);
  });

  it("filters by date range", () => {
    expect(matches(o, { ...emptyFilter, from: "2026-09-22" })).toBe(false);
    expect(matches(o, { ...emptyFilter, to: "2026-09-20" })).toBe(false);
    expect(matches(o, { ...emptyFilter, from: "2026-09-21", to: "2026-09-21" })).toBe(true);
  });

  it("filters by weekend", () => {
    // 2026-09-21 is a Monday.
    expect(matches(o, { ...emptyFilter, weekend: true })).toBe(false);
    const sunday = option({ date: "2026-09-20", dateLabel: "Sonntag, 20.09.2026" });
    expect(matches(sunday, { ...emptyFilter, weekend: true })).toBe(true);
  });

  it("filters by free-text search", () => {
    expect(matches(o, { ...emptyFilter, search: "paulaner" })).toBe(false);
    expect(matches(o, { ...emptyFilter, search: "ochsenbraterei" })).toBe(true);
  });
});

describe("optionKey", () => {
  it("is stable regardless of array order", () => {
    const a = option({ areas: ["Innenraum", "Galerie"], pax: ["10 Personen", "8 Personen"] });
    const b = option({ areas: ["Galerie", "Innenraum"], pax: ["8 Personen", "10 Personen"] });
    expect(optionKey(a)).toBe(optionKey(b));
  });
});

describe("diffOptions", () => {
  it("reports added and removed options for the filter", () => {
    const before = [
      option({ shift: "Abend" }),
      option({ shift: "Mittag" }),
    ];
    const after = [
      option({ shift: "Abend" }),
      option({ shift: "Nachmittag" }),
    ];
    const diff = diffOptions(before, after, emptyFilter);
    expect(diff.added.map((o) => o.shift)).toEqual(["Nachmittag"]);
    expect(diff.removed.map((o) => o.shift)).toEqual(["Mittag"]);
  });

  it("ignores changes that fall outside the filter", () => {
    const before = [option({ shift: "Mittag" })];
    const after = [option({ shift: "Abend" })];
    const diff = diffOptions(before, after, { ...emptyFilter, shifts: ["Mittag"] });
    expect(diff.added).toHaveLength(0);
    expect(diff.removed.map((o) => o.shift)).toEqual(["Mittag"]);
  });
});

describe("filterToUrl", () => {
  it("serializes filter params and omits empty ones", () => {
    const url = filterToUrl(
      { tents: ["ochsenbraterei"], shifts: ["Abend"], areas: [], from: "2026-09-21", to: "", weekend: true, search: "" },
      "https://example.test",
    );
    expect(url).toContain("t=ochsenbraterei");
    expect(url).toContain("s=Abend");
    expect(url).toContain("from=2026-09-21");
    expect(url).toContain("w=1");
    expect(url).not.toContain("to=");
  });

  it("falls back to the plain base URL for an empty filter", () => {
    expect(filterToUrl(emptyFilter, "https://example.test")).toBe("https://example.test/");
  });
});

describe("buildNotificationEmail", () => {
  it("builds subject, plain text and HTML", () => {
    const diff = { added: [option({ shift: "Abend" })], removed: [option({ shift: "Mittag" })] };
    const email = buildNotificationEmail({
      filter: emptyFilter,
      diff,
      baseUrl: "https://example.test",
      token: "tok123",
    });
    expect(email.subject).toContain("1 neue");
    expect(email.subject).toContain("1 weg");
    expect(email.text).toContain("+ Ochsenbraterei · Montag, 21.09.2026 · Abend");
    expect(email.text).toContain("- Ochsenbraterei · Montag, 21.09.2026 · Mittag");
    expect(email.text).toContain("https://example.test/api/unsubscribe?token=tok123");
    expect(email.html).toContain("Ochsenbraterei");
  });
});

describe("SubscriberStore", () => {
  it("persists and removes subscriptions", () => {
    const dir = import.meta.dirname + "/tmp-subscribers";
    const file = dir + "/subscribers.json";
    const store = new SubscriberStore(file);
    const sub = store.add("du@beispiel.de", emptyFilter);
    expect(store.getByToken(sub.token)?.email).toBe("du@beispiel.de");

    const reloaded = new SubscriberStore(file);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.removeByToken(sub.token)).toBe(true);
    expect(reloaded.list()).toHaveLength(0);
    expect(reloaded.removeByToken(sub.token)).toBe(false);
  });
});