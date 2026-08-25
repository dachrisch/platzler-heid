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
let streamActive = false;
let progress = { done: 0, total: 0 };

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

/* ---------------- Email notifications ---------------- */

function currentFilter() {
  return {
    tents: [...state.tents],
    shifts: [...state.shifts],
    areas: [...state.areas],
    from: state.dateFrom,
    to: state.dateTo,
    weekend: state.weekendOnly,
    search: state.search,
  };
}

const subscribeBtn = document.getElementById("subscribe");
const subscribePanel = document.getElementById("subscribe-panel");
const subscribeForm = document.getElementById("subscribe-form");
const subscribeEmail = document.getElementById("subscribe-email");
const subscribeMsg = document.getElementById("subscribe-msg");
const subscribeLabel = document.getElementById("subscribe-label");

function showSubscribeMsg(text, ok) {
  subscribeMsg.textContent = text;
  subscribeMsg.classList.toggle("ok", ok);
  subscribeMsg.classList.toggle("err", !ok);
  subscribeMsg.hidden = false;
}

function openSubscribePanel() {
  subscribeMsg.hidden = true;
  subscribePanel.hidden = false;
  subscribeEmail.focus();
}

function setSubscribeState(state) {
  if (state === "active") {
    subscribeLabel.textContent = "Aktiv ✓";
    subscribeBtn.classList.add("active");
  } else if (state === "pending") {
    subscribeLabel.textContent = "Bestätigung ausstehend ✓";
    subscribeBtn.classList.add("active");
  } else {
    subscribeLabel.textContent = "Benachrichtigen";
    subscribeBtn.classList.remove("active");
    localStorage.removeItem("subscribed");
    localStorage.removeItem("subscribed-email");
  }
}

subscribeBtn.addEventListener("click", () => {
  subscribePanel.hidden = !subscribePanel.hidden;
  if (!subscribePanel.hidden) openSubscribePanel();
});
document.getElementById("subscribe-close").addEventListener("click", () => {
  subscribePanel.hidden = true;
});

subscribeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!subscribeEmail.checkValidity()) {
    subscribeEmail.reportValidity();
    return;
  }
  subscribeForm.querySelector("button[type=submit]").disabled = true;
  try {
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: subscribeEmail.value, filter: currentFilter() }),
    });
    if (!res.ok) throw new Error("request failed");
    showSubscribeMsg(
      "Bestätigungs-E-Mail gesendet — klicke den Link in der E-Mail, um dein Abonnement zu aktivieren.",
      true,
    );
    subscribeLabel.textContent = "Bestätigung ausstehend ✓";
    subscribeBtn.classList.add("active");
    localStorage.setItem("subscribed", "1");
    localStorage.setItem("subscribed-email", subscribeEmail.value.trim().toLowerCase());
  } catch (err) {
    console.error(err);
    showSubscribeMsg("Abonnieren fehlgeschlagen — bitte erneut versuchen.", false);
  } finally {
    subscribeForm.querySelector("button[type=submit]").disabled = false;
  }
});

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
  es.addEventListener("subscription-confirmed", (e) => {
    const { email } = JSON.parse(e.data);
    if (email && email === localStorage.getItem("subscribed-email")) {
      setSubscribeState("active");
    }
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

readParams();

// Reflect a persisted subscription (localStorage) in the button state.
const subscribedEmail = localStorage.getItem("subscribed-email");
if (subscribedEmail) {
  setSubscribeState("pending");
  refreshSubscriptionState();
} else if (localStorage.getItem("subscribed") === "1") {
  setSubscribeState("pending");
}

// Reconcile the button with the server-side double opt-in status, e.g. after
// confirming via the link in the email or when the SSE event was missed.
async function refreshSubscriptionState() {
  const email = localStorage.getItem("subscribed-email");
  if (!email) return;
  try {
    const res = await fetch(`/api/subscription-status?email=${encodeURIComponent(email)}`);
    if (!res.ok) return;
    const { status } = await res.json();
    if (status === "active") setSubscribeState("active");
    else if (status === "pending") setSubscribeState("pending");
    else setSubscribeState("none");
  } catch (err) {
    console.error(err);
  }
}
setInterval(refreshSubscriptionState, 30000);

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