// Rank picker: pressing play on a drill whose bots shoot back asks who you face first.
// Every lobby launch of a training drill goes through the game's wl(), which hands the drill to
// window.__aimPlayGate (tools/rankpick_patch.py). Tiles: "No return fire" (only when the drill
// has an Easy twin: starts that twin, see drill-variants.js), "Default" (the drill's own bots)
// and Iron..Radiant (localStorage "aim-enemy-rank", read by the game when a round starts,
// tools/bot_patch.py). The last pick per drill is kept in "aim-rank-picks" and shown on its card.
// Drill info comes from /aim/drill-variants.json (main.js), keyed by every code of a drill.
// The card chip is a button: it opens the same picker in pick-only mode (saves the pick for that
// drill, starts nothing, leaves the global "aim-enemy-rank" alone). Also callable as
// window.__aimRankPicker.openFor(code).
(() => {
  if (window.__aimRankPicker) return;
  const api = (window.__aimRankPicker = {});
  const RANK_KEY = "aim-enemy-rank";
  const PICKS_KEY = "aim-rank-picks";
  const FAV_KEY = "aim-offline-favorites-v1";
  const FAV_DONE_KEY = "aim-favorites-merged-v1";
  const NONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5 19 19 5"/></svg>';

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch { return false; } };
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
          // error: main.js could not read the list; the drills just start without a picker.
          if (!j.error) migrateFavorites();
          schedule();
        }
      })
      .catch(() => {})
      .finally(() => { loading = null; });
    return loading;
  }
  load();
  // Drills whose spots are picked by rank (app/mods/aim-ranks/spot-scores.json, tools/spot_scores.mjs):
  // their picker says so under the rank tiles.
  let spotCodes = null;
  fetch("/aim-ranks/spot-scores.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const set = new Set();
      for (const e of Object.values(j?.scenes || {})) for (const c of e?.codes || []) set.add(c);
      spotCodes = set;
    })
    .catch(() => {});
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
        if (next.length !== list.length && !put(FAV_KEY, JSON.stringify(next))) return;
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
    const back = open.returnFocus;
    open = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
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

  // opts.pickOnly: the card chip. A choice is saved for this drill and nothing starts.
  function openPicker(group, item, go, opts = {}) {
    close();
    const pickOnly = !!opts.pickOnly;
    const def = defaultRank(group);
    const shade = document.createElement("div");
    shade.className = "es-tool-shade aim-pick-shade";
    shade.innerHTML = `<section class="es-tool aim-pick" role="dialog" aria-modal="true" aria-label="Pick enemy rank">
      <header class="es-tool-head"><div><h2></h2><p></p></div>
      <button type="button" class="es-tool-x" aria-label="Close">✕</button></header>
      <div class="es-tool-body" role="radiogroup" aria-label="Enemy rank"><div class="aim-pick-top"></div><div class="aim-pick-grid"></div><p class="aim-pick-hint" hidden>Low ranks stand on common spots, high ranks use off-angles.</p><p class="aim-pick-note" role="status"></p></div></section>`;
    shade.querySelector("h2").textContent = group.title || item.name || "Drill";
    shade.querySelector(".es-tool-head p").textContent = pickOnly ? "Pick who you face. Enter saves, Esc cancels." : "Pick who you face. Enter plays your last pick, Esc cancels.";
    const top = shade.querySelector(".aim-pick-top");
    const grid = shade.querySelector(".aim-pick-grid");
    const note = shade.querySelector(".aim-pick-note");
    if (spotCodes && (spotCodes.has(group.code) || spotCodes.has(item.shareCode))) shade.querySelector(".aim-pick-hint").hidden = false;
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
      if (pickOnly) return;
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
      const x = shade.querySelector(".es-tool-x");
      if (e.key === "Tab") {
        // Focus stays in the picker: the selected tile and Close.
        e.preventDefault();
        if (document.activeElement === x) (tiles.find((t) => t.classList.contains("is-active")) || tiles[0]).focus();
        else x.focus();
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (document.activeElement === x) { close(); return; }
        const a = tiles.find((t) => t.classList.contains("is-active")) || tiles[0];
        choose(a.dataset.pick);
        return;
      }
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        const i = tiles.findIndex((t) => t.classList.contains("is-active"));
        tiles[(i + step + tiles.length) % tiles.length].focus();
      } else e.preventDefault();
    };
    addEventListener("keydown", onKey, true);
    document.body.appendChild(shade);
    open = { shade, onKey, returnFocus: opts.returnFocus || null };
    const first = tiles.find((t) => t.dataset.pick === current) || tiles[0];
    mark(first);
    first.focus({ preventScroll: true });
  }

  // Studio "Play" (studio-launch.js) tests the drill as it was made: no picker, no rank.
  // A play pressed before the drill list arrived waits for it, but any click or key in the
  // meantime (the player moved on) or a read slower than 3 s drops that launch.
  let waiting = null;
  const dropWaiting = () => { waiting = null; };
  function gate(item, go) {
    if (open || waiting || !item) return;
    const code = item.shareCode;
    if (window.__aimStudioPlay && window.__aimStudioPlay === code) {
      window.__aimStudioPlay = null;
      setRank(null);
      go(item);
      return;
    }
    if (!variants) {
      const w = (waiting = { at: Date.now() });
      setTimeout(() => {
        addEventListener("pointerdown", dropWaiting, { capture: true, once: true });
        addEventListener("keydown", dropWaiting, { capture: true, once: true });
      }, 0);
      load().finally(() => {
        removeEventListener("pointerdown", dropWaiting, true);
        removeEventListener("keydown", dropWaiting, true);
        if (waiting !== w || Date.now() - w.at > 3000) {
          if (waiting === w) waiting = null;
          return;
        }
        waiting = null;
        try {
          decide(item, go);
        } catch (err) {
          console.error("RANK PICKER:", err);
          close();
          go(item);
        }
      });
      return;
    }
    load();
    decide(item, go);
  }
  function decide(item, go) {
    const group = variants?.[item.shareCode];
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
        chip = document.createElement("button");
        chip.type = "button";
        chip.className = "aim-rank-chip";
        chip.addEventListener("click", onChip);
        const host = card.querySelector(".al-wk-body") || card;
        host.append(chip);
      }
      chip.dataset.key = c.key;
      if (c.rank) chip.dataset.rank = c.rank;
      else delete chip.dataset.rank;
      chip.title = "Enemy rank for this drill. Click to change.";
      chip.innerHTML = c.html;
      chip.setAttribute("aria-label", c.key === "pick" ? "Pick enemy rank" : `Enemy rank: ${chip.textContent}. Change`);
    }
  }
  function onChip(e) {
    const card = e.currentTarget.closest(".al-wk-card[data-share-code]");
    if (!card) return;
    // The card itself starts nothing on click, but keep the click to the chip anyway.
    e.preventDefault();
    e.stopPropagation();
    const name = card.querySelector("h3")?.textContent.trim() || "";
    api.openFor(card.dataset.shareCode, { name, returnFocus: e.currentTarget });
  }
  // Pick-only picker for one drill. Returns false when the drill has no bots that shoot back.
  api.openFor = (code, { name = "", returnFocus = null } = {}) => {
    const show = () => {
      const group = variants?.[code];
      if (!group || open) return false;
      openPicker(group, { shareCode: code, name }, null, { pickOnly: true, returnFocus });
      return true;
    };
    if (variants) return show();
    // The list is slow to arrive: open only if it came within 3 s (like a waiting play).
    const at = Date.now();
    load()?.then(() => { if (Date.now() - at <= 3000) show(); });
    return false;
  };

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
