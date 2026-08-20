import { describe, it, expect } from "vitest";
import { decodeEntities, findSnapshotAttr, parseSelectOptions } from "../src/livewire.js";

describe("decodeEntities", () => {
  it("decodes HTML entities used inside wire:snapshot attributes", () => {
    expect(decodeEntities("&quot;a&quot; &amp; &lt;x&gt; &#039;q&#039;")).toBe(
      "\"a\" & <x> 'q'",
    );
  });
});

describe("findSnapshotAttr", () => {
  it("extracts wire:id and wire:snapshot from the main component div", () => {
    const html =
      '<div wire:snapshot="{&quot;data&quot;:{}}" wire:id="abc123" class="x">' +
      "createBookingStepOneForm" +
      "</div>";
    const found = findSnapshotAttr(html);
    expect(found.componentId).toBe("abc123");
    expect(found.value).toBe("{&quot;data&quot;:{}}");
  });

  it("throws when the snapshot attribute is missing", () => {
    expect(() => findSnapshotAttr("<div>createBookingStepOneForm</div>")).toThrow(
      "no wire:snapshot found",
    );
  });
});

describe("parseSelectOptions", () => {
  const html = [
    '<select id="data.createBookingStepOneForm.date">',
    '<option value="">Wählen Sie eine Option</option>',
    '<option value="2026-09-21">',
    "Montag, 21.09.2026",
    "</option>",
    '<option value="2026-09-22" selected>Dienstag, 22.09.2026</option>',
    "</select>",
  ].join("\n");

  it("parses option values and labels", () => {
    const options = parseSelectOptions(html, "data.createBookingStepOneForm.date");
    expect(options).toEqual([
      { value: "", label: "Wählen Sie eine Option" },
      { value: "2026-09-21", label: "Montag, 21.09.2026" },
      { value: "2026-09-22", label: "Dienstag, 22.09.2026" },
    ]);
  });

  it("returns an empty array when the select is absent", () => {
    expect(parseSelectOptions("<p>no select</p>", "data.createBookingStepOneForm.date")).toEqual([]);
  });

  it("keeps option labels with inner markup stripped", () => {
    const inner = [
      '<select id="x">',
      '<option value="1"><b>Innen</b>raum</option>',
      "</select>",
    ].join("\n");
    expect(parseSelectOptions(inner, "x")).toEqual([{ value: "1", label: "Innenraum" }]);
  });
});