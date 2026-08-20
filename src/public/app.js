async function load() {
  const res = await fetch("/api/availability");
  const data = await res.json();
  render(data);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function renderDetails(bl) {
  const parts = [];
  const groups = bl.seatplanGroups.concat(bl.seatplanAreas);
  if (groups.length) parts.push(groups.map((g) => g.label).join(", "));
  if (bl.startTimes.length) parts.push(bl.startTimes.map((t) => t.label).join(" · "));
  if (bl.paxOptions.length) parts.push(bl.paxOptions.map((p) => p.label).join(" · "));
  if (bl.simplePax.length) parts.push(bl.simplePax.map((p) => p.label).join(" · "));
  return parts.join(" — ");
}

function renderPortal(portal) {
  const statusClass = portal.error
    ? "error"
    : portal.closed
      ? "closed"
      : "open";
  const statusLabel = portal.error
    ? "Fehler"
    : portal.closed
      ? "Keine Termine"
      : "Verfügbar";

  const dateHtml = portal.dates.length
    ? portal.dates
        .map((d) => {
          if (d.bookingLists.length === 0) {
            return `<div class="date"><h3>${escapeHtml(d.label)}</h3><span class="empty">Keine Kontingente</span></div>`;
          }
          const blHtml = d.bookingLists
            .map((bl) => {
              const detail = renderDetails(bl);
              return `<div class="bl"><span class="bl-label">${escapeHtml(bl.label)}</span>${detail ? ` <span class="detail">· ${escapeHtml(detail)}</span>` : ""}</div>`;
            })
            .join("");
          return `<div class="date"><h3>${escapeHtml(d.label)}</h3>${blHtml}</div>`;
        })
        .join("")
    : `<span class="muted">Keine Daten</span>`;

  return `
    <section class="portal">
      <div class="portal-head">
        <h2><a href="${escapeHtml(portal.url)}" target="_blank" rel="noopener">${escapeHtml(portal.name)}</a></h2>
        <span class="status ${statusClass}">${statusLabel}</span>
      </div>
      ${portal.error ? `<div class="error-msg">${escapeHtml(portal.error)}</div>` : ""}
      ${dateHtml}
    </section>
  `;
}

function render(data) {
  const app = document.getElementById("app");
  const fetched = document.getElementById("fetched-at");
  if (data.fetchedAt) {
    const d = new Date(data.fetchedAt);
    fetched.textContent = "Zuletzt aktualisiert: " + d.toLocaleString("de-DE");
  }
  if (!data.portals || data.portals.length === 0) {
    app.innerHTML = '<p class="muted">Noch keine Daten vorhanden. Klicken Sie auf „Aktualisieren".</p>';
    return;
  }
  app.innerHTML = data.portals.map(renderPortal).join("");
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
      } else if (attempts++ < 300) {
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

load();
setInterval(load, 60_000);