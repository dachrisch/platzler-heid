import { describe, it, expect, beforeEach, vi } from "vitest";
import { scrapeFestzeltOs2 } from "../src/festzelt-os2.js";
import type { PortalConfig } from "../src/types.js";

const portal: PortalConfig = {
  id: "test-os2",
  name: "Test OS2",
  url: "https://reservierung.test.example/reservation",
  api: { baseUrl: "https://test-api.festzelt-os.com/lp", companyUid: "ABC123" },
};

const fixtures = vi.hoisted(() => ({
  guestlists: {
    meta: { curTime: "2026-08-24T12:00:00+00:00" },
    pagination: { total: 2, current: 1, perPage: 100, pages: 1 },
    data: [
      {
        name: "1. Montag, 21.09.2026 - Mittag",
        date: "2026-09-21T00:00:00+00:00",
        uid: "UID1",
        shift: { id: 19, label: "Mittag" },
        use_seatplan_in_public: true,
      },
      {
        name: "1. Dienstag, 22.09.2026 - Abend",
        date: "2026-09-22T00:00:00+00:00",
        uid: "UID2",
        shift: { id: 20, label: "Abend" },
        use_seatplan_in_public: true,
      },
    ],
  },
  definitions: {
    status: 200,
    data: {
      default_min_consumption: null,
      areas: [
        { id: 87, label: "Halle Süd/Mitte", start: "2026-09-21T10:00:00+00:00" },
        { id: 91, label: "Hallenboxe", start: "2026-09-21T10:00:00+00:00" },
      ],
    },
  },
}));

vi.mock("../src/http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http.js")>();
  const urls = new Map<string, string>();
  urls.set("https://test-api.festzelt-os.com/lp/guestlists?page=1", JSON.stringify(fixtures.guestlists));
  urls.set("https://test-api.festzelt-os.com/lp/guestlists/UID1/definitions", JSON.stringify(fixtures.definitions));
  urls.set("https://test-api.festzelt-os.com/lp/guestlists/UID2/definitions", JSON.stringify(fixtures.definitions));

  return {
    ...actual,
    curlRequest: vi.fn(async (url: string) => {
      const body = urls.get(url) ?? JSON.stringify({});
      return { status: 200, body, headerBlock: "" };
    }),
  };
});

describe("scrapeFestzeltOs2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects dates, booking lists (shifts) and areas from the JSON API", async () => {
    const result = await scrapeFestzeltOs2(portal, { throttleMs: 0 });

    expect(result.closed).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.dates).toHaveLength(2);
    expect(result.dates[0].date).toBe("2026-09-21");
    expect(result.dates[0].bookingLists).toHaveLength(1);
    expect(result.dates[0].bookingLists[0]).toMatchObject({
      id: "UID1",
      label: "Mittag",
      seatplanAreas: [
        { value: "87", label: "Halle Süd/Mitte" },
        { value: "91", label: "Hallenboxe" },
      ],
    });
  });

  it("marks the portal as closed when no guest lists are offered", async () => {
    const { curlRequest } = await import("../src/http.js");
    vi.mocked(curlRequest).mockResolvedValue({
      status: 200,
      body: JSON.stringify({ data: [], pagination: { pages: 1 } }),
      headerBlock: "",
    });
    const result = await scrapeFestzeltOs2(portal, { throttleMs: 0 });
    expect(result.closed).toBe(true);
    expect(result.dates).toEqual([]);
  });
});