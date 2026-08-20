import { describe, it, expect, beforeEach, vi } from "vitest";
import { scrapePortal } from "../src/scraper.js";
import type { PortalConfig } from "../src/types.js";

const portal: PortalConfig = {
  id: "test-portal",
  name: "Test Portal",
  url: "https://reservierung.test.example/reservierung",
};

function select(id: string, options: Array<[string, string]>): string {
  const opts = options
    .map(([value, label]) => `<option value="${value}">\n${label}\n</option>`)
    .join("");
  return `<select id="${id}">${opts}</select>`;
}

const dateSelect = select("data.createBookingStepOneForm.date", [
  ["", "Wählen Sie eine Option"],
  ["2026-09-21", "Montag, 21.09.2026"],
  ["2026-09-22", "Dienstag, 22.09.2026"],
]);

const bookingListSelect = select("data.createBookingStepOneForm.booking_list_id", [
  ["", "Wählen Sie eine Option"],
  ["100", "Mittag"],
  ["200", "Abend"],
]);

const optionsHtml = [
  select("data.createBookingStepOneForm.seatplan_group_id", [
    ["", "Wählen Sie eine Option"],
    ["226", "Innenraum"],
    ["227", "Boxen EG"],
  ]),
  select("data.createBookingStepOneForm.pax_options", [
    ["", "Wählen Sie eine Option"],
    ["10", "10 Personen"],
  ]),
  select("data.createBookingStepOneForm.custom_start_time", []),
].join("");

const behavior = { mode: "ok" as "ok" | "closed" | "error" };

const mocks = vi.hoisted(() => ({ parseSelectOptions: null as null | typeof import("../src/livewire.js").parseSelectOptions }));

vi.mock("../src/livewire.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/livewire.js")>();
  mocks.parseSelectOptions = actual.parseSelectOptions;

  class MockLivewireClient {
    async init() {
      if (behavior.mode === "error") throw new Error("Cloudflare challenge");
      if (behavior.mode === "closed") {
        return {
          csrf: "csrf",
          snapshot: "{}",
          componentId: "c1",
          dateOptions: [],
          bookingListGroupId: "98",
          url: portal.url,
        };
      }
      return {
        csrf: "csrf",
        snapshot: "{}",
        componentId: "c1",
        dateOptions: [
          { value: "", label: "Wählen Sie eine Option" },
          { value: "2026-09-21", label: "Montag, 21.09.2026" },
          { value: "2026-09-22", label: "Dienstag, 22.09.2026" },
        ],
        bookingListGroupId: "98",
        url: portal.url,
      };
    }
    async selectDate() {
      return dateSelect + bookingListSelect;
    }
    async selectBookingList() {
      return optionsHtml;
    }
  }

  return { ...actual, LivewireClient: MockLivewireClient };
});

describe("scrapePortal", () => {
  beforeEach(() => {
    behavior.mode = "ok";
  });

  it("collects dates, booking lists and options", async () => {
    const result = await scrapePortal(portal, { throttleMs: 0 });

    expect(result.closed).toBe(false);
    expect(result.bookingListGroupId).toBe("98");
    expect(result.dates).toHaveLength(2);
    expect(result.dates[0].date).toBe("2026-09-21");
    expect(result.dates[0].bookingLists).toHaveLength(2);
    expect(result.dates[0].bookingLists[0]).toMatchObject({
      id: "100",
      label: "Mittag",
      seatplanGroups: [
        { value: "226", label: "Innenraum" },
        { value: "227", label: "Boxen EG" },
      ],
      paxOptions: [{ value: "10", label: "10 Personen" }],
      startTimes: [],
    });
  });

  it("marks the portal as closed when no dates are offered", async () => {
    behavior.mode = "closed";
    const result = await scrapePortal(portal, { throttleMs: 0 });
    expect(result.closed).toBe(true);
    expect(result.dates).toEqual([]);
  });

  it("records an error instead of throwing", async () => {
    behavior.mode = "error";
    const result = await scrapePortal(portal, { throttleMs: 0 });
    expect(result.error).toContain("Cloudflare");
  });
});