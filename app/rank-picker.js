// Rank picker: pressing play on a drill whose bots shoot back asks who you face first.
// Every lobby launch of a training drill goes through the game's wl(), which hands the drill to
// window.__aimPlayGate (tools/rankpick_patch.py). Tiles: "No return fire" (only when the drill
// has an Easy twin: starts that twin, see drill-variants.js), "Default" (the drill's own bots)
// and Iron..Radiant (localStorage "aim-enemy-rank", read by the game when a round starts,
// tools/bot_patch.py). The last pick per drill is kept in "aim-rank-picks" and shown on its card.
// Drill info comes from /aim/drill-variants.json (main.js), keyed by every code of a drill.
(() => {
  if (window.__aimRankPicker) return;
  window.__aimRankPicker = true;
  const RANK_KEY = "aim-enemy-rank";
  const PICKS_KEY = "aim-rank-picks";
  const FAV_KEY = "aim-offline-favorites-v1";
  const FAV_DONE_KEY = "aim-favorites-merged-v1";
  const NONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5 19 19 5"/></svg>';

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const ranks = () => window.__aimBots?.RANKS || [];
  const rankName = (id) => ranks().find((r) => r[0] === id)?.[1] || "";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const setRank = (id) => {
    put(RANK_KEY, id && ranks().some((r) => r[0] === id) ? id : null);
    dispatchEvent(new Event("aim-bot-settings-change"));
  };

  // ---------- drill info ----------
  let variants = null;
  let loading = null;
  function load() {
    loading ??= fetch("/aim/drill-variants.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j && j.variants && typeof j.variants === "object") {
          variants = j.variants;
          migrateFavorites();
          schedule();
        }
      })
      .catch(() => {})
      .finally(() => { loading = null; });
    return loading;
  }
  load();
  // Studio drills change while the app runs; read again when the window comes back.
  addEventListener("focus", () => load());

  // The rank the drill's own bots play like: its strongest shooter (same math as the game,
  // window.__aimBots.rankOf in bot-settings.js).
  function defaultRank(group) {
    const rankOf = window.__aimBots?.rankOf;
    if (!rankOf) return "";
    let best = -1;
    for (const b of group.bots || []) best = Math.max(best, ranks().findIndex((r) => r[0] === rankOf(b)));
    return best < 0 ? "" : ranks()[best][0];
  }

  function picks() {
    try {
      const v = JSON.parse(get(PICKS_KEY) || "{}");
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  function lastPick(group) {
    const v = picks()[group.code];
    if (v === "none") return group.easy ? "none" : "";
    return v === "default" || ranks().some((r) => r[0] === v) ? v : "";
  }
  function savePick(group, v) {
    const all = picks();
    all[group.code] = v;
    put(PICKS_KEY, JSON.stringify(all));
  }

  // Favourites made on an Easy twin (or an older copy) move to the merged card, once.
  // The old entry stays; the favourites list shows only drills that are in the training list.
  function migrateFavorites() {
    if (get(FAV_DONE_KEY) === "1") return;
    try {
      const list = JSON.parse(get(FAV_KEY) || "[]");
      if (Array.isArray(list)) {
        const next = [...list];
        for (const key of list) {
          const code = typeof key === "string" && key.startsWith("ws-") ? key.slice(3) : null;
          const group = code && variants[code];
          if (group && group.code !== code && !next.includes("ws-" + group.code)) next.push("ws-" + group.code);
        }
        if (next.length !== list.length) put(FAV_KEY, JSON.stringify(next));
      }
      put(FAV_DONE_KEY, "1");
    } catch {}
  }

  // ---------- picker ----------
  let open = null;

  function close() {
    if (!open) return;
    removeEventListener("keydown", open.onKey, true);
    open.shade.remove();
    open = null;
  }

  function tile(value, label, sub, icon) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "aim-pick-tile";
    b.dataset.pick = value;
    if (value !== "none" && value !== "default") b.dataset.rank = value;
    b.innerHTML = `<span class="aim-pick-icon">${icon}</span><span class="aim-pick-text"><span class="aim-pick-name">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</span>`;
    return b;
  }
  const rankImg = (id) => (id ? `<img src="/aim-ranks/${id}.png" alt="" draggable="false">` : NONE_ICON);

  function openPicker(group, item, go) {
    close();
    const def = defaultRank(group);
    const shade = document.createElement("div");
    shade.className = "es-tool-shade aim-pick-shade";
    shade.innerHTML = `<section class="es-tool aim-pick" role="dialog" aria-modal="true" aria-label="Pick enemy rank">
      <header class="es-tool-head"><div><h2></h2><p>Pick who you face. Enter plays your last pick, Esc cancels.</p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body" role="radiogroup" aria-label="Enemy rank"><div class="aim-pick-top"></div><div class="aim-pick-grid"></div><p class="aim-pick-note" role="status"></p></div></section>`;
    shade.querySelector("h2").textContent = group.title || item.name || "Drill";
    const top = shade.querySelector(".aim-pick-top");
    const grid = shade.querySelector(".aim-pick-grid");
    const note = shade.querySelector(".aim-pick-note");
    const notes = {};
    if (group.easy) {
      top.append(tile("none", "No return fire", "Bots don't shoot", NONE_ICON));
      notes.none = "The drill's Easy version: same route, bots never shoot back. Scores are kept apart from the ranked version.";
    }
    top.append(tile("default", "Default", def ? `Drill's own bots · ${rankName(def)}` : "Drill's own bots", rankImg(def)));
    notes.default = `The drill's own bots${def ? `, about ${rankName(def)}` : ""}.`;
    for (const r of ranks()) {
      grid.append(tile(r[0], r[1], "", rankImg(r[0])));
      notes[r[0]] = `Reacts in about ${r[2][0].toFixed(2)}–${r[2][1].toFixed(2)} s, aim error ${r[3]}°, aims at your ${r[4] ? "head" : "body"}.`;
    }
    const tiles = [...top.children, ...grid.children];
    const current = lastPick(group) || "default";
    const mark = (b) => {
      for (const t of tiles) {
        const on = t === b;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-checked", String(on));
        t.tabIndex = on ? 0 : -1;
      }
      note.textContent = notes[b.dataset.pick] || "";
    };
    // Runs inside the click / key handler (no await before go), so the game's fullscreen
    // request still counts as a user action.
    const choose = (v) => {
      close();
      savePick(group, v);
      schedule();
      if (v === "none") {
        setRank(null);
        go(item.shareCode === group.easy.shareCode ? item : group.easy);
        return;
      }
      setRank(v === "default" ? null : v);
      go(item.shareCode === group.item.shareCode ? item : group.item);
    };
    for (const t of tiles) {
      t.setAttribute("role", "radio");
      t.addEventListener("click", (e) => { e.stopPropagation(); choose(t.dataset.pick); });
      t.addEventListener("mouseenter", () => { note.textContent = notes[t.dataset.pick] || ""; });
      t.addEventListener("focus", () => mark(t));
    }
    shade.querySelector(".es-tool-body").addEventListener("mouseleave", () => { const a = tiles.find((t) => t.classList.contains("is-active")); if (a) note.textContent = notes[a.dataset.pick] || ""; });
    // Clicks never fall through to the cards under the picker.
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) shade.addEventListener(type, (e) => e.stopPropagation());
    shade.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target === shade) close();
    });
    shade.querySelector(".es-tool-x").addEventListener("click", (e) => { e.stopPropagation(); close(); });
    const onKey = (e) => {
      if (!open) return;
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const a = tiles.find((t) => t.classList.contains("is-active")) || tiles[0];
        choose(a.dataset.pick);
        return;
      }
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        const i = tiles.findIndex((t) => t.classList.contains("is-active"));
        tiles[(i + step + tiles.length) % tiles.length].focus();
      } else if (e.key !== "Tab") e.preventDefault();
    };
    addEventListener("keydown", onKey, true);
    document.body.appendChild(shade);
    open = { shade, onKey };
    const first = tiles.find((t) => t.dataset.pick === current) || tiles[0];
    mark(first);
    first.focus({ preventScroll: true });
  }

  // Studio "Play" (studio-launch.js) tests the drill as it was made: no picker, no rank.
  function gate(item, go) {
    if (open || !item) return;
    const code = item.shareCode;
    if (window.__aimStudioPlay && window.__aimStudioPlay === code) {
      window.__aimStudioPlay = null;
      setRank(null);
      go(item);
      return;
    }
    const group = variants?.[code];
    load();
    if (!group) {
      // No bots that shoot back (or a drill made since the last read): the drill's own setup.
      setRank(null);
      go(item);
      return;
    }
    openPicker(group, item, go);
  }
  window.__aimPlayGate = (item, go) => {
    try {
      gate(item, go);
    } catch (err) {
      console.error("RANK PICKER:", err);
      close();
      go(item);
    }
  };

  // ---------- card chips ----------
  // Cards of drills with bots show the last pick (or "Pick rank"); target-only drills show nothing.
  function chipFor(group) {
    const v = lastPick(group);
    if (v === "none") return { key: "none", html: `${NONE_ICON}<span>No return fire</span>` };
    if (v === "default") {
      const d = defaultRank(group);
      return { key: "default:" + d, rank: d, html: `${rankImg(d)}<span>Default${d ? " · " + esc(rankName(d)) : ""}</span>` };
    }
    if (v) return { key: v, rank: v, html: `${rankImg(v)}<span>${esc(rankName(v))}</span>` };
    return { key: "pick", html: "<span>Pick rank</span>" };
  }

  function decorate() {
    if (!variants) return;
    for (const card of document.querySelectorAll(".al-wk-card[data-share-code]")) {
      const group = variants[card.dataset.shareCode];
      let chip = card.querySelector(":scope .aim-rank-chip");
      if (!group) {
        chip?.remove();
        continue;
      }
      const c = chipFor(group);
      if (chip && chip.dataset.key === c.key) continue;
      if (!chip) {
        chip = document.createElement("span");
        chip.className = "aim-rank-chip";
        const host = card.querySelector(".al-wk-body") || card;
        host.append(chip);
      }
      chip.dataset.key = c.key;
      if (c.rank) chip.dataset.rank = c.rank;
      else delete chip.dataset.rank;
      chip.title = "Enemy rank you picked last for this drill";
      chip.innerHTML = c.html;
    }
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; decorate(); });
  }
  window.__aimWatchPage?.(schedule, { childList: true, subtree: true });
  addEventListener("storage", schedule);
  schedule();
})();
