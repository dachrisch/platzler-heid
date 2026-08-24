import { describe, it, expect, beforeEach, vi } from "vitest";
import { scrapeKaefer } from "../src/kaefer.js";
import type { PortalConfig } from "../src/types.js";

const portal: PortalConfig = {
  id: "kaefer",
  name: "Käfer Wiesn-Schänke",
  url: "https://wiesnresmittag.kaefer-wiesn.de/",
  scraper: {
    provider: "kaefer",
    options: {
      baseUrl: "https://app-mittagsreservierung.example.net/",
      apiKey: "TESTKEY",
    },
  },
};

const slot = (overrides: Record<string, unknown> = {}) => ({
  slot_id: 1029,
  zeit_ID: 0,
  anz: 0,
  anzBereich: 0,
  anzDat: 0,
  bereich: "Haus innen",
  tische: "6,8",
  bereich1: "Überdachter Freisitz",
  tische1: "8",
  rDatum: "2026-09-21T00:00:00",
  res_ab: "11:30:00",
  res_bis: "15:00:00",
  ...overrides,
});

const fixtures = vi.hoisted(() => ({
  slots: [
    {
      slot_id: 1029,
      zeit_ID: 0,
      bereich: "Haus innen",
      tische: "6,8",
      bereich1: "Überdachter Freisitz",
      tische1: "8",
      rDatum: "2026-09-21T00:00:00",
      res_ab: "11:30:00",
      res_bis: "15:00:00",
    },
    {
      slot_id: 1030,
      zeit_ID: 1,
      bereich: "Haus innen",
      tische: "6,8",
      bereich1: "Überdachter Freisitz",
      tische1: "8,10,12",
      rDatum: "2026-09-21T00:00:00",
      res_ab: "15:30:00",
      res_bis: "19:00:00",
    },
    // Fully booked slot — both areas have no tables left.
    {
      slot_id: 1033,
      zeit_ID: 0,
      bereich: "Haus innen",
      tische: null,
      bereich1: "Überdachter Freisitz",
      tische1: null,
      rDatum: "2026-09-22T00:00:00",
      res_ab: "11:30:00",
      res_bis: "15:00:00",
    },
  ],
}));

vi.mock("../src/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http.js")>();
  return {
    ...actual,
    curlRequest: vi.fn(async () => ({
      status: 200,
      body: JSON.stringify(fixtures.slots),
      headerBlock: "",
    })),
  };
});

describe("scrapeKaefer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps slots to dates, shifts, areas and table sizes", async () => {
    const result = await scrapeKaefer(portal, { throttleMs: 0 });

    expect(result.closed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.dates).toHaveLength(1);
    expect(result.dates[0].date).toBe("2026-09-21");
    expect(result.dates[0].bookingLists).toHaveLength(2);

    const mittag = result.dates[0].bookingLists[0];
    expect(mittag).toMatchObject({
      label: "Mittag",
      seatplanAreas: [
        { value: "Haus innen", label: "Haus innen" },
        { value: "Überdachter Freisitz", label: "Überdachter Freisitz" },
      ],
      simplePax: [
        { value: "6", label: "6 Personen" },
        { value: "8", label: "8 Personen" },
      ],
      startTimes: [{ value: "11:30", label: "11:30" }],
    });

    const nachmittag = result.dates[0].bookingLists[1];
    expect(nachmittag.label).toBe("Nachmittag");
    expect(nachmittag.startTimes).toEqual([{ value: "15:30", label: "15:30" }]);
  });

  it("marks the portal as closed when no slot has availability", async () => {
    const { curlRequest } = await import("../src/http.js");
    vi.mocked(curlRequest).mockResolvedValue({
      status: 200,
      body: JSON.stringify([slot({ tische: null, tische1: null })]),
      headerBlock: "",
    });
    const result = await scrapeKaefer(portal, { throttleMs: 0 });
    expect(result.closed).toBe(true);
    expect(result.dates).toEqual([]);
  });

  it("records a config error when the API options are missing", async () => {
    const result = await scrapeKaefer(
      { id: "kaefer", name: "Käfer", url: portal.url },
      { throttleMs: 0 },
    );
    expect(result.closed).toBe(true);
    expect(result.error).toContain("missing");
  });
});