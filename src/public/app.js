const state = {
  tents: new Set(),
  shifts: new Set(),
  areas: new Set(),
  dateFrom: "",
  dateTo: "",
  weekendOnly: false,
  search: "",
};

let DATA = null;
let OPTIONS = [];

const SHIFT_COLORS = {
  Abend: "shift-abend",
  Mittag: "shift-mittag",
  Nachmittag: "shift-nachmittag",
  Frühstück: "shift-fruehstueck",
  "Warm Up": "shift-warmup",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function isWeekend(isoDate) {
  const day = new Date(isoDate + "T12:00:00").getUTCDay();
  return day === 0 || day === 6;
}

function flatten(data) {
  const out = [];
  for (const p of data.portals ?? []) {
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
          areas: dedupe([
            ...(bl.seatplanGroups ?? []),
            ...(bl.seatplanAreas ?? []),
          ].map((x) => x.label)),
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

/* ---------------- URL state ---------------- */

function readParams() {
  const p = new URLSearchParams(location.search);
  if (p.has("t")) state.tents = new Set(p.getAll("t"));
  if (p.has("s")) state.shifts = new Set(p.getAll("s"));
  if (p.has("a")) state.areas = new Set(p.getAll("a"));
  state.dateFrom = p.get("from") ?? "";
  state.dateTo = p.get("to") ?? "";
  state.weekendOnly = p.get("w") === "1";
  state.search = p.get("q") ?? "";
}

function syncParams() {
  const p = new URLSearchParams();
  for (const v of state.tents) p.append("t", v);
  for (const v of state.shifts) p.append("s", v);
  for (const v of state.areas) p.append("a", v);
  if (state.dateFrom) p.set("from", state.dateFrom);
  if (state.dateTo) p.set("to", state.dateTo);
  if (state.weekendOnly) p.set("w", "1");
  if (state.search) p.set("q", state.search);
  history.replaceState(null, "", p.toString() ? "?" + p.toString() : location.pathname);
}

/* ---------------- Filtering ---------------- */

function matches(o) {
  if (state.tents.size && !state.tents.has(o.portalId)) return false;
  if (state.shifts.size && !state.shifts.has(o.shift)) return false;
  if (state.areas.size && !o.areas.some((a) => state.areas.has(a))) return false;
  if (state.dateFrom && o.date < state.dateFrom) return false;
  if (state.dateTo && o.date > state.dateTo) return false;
  if (state.weekendOnly && !isWeekend(o.date)) return false;
  if (state.search) {
    const hay = `${o.portalName} ${o.dateLabel} ${o.shift} ${o.areas.join(" ")} ${o.pax.join(" ")}`.toLowerCase();
    if (!hay.includes(state.search.toLowerCase())) return false;
  }
  return true;
}

/* ---------------- Multi-select dropdown ---------------- */

function makeDropdown(key, items, getLabel, getSelectedLabel) {
  const trigger = document.querySelector(`[data-dd="${key}"]`);
  const panel = document.getElementById(`${key}-panel`);
  const selected = state[key];

  function updateTrigger() {
    trigger.textContent = getSelectedLabel(selected.size);
  }

  function renderItems() {
    panel.innerHTML = items
      .map(
        (item) =>
          `<label class="dd-item"><input type="checkbox" value="${escapeHtml(item.value)}" ${
            selected.has(item.value) ? "checked" : ""
          } />${escapeHtml(getLabel(item))}</label>`,
      )
      .join("");
    panel.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(cb.value);
        else selected.delete(cb.value);
        updateTrigger();
        update();
      });
    });
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !panel.hidden;
    closeAllDropdowns();
    panel.hidden = isOpen;
  });

  renderItems();
  updateTrigger();
}

function closeAllDropdowns() {
  document.querySelectorAll(".dd-panel").forEach((p) => (p.hidden = true));
}

/* ---------------- Shift chips ---------------- */

function buildShiftChips(allShifts) {
  const wrap = document.getElementById("shift-chips");
  wrap.innerHTML = "";
  for (const shift of allShifts) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = shift;
    chip.addEventListener("click", () => {
      if (state.shifts.has(shift)) state.shifts.delete(shift);
      else state.shifts.add(shift);
      update();
    });
    wrap.appendChild(chip);
  }
}

/* ---------------- Render ---------------- */

function shiftClass(shift) {
  return SHIFT_COLORS[shift] ?? "shift-other";
}

function renderOption(o) {
  const details = [];
  if (o.areas.length) details.push(`<span class="detail-label">Bereiche:</span> ${escapeHtml(o.areas.join(", "))}`);
  if (o.startTimes.length) details.push(`<span class="detail-label">Zeiten:</span> ${escapeHtml(o.startTimes.join(" · "))}`);
  if (o.pax.length) details.push(`<span class="detail-label">Personen:</span> ${escapeHtml(o.pax.join(" · "))}`);
  return `
    <div class="option">
      <div class="option-left">
        <span class="shift-badge ${shiftClass(o.shift)}">${escapeHtml(o.shift)}</span>
        <a class="tent-name" href="${escapeHtml(o.portalUrl)}" target="_blank" rel="noopener">${escapeHtml(o.portalName)}</a>
      </div>
      <div class="option-details">${details.join(" · ") || '<span class="muted">—</span>'}</div>
    </div>
  `;
}

function renderSummary(filtered) {
  const tents = new Set(filtered.map((o) => o.portalId));
  const byShift = {};
  for (const o of filtered) byShift[o.shift] = (byShift[o.shift] ?? 0) + 1;
  const shiftText = Object.entries(byShift)
    .map(([s, n]) => `${n}× ${s}`)
    .join(" · ");

  const active = [];
  if (state.tents.size) active.push(`${state.tents.size} Festzelt`);
  if (state.dateFrom || state.dateTo)
    active.push(`${state.dateFrom || "…"} – ${state.dateTo || "…"}`);
  if (state.weekendOnly) active.push("nur Wochenenden");
  if (state.search) active.push(`„${state.search}"`);

  const summary = document.getElementById("filter-summary");
  summary.innerHTML = active.length
    ? `Filter: ${escapeHtml(active.join(" · "))}`
    : "Keine Filter aktiv — alle verfügbaren Reservierungen";
  const head = document.getElementById("result-head");
  head.textContent = `${filtered.length} verfügbare Reservierung(en) in ${tents.size} Festzelt(en)`;
  const shiftLine = document.getElementById("result-shifts");
  shiftLine.textContent = shiftText;
}

function groupByDate(options) {
  const groups = [];
  let last = null;
  for (const o of options) {
    if (!last || last.date !== o.date) {
      last = { date: o.date, dateLabel: o.dateLabel, items: [] };
      groups.push(last);
    }
    last.items.push(o);
  }
  return groups;
}

function renderResults() {
  const filtered = OPTIONS.filter(matches);
  renderSummary(filtered);
  const app = document.getElementById("app");
  if (!DATA) {
    app.innerHTML = '<p class="muted">Lade Daten …</p>';
    return;
  }
  if (filtered.length === 0) {
    app.innerHTML = `
      <div class="empty-state">
        <p>Keine Reservierungen gefunden, die den Filtern entsprechen.</p>
        <button type="button" class="reset" id="empty-reset">Filter zurücksetzen</button>
      </div>`;
    document.getElementById("empty-reset").addEventListener("click", resetFilters);
    return;
  }
  const groups = groupByDate(filtered);
  app.innerHTML = groups
    .map(
      (g) => `
        <section class="day">
          <div class="day-head">
            <h2>${escapeHtml(g.dateLabel)}</h2>
            <span class="day-count muted">${g.items.length}</span>
          </div>
          ${g.items.map(renderOption).join("")}
        </section>
      `,
    )
    .join("");
}

function update() {
  syncParams();
  document.querySelectorAll(".chip").forEach((c) => {
    const shift = c.textContent;
    c.classList.toggle("active", state.shifts.has(shift));
  });
  document.getElementById("weekend-toggle").classList.toggle("active", state.weekendOnly);
  document.getElementById("date-from").value = state.dateFrom;
  document.getElementById("date-to").value = state.dateTo;
  document.getElementById("search").value = state.search;
  renderResults();
}

/* ---------------- Setup ---------------- */

function initControls() {
  const allTents = dedupe(OPTIONS.map((o) => o.portalId))
    .map((id) => {
      const o = OPTIONS.find((x) => x.portalId === id);
      return { value: id, label: o.portalName };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  makeDropdown("tent", allTents, (i) => i.label, (n) =>
    n === 0 ? "Alle Festzelte ▾" : n === 1 ? "1 Festzelt ▾" : `${n} Festzelte ▾`,
  );

  const allAreas = dedupe(OPTIONS.flatMap((o) => o.areas)).sort((a, b) => a.localeCompare(b));
  makeDropdown("area", allAreas.map((a) => ({ value: a, label: a })), (i) => i.label, (n) =>
    n === 0 ? "Alle Bereiche ▾" : n === 1 ? "1 Bereich ▾" : `${n} Bereiche ▾`,
  );

  buildShiftChips(dedupe(OPTIONS.map((o) => o.shift)).sort((a, b) => a.localeCompare(b)));

  document.getElementById("date-from").addEventListener("change", (e) => {
    state.dateFrom = e.target.value;
    update();
  });
  document.getElementById("date-to").addEventListener("change", (e) => {
    state.dateTo = e.target.value;
    update();
  });
  document.getElementById("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    update();
  });
  document.getElementById("weekend-toggle").addEventListener("click", () => {
    state.weekendOnly = !state.weekendOnly;
    update();
  });
  document.getElementById("reset").addEventListener("click", resetFilters);

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".dropdown")) closeAllDropdowns();
  });
}

function resetFilters() {
  state.tents = new Set();
  state.shifts = new Set();
  state.areas = new Set();
  state.dateFrom = "";
  state.dateTo = "";
  state.weekendOnly = false;
  state.search = "";
  update();
}

async function load() {
  const res = await fetch("/api/availability");
  const data = await res.json();
  DATA = data;
  OPTIONS = flatten(data);
  if (document.querySelector("#tent-panel").children.length === 0) {
    initControls();
  }
  const fetched = document.getElementById("fetched-at");
  const fetched2 = document.getElementById("fetched-at-2");
  if (data.fetchedAt) {
    const d = new Date(data.fetchedAt);
    const txt = d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
    fetched.textContent = "Zuletzt aktualisiert: " + txt;
    fetched2.textContent = txt;
  }
  update();
}

document.getElementById("refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Aktualisiere …";
  try {
    await fetch("/api/refresh", { method: "POST" });
    let attempts = 0;
    const poll = async () => {
      const status = await (await fetch("/api/status")).json();
      if (!status.scraping) {
        await load();
        btn.disabled = false;
        btn.textContent = "Aktualisieren";
      } else if (attempts++ < 600) {
        setTimeout(poll, 2000);
      } else {
        btn.disabled = false;
        btn.textContent = "Aktualisieren";
      }
    };
    poll();
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Aktualisieren";
  }
});

readParams();
load();
setInterval(load, 60_000);