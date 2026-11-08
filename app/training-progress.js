// Training progress (read-only): a "Your skills" section in TRAINING HISTORY (skill cards with the
// last 14 days vs the 14 before, a "What to practise" hint with a Play button, a per-drill trend
// chart) and a "PB · runs" chip on lobby drill cards. All numbers come from the game's run store
// (al-workshop-runs-v1), plus aim habits from the training analytics store
// (aim-training-analytics-v1, written by training-analytics.js); the math is in
// training-progress-core.js (window.aimTrainingProgress), loaded just before this file. Nothing is
// written to storage.
(() => {
  if (window.__aimTrainingProgress) return;
  window.__aimTrainingProgress = true;
  const core = window.aimTrainingProgress;
  if (!core) return;
  const LIST_URL = "/prod-api/api/v1/public/val/aimlab/workshop";
  const VARIANTS_URL = "/aim/drill-variants.json";

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- data ----------
  let rawCache = null;
  let runsCache = [];
  function runs() {
    let raw = null;
    try {
      raw = localStorage.getItem(core.RUNS_KEY);
    } catch {}
    if (raw !== rawCache) {
      rawCache = raw;
      runsCache = core.parseRuns(raw);
    }
    return runsCache;
  }

  // Runs with aim habits from the analytics store (aim-training-analytics-v1) joined in; read
  // again only when either store changed. Used by the history section only.
  let analyticsRaw = null;
  let joinedRuns = null;
  let joinedFrom = null;
  function joined() {
    const list = runs();
    let raw = null;
    try {
      raw = localStorage.getItem(core.ANALYTICS_KEY);
    } catch {}
    if (raw !== analyticsRaw || list !== joinedFrom || !joinedRuns) {
      analyticsRaw = raw;
      joinedFrom = list;
      joinedRuns = core.joinAnalytics(list, core.parseAnalytics(raw));
    }
    return joinedRuns;
  }

  // Training list (Easy twins left out, Studio drills included) and the twin map. Studio drills
  // change while the app runs, so both are read again when the window comes back.
  let items = null;
  let catalogue = new Map();
  let variants = {};
  let loadVersion = 0;
  let loadedText = "";
  let loading = null;
  const getText = (url) => fetch(url, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
  const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
  function load() {
    loading ??= Promise.all([getText(LIST_URL), getText(VARIANTS_URL)])
      .then(([listText, vText]) => {
        // Nothing changed since the last read (the usual case on focus): no redraw.
        if (listText + "\n" + vText === loadedText) return;
        loadedText = listText + "\n" + vText;
        const list = json(listText);
        const v = json(vText);
        if (list && Array.isArray(list.data)) {
          items = list.data;
          catalogue = core.indexCatalogue(items);
        }
        if (v && v.variants && typeof v.variants === "object") variants = v.variants;
        loadVersion += 1;
        schedule();
      })
      .finally(() => { loading = null; });
    return loading;
  }
  load();
  addEventListener("focus", () => load());

  // ---------- lobby card chips ----------
  // Same best and run count as the card's Stats side (its own code only).
  function decorateCards(cards) {
    const list = runs();
    for (const card of cards) {
      const code = card.dataset.shareCode;
      const type = catalogue.get(code)?.type ?? list.find((r) => r.shareCode === code)?.type ?? null;
      const text = core.chipText(core.cardSummary(list, code, type));
      let chip = card.querySelector(":scope .tp-chip");
      // Only on the card's front (the Stats side has no .al-wk-body).
      const host = card.querySelector(".al-wk-body");
      if (chip && chip.parentNode !== host) {
        chip.remove();
        chip = null;
      }
      if (!text || !host) {
        chip?.remove();
        continue;
      }
      if (chip && chip.dataset.text === text) continue;
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "tp-chip";
        chip.title = "Your best and run count on this drill (same as its Stats side)";
        host.append(chip);
      }
      chip.dataset.text = text;
      chip.textContent = text;
    }
  }

  // ---------- history section ----------
  const ui = { drill: null, metric: "accuracy" };
  let section = null;
  let signature = "";

  function deltaHtml(metric, d) {
    const x = core.fmtDelta(metric, d);
    const cls = x.good === null ? "" : x.good ? " is-good" : " is-bad";
    const title = x.good === null ? "" : ` title="vs the 14 days before"`;
    return `<span class="tp-delta${cls}" data-dir="${x.dir}"${title}>${esc(x.text)}</span>`;
  }

  function cardsHtml(stats) {
    return stats.map((s) => {
      const rows = core.METRICS.filter((m) => !(s.id === "ball" && m.id === "headshot")).map((m) =>
        `<div class="tp-stat"><dt>${esc(m.label)}</dt><dd><b>${esc(core.fmt(m.id, s.recent[m.id]))}</b>${deltaHtml(m.id, s.delta[m.id])}</dd></div>`).join("");
      const n = s.recent.runs;
      return `<div class="tp-card${n ? "" : " is-empty"}" data-skill="${esc(s.id)}">
        <div class="tp-card-head"><h4>${esc(s.label)}</h4><span>${n} ${n === 1 ? "run" : "runs"}</span></div>
        <dl class="tp-stats">${rows}</dl>${habitsHtml(s)}</div>`;
    }).join("");
  }

  // "Aim habits" rows under a skill card's metrics: each habit with enough samples of its own in
  // the last 14 days (core.CARD_MIN_N), with the game's tier word where the game has one (under
  // the label, so the value and change stay in the same column as the rows above).
  function habitsHtml(s) {
    if (!s.recent.runs) return "";
    const shown = core.HABITS.filter((h) => typeof s.recent[h.id] === "number");
    if (!shown.length) return `<p class="tp-habits-none">Not enough data for aim habits yet.</p>`;
    const rows = shown.map((h) => {
      const v = s.recent[h.id];
      const tier = core.habitTier(h.id, v);
      const tag = tier ? `<span class="tp-tier" data-tier="${tier}">${esc(core.TIER_WORDS[tier])}</span>` : "";
      return `<div class="tp-stat tp-habit" title="${esc(h.tip)}"><dt>${esc(h.label)}${tag ? " " + tag : ""}</dt><dd><b>${esc(core.fmt(h.id, v))}</b>${deltaHtml(h.id, s.delta[h.id])}</dd></div>`;
    }).join("");
    return `<div class="tp-habits"><span class="tp-cap">Aim habits</span><dl class="tp-stats">${rows}</dl></div>`;
  }

  function hintHtml(stats, list) {
    // Wait for the training list: the candidates are the lobby types it has.
    if (!items) return "";
    const spot = core.practiseHint(stats, core.candidateSkills(items));
    if (!spot) return "";
    const drill = core.drillForSkill(spot.skill, list, catalogue, variants, items);
    const btn = drill && window.__aimLaunchWorkshop
      ? `<button type="button" class="tp-play" data-act="play" data-code="${esc(drill.shareCode)}">Play ${esc(core.drillName(drill.shareCode, catalogue, variants, list))}</button>`
      : "";
    return `<div class="tp-hint"><div><span class="tp-cap">What to practise</span><p>${esc(spot.text)}</p></div>${btn}</div>`;
  }

  const dateText = (at) => {
    const d = new Date(at);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  // Inline SVG line chart: one point per run (oldest left), dashed personal best line,
  // tooltips via <title>.
  function chartSvg(series) {
    const pts = series.points;
    const m = series.metric;
    if (pts.length < 2) return `<p class="tp-none">Not enough runs with this stat yet.</p>`;
    const W = 720, H = 190, L = 52, R = 16, T = 14, B = 26;
    const vals = pts.map((p) => p.value);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (m.unit === "%") {
      lo = Math.max(0, Math.floor((lo - 5) / 5) * 5);
      hi = Math.min(100, Math.ceil((hi + 5) / 5) * 5);
      if (hi - lo < 10) hi <= 90 ? (hi = lo + 10) : (lo = hi - 10);
    } else {
      lo = Math.max(0, Math.floor((lo * 0.9) / 50) * 50);
      hi = Math.ceil((hi * 1.1) / 50) * 50;
      if (hi - lo < 100) hi = lo + 100;
    }
    const x = (i) => L + (pts.length === 1 ? 0 : (i * (W - L - R)) / (pts.length - 1));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const grid = [lo, (lo + hi) / 2, hi].map((v) =>
      `<line class="tp-grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tp-axis" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(core.fmt(m.id, v))}</text>`).join("");
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const pb = series.pb === null ? "" :
      `<line class="tp-pb" x1="${L}" x2="${W - R}" y1="${y(series.pb).toFixed(1)}" y2="${y(series.pb).toFixed(1)}"/><text class="tp-pb-label" x="${W - R}" y="${(y(series.pb) - 5).toFixed(1)}" text-anchor="end">PB ${esc(core.fmt(m.id, series.pb))}</text>`;
    const dots = pts.map((p, i) => {
      const tip = `${dateText(p.at)}: ${core.fmt(m.id, p.value)}${p.easy ? " (no return fire)" : ""}`;
      return `<g class="tp-pt${p.easy ? " is-easy" : ""}"><title>${esc(tip)}</title><circle class="tp-hit" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="10"/><circle class="tp-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5"/></g>`;
    }).join("");
    const axis = `<text class="tp-axis" x="${L}" y="${H - 6}">Older</text><text class="tp-axis" x="${W - R}" y="${H - 6}" text-anchor="end">Newest</text>`;
    return `<svg class="tp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)} over the last ${pts.length} runs">${grid}${pb}<polyline class="tp-line" points="${line}"/>${dots}${axis}</svg>`;
  }

  function trendHtml(list) {
    const drills = core.drillList(list, catalogue, variants);
    if (!drills.length) return `<div class="tp-trend"><h4 class="tp-sub">Drill trend</h4><p class="tp-none">Play a drill twice to see its trend.</p></div>`;
    if (!drills.some((d) => d.code === ui.drill)) ui.drill = drills[0].code;
    const options = drills.map((d) =>
      `<option value="${esc(d.code)}"${d.code === ui.drill ? " selected" : ""}>${esc(d.name)}${d.merged ? " (incl. no return fire)" : ""} · ${d.runs} runs</option>`).join("");
    // Target drills have no headshots: no Headshot % tab for them.
    const type = catalogue.get(ui.drill)?.type ?? list.find((r) => core.groupCode(r.shareCode, variants) === ui.drill)?.type;
    // Aim habit tabs only when this drill has at least 2 runs with that habit.
    const metrics = [
      ...core.METRICS.filter((m) => !(type === "ball" && m.id === "headshot")),
      ...core.HABITS.filter((h) => core.drillSeries(list, ui.drill, h.id, variants).points.length >= 2),
    ];
    const metric = metrics.some((m) => m.id === ui.metric) ? ui.metric : "accuracy";
    const tabs = metrics.map((m) =>
      `<button type="button" class="tp-tab" data-act="metric" data-metric="${m.id}" aria-pressed="${m.id === metric}">${esc(m.label)}</button>`).join("");
    const series = core.drillSeries(list, ui.drill, metric, variants);
    const n = series.points.length;
    return `<div class="tp-trend">
      <div class="tp-trend-head"><h4 class="tp-sub">Drill trend</h4>
        <label class="tp-pick"><span class="tp-cap">Drill</span><select data-act="drill">${options}</select></label>
        <div class="tp-tabs" role="group" aria-label="Stat">${tabs}</div></div>
      ${chartSvg(series)}
      ${n >= 2 ? `<p class="tp-foot">Last ${n} runs with this stat, oldest to newest. Dashed line: your best.</p>` : ""}</div>`;
  }

  function render(list) {
    const stats = core.skillStats(list, { now: Date.now(), catalogue, variants });
    section.innerHTML = `<div class="tp-head"><h3>Your skills</h3><p>Last 14 days, with the change from the 14 days before.</p></div>
      ${hintHtml(stats, list)}
      <div class="tp-cards">${cardsHtml(stats)}</div>
      ${trendHtml(list)}`;
  }

  function play(code) {
    const item = catalogue.get(code);
    if (!item || !window.__aimLaunchWorkshop) return;
    // A drill open (or loading) over the lobby: close it first. The launch hook refuses while one
    // is open (its scene only loads when the layer mounts), so retry each frame for up to 3 s.
    if (window.__aimLaunchWorkshop(item)) return;
    if (!window.__aimLeaveTraining?.()) return;
    const until = performance.now() + 3000;
    const retry = () => {
      if (!window.__aimLaunchWorkshop(item) && performance.now() < until) requestAnimationFrame(retry);
    };
    requestAnimationFrame(retry);
  }

  function createSection() {
    const el = document.createElement("section");
    el.className = "tp-sec";
    el.dataset.role = "training-progress";
    el.addEventListener("click", (e) => {
      const b = e.target.closest?.("[data-act]");
      if (!b || !el.contains(b)) return;
      if (b.dataset.act === "play") play(b.dataset.code);
      else if (b.dataset.act === "metric" && b.dataset.metric !== ui.metric) {
        ui.metric = b.dataset.metric;
        schedule();
      }
    });
    el.addEventListener("change", (e) => {
      if (e.target?.dataset?.act === "drill") {
        ui.drill = e.target.value;
        schedule();
      }
    });
    return el;
  }

  // Inserted before the drill list ([data-role=records-projects]) of the history tab, which the
  // game re-renders: find-or-create, put back in place if moved, removed with the history (empty
  // state has no .rov-top). DOM is written only when the data or the picked drill/stat changed.
  function syncHistory(scroll) {
    if (!scroll || !scroll.querySelector(":scope > .rov-top")) {
      if (section?.isConnected) section.remove();
      return;
    }
    if (!section) section = createSection();
    const anchor = scroll.querySelector(":scope > [data-role=records-projects]");
    if (section.parentNode !== scroll || (anchor ? section.nextElementSibling !== anchor : scroll.lastElementChild !== section)) {
      // Moving the select would drop its focus; only happens when the game re-renders.
      scroll.insertBefore(section, anchor);
    }
    const list = joined();
    const sig = () => [rawCache, analyticsRaw, loadVersion, ui.drill, ui.metric, Math.floor(Date.now() / 36e5)].join("|");
    if (sig() === signature && section.firstChild) return;
    render(list);
    // Taken after rendering: the render picks the default drill.
    signature = sig();
  }

  function sync() {
    const cards = document.querySelectorAll(".al-wk-card[data-share-code]");
    if (cards.length) decorateCards(cards);
    syncHistory(document.querySelector("[data-role=records-overview] .rov-scroll"));
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try {
        sync();
      } catch (err) {
        console.error("TRAINING PROGRESS:", err);
      }
    });
  }
  window.__aimWatchPage?.(schedule, { childList: true, subtree: true });
  addEventListener("aim-local-result", schedule);
  addEventListener("aim-run-stats", schedule);
  addEventListener("storage", schedule);
  schedule();
})();
