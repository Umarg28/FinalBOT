"use strict";

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const money = (n) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
const pct = (n) => `${n >= 0 ? "" : ""}${n.toFixed(1)}%`;
const cls = (n) => (n >= 0 ? "pos" : "neg");
const pf = (n) => (n === null || n === undefined ? "—" : n === Infinity || n > 1e6 ? "∞" : n.toFixed(2));
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
let currentMarketTypeFilter = "";
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "daily") loadDaily();
  if (name === "markets") loadMarkets();
  if (name === "analysis") loadAnalysis();
}

// ── Overview ────────────────────────────────────────────────────────────────────
async function loadOverview() {
  const data = await api("/api/overview");
  // tunnel
  const link = $("#tunnel-link");
  if (data.tunnelUrl && data.tunnelStatus === "live") {
    link.href = data.tunnelUrl;
    link.textContent = data.tunnelUrl.replace("https://", "");
    link.classList.remove("pending");
  } else {
    const labels = {
      disabled: "tunnel: local only",
      starting: "tunnel: starting…",
      validating: "tunnel: validating link…",
      down: "tunnel: reconnecting…",
    };
    link.textContent = labels[data.tunnelStatus] || "tunnel: …";
    link.removeAttribute("href");
    link.classList.add("pending");
  }
  $("#btn-ai").disabled = !data.aiEnabled;
  if (!data.aiEnabled) $("#btn-ai").title = "Set ANTHROPIC_API_KEY in analytics/.env to enable";
  const sinceEl = $("#since-note");
  if (sinceEl) {
    sinceEl.textContent =
      data.sinceDate && data.sinceDate.toLowerCase() !== "all"
        ? `showing data since ${data.sinceDate}`
        : "showing all data";
  }

  // readiness
  const r = data.readiness;
  const rd = $("#readiness");
  rd.className = `readiness ${r.verdict}`;
  rd.innerHTML = `<div class="verdict">Go-live: ${r.verdict.replace("-", " ").toUpperCase()}</div><div class="summary">${r.summary}</div>`;

  // cards
  const o = data.overview;
  const cards = [
    ["Net PnL", money(o.totalPnl), cls(o.totalPnl)],
    ["Win rate", `${o.winRate.toFixed(1)}%`, o.winRate >= 90 ? "pos" : o.winRate >= 70 ? "" : "neg"],
    ["Profit factor", pf(o.profitFactor), o.profitFactor >= 2 ? "pos" : "neg"],
    ["ROI", `${o.roi.toFixed(1)}%`, cls(o.roi)],
    ["Markets", String(o.count), ""],
    ["Best type", o.bestMarketType || "—", "pos"],
    ["Worst type", o.worstMarketType || "—", "neg"],
  ];
  const wrap = $("#overview-cards");
  wrap.innerHTML = "";
  for (const [label, value, c] of cards) {
    const card = el("div", "card");
    card.appendChild(el("div", "label", label));
    card.appendChild(el("div", `value ${c}`, value));
    wrap.appendChild(card);
  }

  renderMarketTypeTable(data.byMarketType);
}

function renderMarketTypeTable(rows) {
  const cols = ["Type", "Markets", "Win%", "PnL", "Avg", "ROI", "PF", "Best", "Worst"];
  const table = el("table");
  const thead = el("thead");
  thead.appendChild(rowOf("th", cols));
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const t of rows) {
    const tr = el("tr", "clickable");
    tr.innerHTML =
      `<td>${t.key} ${t.profitable ? '<span class="pill win">profit</span>' : '<span class="pill loss">loss</span>'}</td>` +
      `<td>${t.count}</td><td>${t.winRate.toFixed(0)}%</td>` +
      `<td class="${cls(t.totalPnl)}">${money(t.totalPnl)}</td>` +
      `<td class="${cls(t.avgPnl)}">${money(t.avgPnl)}</td>` +
      `<td class="${cls(t.roi)}">${t.roi.toFixed(1)}%</td>` +
      `<td>${pf(t.profitFactor)}</td>` +
      `<td class="pos">${money(t.bestPnl)}</td><td class="neg">${money(t.worstPnl)}</td>`;
    tr.addEventListener("click", () => {
      currentMarketTypeFilter = t.key;
      switchTab("markets");
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $("#market-type-table").innerHTML = "";
  $("#market-type-table").appendChild(table);
}

function rowOf(tag, cells) {
  const tr = el("tr");
  for (const c of cells) tr.appendChild(el(tag, null, c));
  return tr;
}

// ── Daily ─────────────────────────────────────────────────────────────────────
async function loadDaily() {
  $("#daily-table").innerHTML = '<div class="loading">Loading…</div>';
  $("#daily-detail").innerHTML = "";
  const days = await api("/api/daily");
  const table = el("table");
  const thead = el("thead");
  thead.appendChild(rowOf("th", ["Date", "Markets", "Win%", "PnL", "ROI", "PF"]));
  table.appendChild(thead);
  const tbody = el("tbody");
  for (const d of days) {
    const tr = el("tr", "clickable");
    tr.innerHTML =
      `<td>${d.date}</td><td>${d.count}</td><td>${d.winRate.toFixed(0)}%</td>` +
      `<td class="${cls(d.totalPnl)}">${money(d.totalPnl)}</td>` +
      `<td class="${cls(d.roi)}">${d.roi.toFixed(1)}%</td><td>${pf(d.profitFactor)}</td>`;
    tr.addEventListener("click", () => loadDailyDetail(d.date));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $("#daily-table").innerHTML = "";
  $("#daily-table").appendChild(table);
  if (days.length === 0) $("#daily-table").innerHTML = '<div class="loading">No data yet.</div>';
}

async function loadDailyDetail(date) {
  const data = await api(`/api/daily/${encodeURIComponent(date)}`);
  const box = $("#daily-detail");
  box.innerHTML = `<h4>${date} — by market type</h4>`;
  const t1 = el("table");
  t1.appendChild(buildThead(["Type", "Markets", "Win%", "PnL", "ROI"]));
  const b1 = el("tbody");
  for (const t of data.byMarketType) {
    b1.appendChild(htmlRow([t.key, t.count, `${t.winRate.toFixed(0)}%`, money(t.totalPnl), `${t.roi.toFixed(1)}%`], { 3: cls(t.totalPnl) }));
  }
  t1.appendChild(b1);
  const w1 = el("div", "table-wrap");
  w1.appendChild(t1);
  box.appendChild(w1);

  box.appendChild(el("h4", null, `${date} — every market`));
  box.appendChild(marketsTable(data.markets));
}

// ── Markets ─────────────────────────────────────────────────────────────────────
async function loadMarkets() {
  const sel = $("#markets-filter");
  // populate filter from market types once
  if (!sel.dataset.ready) {
    const ov = await api("/api/overview");
    sel.innerHTML = '<option value="">All types</option>' + ov.byMarketType.map((t) => `<option value="${t.key}">${t.key}</option>`).join("");
    sel.dataset.ready = "1";
    sel.addEventListener("change", () => {
      currentMarketTypeFilter = sel.value;
      renderMarketsList();
    });
  }
  sel.value = currentMarketTypeFilter;
  renderMarketsList();
}

async function renderMarketsList() {
  $("#markets-table").innerHTML = '<div class="loading">Loading…</div>';
  const q = currentMarketTypeFilter ? `?type=${encodeURIComponent(currentMarketTypeFilter)}` : "";
  $("#markets-filter-label").textContent = currentMarketTypeFilter ? `· ${currentMarketTypeFilter}` : "";
  const markets = await api(`/api/markets${q}`);
  $("#markets-table").innerHTML = "";
  $("#markets-table").appendChild(marketsTable(markets));
  if (markets.length === 0) $("#markets-table").innerHTML = '<div class="loading">No markets.</div>';
}

// Clear card-per-market list (replaces the cramped table) — mirrors the bot's
// PnL report: outcome, prominent PnL, shares & avg cost per side.
function marketsTable(markets) {
  const wrap = el("div", "market-list");
  if (markets.length === 0) {
    wrap.innerHTML = '<div class="loading">No markets.</div>';
    return wrap;
  }
  for (const m of markets) {
    const card = el("div", `market-card clickable ${m.win ? "win" : "loss"}`);
    card.innerHTML =
      `<div class="mc-head">
         <div class="mc-name">${shortName(m.marketName)}<span class="mc-type">${m.marketType}</span></div>
         <div class="mc-pnl">
           <span class="mc-pnl-value ${cls(m.totalPnl)}">${money(m.totalPnl)}</span>
           <span class="mc-pnl-pct ${cls(m.pnlPercent)}">${m.pnlPercent >= 0 ? "+" : ""}${m.pnlPercent.toFixed(1)}%</span>
         </div>
       </div>
       <div class="mc-grid">
         <div><span class="k">Result</span><span class="v">${m.outcome} won <span class="pill ${m.win ? "win" : "loss"}">${m.win ? "WIN" : "LOSS"}</span></span></div>
         <div><span class="k">Invested</span><span class="v">$${m.invested.toFixed(2)}</span></div>
         <div><span class="k">Payout</span><span class="v">$${m.payout.toFixed(2)}</span></div>
         <div><span class="k">UP</span><span class="v">${m.sharesUp.toFixed(0)} sh @ $${m.avgCostUp.toFixed(3)}</span></div>
         <div><span class="k">DOWN</span><span class="v">${m.sharesDown.toFixed(0)} sh @ $${m.avgCostDown.toFixed(3)}</span></div>
       </div>`;
    card.addEventListener("click", () => openMarketDetail(m.conditionId));
    wrap.appendChild(card);
  }
  return wrap;
}

async function openMarketDetail(id) {
  const body = $("#market-detail-body");
  body.innerHTML = '<div class="loading">Loading…</div>';
  $("#market-detail").classList.remove("hidden");
  const data = await api(`/api/market/${encodeURIComponent(id)}`);
  const m = data.market;
  const a = data.analysis;
  const upWon = m.outcome === "UP";
  let html = `<h3>${m.marketName}</h3>`;
  html += `<p class="hint">${m.marketType} · ${m.date}</p>`;

  // Headline PnL
  html += `<div class="detail-headline ${m.win ? "win" : "loss"}">
      <div class="dh-pnl ${cls(m.totalPnl)}">${money(m.totalPnl)} <span>${m.pnlPercent >= 0 ? "+" : ""}${m.pnlPercent.toFixed(1)}%</span></div>
      <div class="dh-outcome">${m.outcome} won <span class="pill ${m.win ? "win" : "loss"}">${m.win ? "WIN" : "LOSS"}</span></div>
    </div>`;

  // Per-side breakdown table (like the PnL report)
  html += `<table class="detail-table"><thead><tr><th>Side</th><th>Shares</th><th>Avg cost</th><th>Settles</th><th>Payout</th></tr></thead><tbody>
      <tr class="${upWon ? "side-win" : "side-lose"}"><td>UP</td><td>${m.sharesUp.toFixed(2)}</td><td>$${m.avgCostUp.toFixed(3)}</td><td>$${m.settlePriceUp.toFixed(2)}</td><td>$${(m.sharesUp * m.settlePriceUp).toFixed(2)}</td></tr>
      <tr class="${!upWon ? "side-win" : "side-lose"}"><td>DOWN</td><td>${m.sharesDown.toFixed(2)}</td><td>$${m.avgCostDown.toFixed(3)}</td><td>$${m.settlePriceDown.toFixed(2)}</td><td>$${(m.sharesDown * m.settlePriceDown).toFixed(2)}</td></tr>
    </tbody></table>`;
  html += `<div class="detail-totals">
      <span>Invested <b>$${m.invested.toFixed(2)}</b></span>
      <span>Payout <b>$${m.payout.toFixed(2)}</b></span>
      <span>Net PnL <b class="${cls(m.totalPnl)}">${money(m.totalPnl)}</b></span>
    </div>`;

  html += '<h4>Why this happened</h4><div class="findings">';
  for (const f of a.findings) html += `<div class="finding ${f.level}">${f.text}</div>`;
  html += "</div>";
  html += `<h4>Adjustment</h4><ul class="suggestions"><li>${a.suggestion}</li></ul>`;
  body.innerHTML = html;
}
$("#market-detail-close").addEventListener("click", () => $("#market-detail").classList.add("hidden"));
$("#market-detail").addEventListener("click", (e) => {
  if (e.target.id === "market-detail") $("#market-detail").classList.add("hidden");
});

// ── Analysis ────────────────────────────────────────────────────────────────────
async function loadAnalysis() {
  const data = await api("/api/analysis");
  const f = $("#findings");
  f.className = "findings";
  f.innerHTML = data.findings.map((x) => `<div class="finding ${x.level}">${x.text}</div>`).join("");
  $("#suggestions").innerHTML = data.suggestions.map((s) => `<li>${s}</li>`).join("");
}
$("#btn-ai").addEventListener("click", async () => {
  const out = $("#ai-output");
  out.classList.remove("hidden");
  out.textContent = "🤖 Asking Claude…";
  try {
    const data = await api("/api/analysis/ai");
    out.textContent = data.text;
  } catch (e) {
    out.textContent = `AI analysis failed: ${e.message}`;
  }
});

// ── Tunnel rotate + refresh ─────────────────────────────────────────────────────
$("#btn-rotate").addEventListener("click", async () => {
  const btn = $("#btn-rotate");
  btn.disabled = true;
  $("#tunnel-link").textContent = "tunnel: rotating…";
  try {
    await api("/api/tunnel/rotate", { method: "POST" });
    // poll until the new link is validated and live (or give up after ~90s)
    let tries = 0;
    const poll = setInterval(async () => {
      tries++;
      const { status } = await api("/api/tunnel");
      $("#tunnel-link").textContent = `tunnel: ${status === "validating" ? "validating link…" : "rotating…"}`;
      if (status === "live" || tries > 40) {
        clearInterval(poll);
        btn.disabled = false;
        loadOverview();
      }
    }, 2000);
  } catch (e) {
    btn.disabled = false;
    $("#tunnel-link").textContent = `tunnel error: ${e.message}`;
  }
});
$("#btn-refresh").addEventListener("click", () => location.reload());

// ── Boot ────────────────────────────────────────────────────────────────────────
function shortName(name) {
  // "Bitcoin Up or Down - June 21, 12:25PM-12:30PM ET" -> "Jun 21, 12:25-12:30PM"
  const m = name.match(/-\s*([A-Za-z]+ \d+),?\s*(.+?)\s*ET/);
  return m ? `${m[1]}, ${m[2]}` : name;
}
function buildThead(cells) {
  const thead = el("thead");
  thead.appendChild(rowOf("th", cells));
  return thead;
}
function htmlRow(cells, classMap) {
  const tr = el("tr");
  cells.forEach((c, i) => {
    const td = el("td", classMap && classMap[i] ? classMap[i] : null, String(c));
    tr.appendChild(td);
  });
  return tr;
}

loadOverview().catch((e) => {
  $("#readiness").innerHTML = `<div class="summary">Failed to load: ${e.message}</div>`;
});
setInterval(() => { if ($("#view-overview").classList.contains("active")) loadOverview(); }, 15000);
