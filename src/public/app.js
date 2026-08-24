const state = {
  tents: new Set(),
  shifts: new Set(),
  areas: new Set(),
  dateFrom: "",
  dateTo: "",
  weekendOnly: false,
  search: "",
  subscribe: false,
};

let DATA = null;
let OPTIONS = [];
let streamActive = false;
let progress = { done: 0, total: 0 };

// Watch baseline: latest snapshot of the *filtered* entries while subscribed.
let baseline = null; // Map<optionKey, option>
let baselineFilter = null; // filterStateKey() at baseline capture time
let pendingChanges = { added: [], removed: [] };
let pendingSeen = true;

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
  state.subscribe = p.get("sub") === "1";
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
  if (state.subscribe) p.set("sub", "1");
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

/* ---------------- Subscribe to changes ---------------- */

function optionKey(o) {
  return [
    o.portalId,
    o.date,
    o.shift,
    [...o.areas].sort().join(","),
    [...o.pax].sort().join(","),
    [...o.startTimes].sort().join(","),
  ].join("|");
}

function filterStateKey() {
  return JSON.stringify({
    tents: [...state.tents].sort(),
    shifts: [...state.shifts].sort(),
    areas: [...state.areas].sort(),
    from: state.dateFrom,
    to: state.dateTo,
    weekend: state.weekendOnly,
    search: state.search,
  });
}

function currentFilteredMap() {
  const m = new Map();
  for (const o of OPTIONS) {
    if (matches(o)) m.set(optionKey(o), o);
  }
  return m;
}

function describeOption(o) {
  const parts = [o.portalName, o.dateLabel, o.shift];
  if (o.areas.length) parts.push(o.areas.join(", "));
  return parts.join(" · ");
}

function updateSubscribeBadge(n) {
  const badge = document.getElementById("subscribe-badge");
  badge.textContent = n;
  badge.hidden = !n;
}

function renderNotify() {
  const body = document.getElementById("notify-body");
  const sections = [];
  if (pendingChanges.added.length) {
    sections.push(
      `<h3 class="notify-sub">Neu verfügbar (${pendingChanges.added.length})</h3>` +
        pendingChanges.added
          .map((o) => `<div class="notify-item notify-added">${escapeHtml(describeOption(o))}</div>`)
          .join(""),
    );
  }
  if (pendingChanges.removed.length) {
    sections.push(
      `<h3 class="notify-sub">Nicht mehr verfügbar (${pendingChanges.removed.length})</h3>` +
        pendingChanges.removed
          .map((o) => `<div class="notify-item notify-removed">${escapeHtml(describeOption(o))}</div>`)
          .join(""),
    );
  }
  body.innerHTML = sections.join("");
  document.getElementById("notify").hidden = false;
  updateSubscribeBadge(pendingChanges.added.length + pendingChanges.removed.length);
}

function dismissNotify() {
  pendingSeen = true;
  pendingChanges = { added: [], removed: [] };
  document.getElementById("notify").hidden = true;
  updateSubscribeBadge(0);
}

function checkChanges() {
  if (!state.subscribe) return;
  const cur = currentFilteredMap();
  if (baseline === null) {
    baseline = cur;
    baselineFilter = filterStateKey();
    return;
  }
  const added = [];
  for (const [k, o] of cur) if (!baseline.has(k)) added.push(o);
  const removed = [];
  for (const [k, o] of baseline) if (!cur.has(k)) removed.push(o);
  baseline = cur;
  baselineFilter = filterStateKey();
  if (!added.length && !removed.length) return;
  if (pendingSeen) {
    pendingChanges = { added: [], removed: [] };
    pendingSeen = false;
  }
  pendingChanges.added.push(...added);
  pendingChanges.removed.push(...removed);
  renderNotify();
}

function setSubscribe(on) {
  state.subscribe = on;
  document.getElementById("subscribe").classList.toggle("active", on);
  document.getElementById("subscribe-label").textContent = on ? "Abonniert ✓" : "Abonnieren";
  if (on && DATA) {
    // Anchor the baseline to the current filtered set; the first snapshot
    // while subscribed establishes it silently if data isn't loaded yet.
    baseline = currentFilteredMap();
    baselineFilter = filterStateKey();
  } else {
    baseline = null;
    baselineFilter = null;
  }
  dismissNotify();
  syncParams();
}

/* ---------------- Multi-select dropdown ---------------- */

function makeDropdown(key, selected, itemsFn, getSelectedLabel) {
  const trigger = document.querySelector(`[data-dd="${key}"]`);
  const panel = document.getElementById(`${key}-panel`);

  function renderItems() {
    const items = itemsFn();
    panel.innerHTML = items
      .map(
        (item) =>
          `<label class="dd-item"><input type="checkbox" value="${escapeHtml(item.value)}" ${
            selected.has(item.value) ? "checked" : ""
          } />${escapeHtml(item.label)}</label>`,
      )
      .join("");
    panel.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(cb.value);
        else selected.delete(cb.value);
        update();
      });
    });
    updateTrigger(items.length);
  }

  function updateTrigger(count) {
    trigger.textContent = getSelectedLabel(selected.size, count);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = !panel.hidden;
    closeAllDropdowns();
    panel.hidden = isOpen;
  });

  renderItems();
  return { refresh: renderItems };
}

function closeAllDropdowns() {
  document.querySelectorAll(".dd-panel").forEach((p) => (p.hidden = true));
}

/* ---------------- Shift chips ---------------- */

function buildShiftChips() {
  const wrap = document.getElementById("shift-chips");
  const shifts = dedupe(OPTIONS.map((o) => o.shift)).sort((a, b) => a.localeCompare(b));
  wrap.innerHTML = "";
  for (const shift of shifts) {
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
  document.getElementById("result-head").textContent =
    `${filtered.length} verfügbare Reservierung(en) in ${tents.size} Festzelt(en)`;
  document.getElementById("result-shifts").textContent = shiftText;
  updateFilterToggle();
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
  // A filter change re-defines the watched set — re-anchor silently instead of
  // reporting it as an availability change.
  if (state.subscribe && baseline !== null && baselineFilter !== filterStateKey()) {
    baseline = currentFilteredMap();
    baselineFilter = filterStateKey();
  }
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

/* ---------------- Data + streaming ---------------- */

function updateFetchedAt(iso) {
  if (!iso) return;
  const d = new Date(iso);
  const txt = d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
  document.getElementById("fetched-at").textContent = "Zuletzt aktualisiert: " + txt;
  document.getElementById("fetched-at-2").textContent = txt;
}

function updateRefreshButton() {
  const btn = document.getElementById("refresh");
  const progressEl = document.getElementById("progress");
  if (streamActive) {
    btn.disabled = true;
    btn.textContent = progress.total
      ? `Aktualisiere… ${progress.done}/${progress.total}`
      : "Aktualisiere…";
    progressEl.textContent = `Geladen: ${progress.done}/${progress.total} Festzelte`;
  } else {
    btn.disabled = false;
    btn.textContent = "Aktualisieren";
    progressEl.textContent = "";
  }
}

function refreshDynamicControls() {
  tentDropdown?.refresh();
  areaDropdown?.refresh();
  buildShiftChips();
}

function applySnapshot(data) {
  DATA = data;
  OPTIONS = flatten(data);
  if (document.querySelector("#tent-panel").children.length === 0) {
    initControls();
  } else {
    refreshDynamicControls();
  }
  updateFetchedAt(data.fetchedAt);
  update();
  checkChanges();
}

function mergePortal(portal) {
  if (!DATA) DATA = { fetchedAt: null, portals: [] };
  const others = DATA.portals.filter((p) => p.portalId !== portal.portalId);
  DATA = { ...DATA, fetchedAt: new Date().toISOString(), portals: [...others, portal] };
  OPTIONS = flatten(DATA);
  refreshDynamicControls();
  updateFetchedAt(DATA.fetchedAt);
  update();
}

function openStream() {
  const es = new EventSource("/api/stream");
  es.addEventListener("snapshot", (e) => {
    if (!streamActive) applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener("started", (e) => {
    const { total } = JSON.parse(e.data);
    streamActive = true;
    progress = { done: 0, total };
    updateRefreshButton();
  });
  es.addEventListener("portal", (e) => {
    const { done, total, portal } = JSON.parse(e.data);
    progress = { done, total };
    mergePortal(portal);
    updateRefreshButton();
  });
  es.addEventListener("done", (e) => {
    const { fetchedAt } = JSON.parse(e.data);
    streamActive = false;
    updateFetchedAt(fetchedAt);
    updateRefreshButton();
    load();
  });
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) {
      streamActive = false;
      updateRefreshButton();
    }
  });
}

/* ---------------- Setup ---------------- */

let tentDropdown = null;
let areaDropdown = null;

function initControls() {
  tentDropdown = makeDropdown(
    "tent",
    state.tents,
    () =>
      dedupe(OPTIONS.map((o) => o.portalId))
        .map((id) => {
          const o = OPTIONS.find((x) => x.portalId === id);
          return { value: id, label: o.portalName };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    (n, count) =>
      n === 0 ? count ? "Alle Festzelte ▾" : "Keine Festzelte ▾" : n === 1 ? "1 Festzelt ▾" : `${n} Festzelte ▾`,
  );
  areaDropdown = makeDropdown(
    "area",
    state.areas,
    () => dedupe(OPTIONS.flatMap((o) => o.areas)).sort((a, b) => a.localeCompare(b)).map((a) => ({ value: a, label: a })),
    (n, count) =>
      n === 0 ? count ? "Alle Bereiche ▾" : "Keine Bereiche ▾" : n === 1 ? "1 Bereich ▾" : `${n} Bereiche ▾`,
  );
  buildShiftChips();

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

function activeFilterCount() {
  return (
    (state.tents.size ? 1 : 0) +
    (state.shifts.size ? 1 : 0) +
    (state.areas.size ? 1 : 0) +
    (state.dateFrom || state.dateTo ? 1 : 0) +
    (state.weekendOnly ? 1 : 0) +
    (state.search ? 1 : 0)
  );
}

function updateFilterToggle() {
  const count = activeFilterCount();
  const badge = document.getElementById("filter-count");
  badge.textContent = count;
  badge.hidden = count === 0;
}

async function load() {
  if (streamActive) return; // SSE is driving the view
  const res = await fetch("/api/availability");
  const data = await res.json();
  applySnapshot(data);
}

async function loadStatus() {
  try {
    const status = await (await fetch("/api/status")).json();
    if (status.scrapeIntervalMin > 0) {
      document.getElementById("sched-info").textContent =
        ` · Automatische Aktualisierung alle ${status.scrapeIntervalMin} Minuten`;
    }
  } catch {
    /* ignore */
  }
}

document.getElementById("refresh").addEventListener("click", async () => {
  if (streamActive) return;
  try {
    await fetch("/api/refresh", { method: "POST" });
  } catch (err) {
    console.error(err);
  }
});

document.getElementById("subscribe").addEventListener("click", () => setSubscribe(!state.subscribe));
document.getElementById("notify-close").addEventListener("click", dismissNotify);

readParams();

// Reflect a subscription persisted in the URL (?sub=1).
document.getElementById("subscribe").classList.toggle("active", state.subscribe);
document.getElementById("subscribe-label").textContent = state.subscribe ? "Abonniert ✓" : "Abonnieren";

load();
loadStatus();
openStream();

const filterToggle = document.getElementById("filter-toggle");
const filters = document.getElementById("filters");

filterToggle.addEventListener("click", () => {
  const open = filters.classList.toggle("open");
  filterToggle.classList.toggle("open", open);
  filterToggle.setAttribute("aria-expanded", String(open));
});

if (activeFilterCount() > 0) {
  filters.classList.add("open");
  filterToggle.classList.add("open");
  filterToggle.setAttribute("aria-expanded", "true");
}

setInterval(() => {
  if (!streamActive) load();
}, 60_000);