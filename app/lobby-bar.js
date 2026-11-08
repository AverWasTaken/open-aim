// Lobby top bar: the left sidebar is hidden by theme-esports.css, and its Quick
// start and items (Favorites, Studio, Workshop manual, ...) are shown as
// buttons in the top bar instead. Each button clicks the hidden sidebar item, so
// the game's own handlers (and its links) keep working unchanged.
(() => {
  if (window.__aimLobbyBar) return;
  window.__aimLobbyBar = true;

  const SHORT = { favorites: "Favorites", "open-studio": "Studio", "open-studio-guide": "Manual" };
  const GAUGE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/></svg>';

  // Spike-ish diamond with a fuse, for Round mode.
  const ROUND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 20 12 12 21 4 12Z"/><path d="M12 8v5M12 16v.5"/></svg>';
  const SENS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>';
  const BACKUP_ICON ='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v12H4z"/><path d="M3 4h18v3H3zM10 11h4"/></svg>';

  // The single game-render meter is owned by frame-meter.js.
  function meterOn() { return window.__aimFrameMeter?.enabled() ?? false; }
  function setMeter(on) { window.__aimFrameMeter?.setEnabled(on); }
  addEventListener('aim-frame-meter-change', () => {
    for (const button of document.querySelectorAll('.es-bar-fps')) {
      button.classList.toggle('is-on', meterOn());
      button.setAttribute('aria-pressed', String(meterOn()));
    }
  });

  const PLAY = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M7 4.5v15l13-7.5z"/></svg>';

  function railItems() {
    const rail = document.querySelector(".hall-rail");
    // Items the sidebar itself kept hidden stay hidden (the rail is display:none, so check each item's own display).
    // The workshop guide page was never saved offline, so its link would open a 404.
    return rail
      ? [...rail.querySelectorAll(".hall-rail-item")].filter((it) => getComputedStyle(it).display !== "none" && it.dataset.action !== "open-studio-guide")
      : [];
  }

  function keyOf(item, i) {
    return item.dataset.action || `item-${i}`;
  }

  // The bar sits in the top nav just before the Sens box (.hall-topnav-right, whose
  // other children the site's overrides hide).
  function build(right) {
    const bar = document.createElement("div");
    bar.className = "es-bar";
    right.before(bar);
    return bar;
  }

  // Scroll only the lobby's drill list (.hall-board-body), never the fixed lobby frame
  // around it (scrollIntoView would also scroll overflow:hidden parents).
  // align "start": element at the top of the list; "nearest": only if not fully visible.
  function scrollInBoard(el, align) {
    const board = el.closest(".hall-board-body");
    if (!board) { el.scrollIntoView({ block: align === "start" ? "start" : "nearest" }); return; }
    const e = el.getBoundingClientRect(), b = board.getBoundingClientRect();
    const top = b.top + (parseFloat(getComputedStyle(board).scrollPaddingTop) || 0);
    if (align === "start" || e.top < top) board.scrollTop += e.top - top;
    else if (e.bottom > b.bottom) board.scrollTop += Math.min(e.bottom - b.bottom, e.top - top);
  }

  // Keyboard: a "Skip to drills" link (first stop in the top nav, shown only on focus),
  // and no tab stops on the hidden file input or the small Sens arrows (the Sens box's
  // own arrow keys still change the value).
  function focusFirstDrill() {
    const card = document.querySelector(".hall-board-body .al-wk-card, .al-wk-card");
    if (!card) return;
    const target = card.querySelector('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') || card;
    if (target === card && !card.hasAttribute("tabindex")) card.tabIndex = -1;
    target.focus({ preventScroll: true });
    // Shelf rows scroll sideways: bring the row back to its start so the first card shows.
    const row = card.closest(".al-wk-pages");
    if (row) row.scrollLeft = 0;
    scrollInBoard(card, "nearest");
  }

  function syncKeyboard() {
    const nav = document.querySelector(".hall-root .hall-topnav");
    if (nav) {
      let skip = nav.querySelector(":scope > .es-skip");
      if (!skip) {
        skip = document.createElement("a");
        skip.className = "es-skip";
        skip.href = "#";
        skip.textContent = "Skip to drills";
        skip.addEventListener("click", (e) => {
          e.preventDefault();
          focusFirstDrill();
        });
      }
      if (nav.firstElementChild !== skip) nav.prepend(skip);
      // Only on views that list drill cards.
      const hide = !document.querySelector(".al-wk-card");
      if (skip.hidden !== hide) skip.hidden = hide;
    }
    for (const el of document.querySelectorAll(".hall-scene-import-file, .hall-sens-stepper button")) {
      if (el.getAttribute("tabindex") !== "-1") el.setAttribute("tabindex", "-1");
    }
  }

  // Search: when results (or the "no match" line) first show up, scroll them into view.
  // Only on that first appearance, not on every keystroke; focus stays in the search box.
  let searchShown = false;
  function syncSearchScroll() {
    const el = document.querySelector('[data-role="workshop-search"], [data-role="workshop-search-empty"]');
    if (!el) { searchShown = false; return; }
    if (searchShown) return;
    searchShown = true;
    scrollInBoard(el, "start");
  }

  function sync() {
    syncKeyboard();
    syncSearchScroll();
    const right = document.querySelector(".hall-topnav > .hall-topnav-right");
    if (!right) return;
    const prev = right.previousElementSibling;
    const bar = prev && prev.classList.contains("es-bar") ? prev : build(right);

    // Signature of what the sidebar shows now; rebuild the buttons only when it changes.
    const quick = document.querySelector(".hall-rail-quick");
    const items = railItems();
    const sig = [quick ? quick.querySelector("em")?.textContent || "q" : "", ...items.map((it, i) => keyOf(it, i) + ":" + it.textContent.trim() + ":" + it.classList.contains("is-active"))].join("|");
    if (bar.dataset.sig === sig) return;
    bar.dataset.sig = sig;
    bar.textContent = "";

    items.forEach((item, i) => {
      const key = keyOf(item, i);
      const label = item.textContent.trim();
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "es-bar-btn" + (item.classList.contains("is-active") ? " is-on" : "");
      btn.title = label;
      const icon = item.querySelector("svg");
      if (icon) btn.appendChild(icon.cloneNode(true));
      const span = document.createElement("span");
      span.textContent = SHORT[key] || label;
      btn.appendChild(span);
      btn.addEventListener("click", () => {
        // Studio opens studio/, which replaces the site's editor.
        if (key === "open-studio") return location.assign("/studio/");
        const live = railItems().find((it, j) => keyOf(it, j) === key);
        if (live) live.click();
      });
      bar.appendChild(btn);
    });

    const fps = document.createElement("button");
    fps.type = "button";
    fps.className = "es-bar-btn es-bar-fps" + (meterOn() ? " is-on" : "");
    fps.setAttribute("aria-pressed", String(meterOn()));
    fps.title = "FPS meter: live frame rate, frame time and 1% low (also shown during rounds)";
    fps.innerHTML = GAUGE;
    const fpsLabel = document.createElement("span");
    fpsLabel.textContent = "FPS";
    fps.appendChild(fpsLabel);
    fps.insertAdjacentHTML("beforeend", '<i class="es-bar-dot" aria-hidden="true"></i>');
    fps.addEventListener("click", () => setMeter(!meterOn()));
    bar.appendChild(fps);

    // Panels from player-tools.js.
    for (const [label, title, icon, open] of [
      ["Sens tools", "Sensitivity tools: eDPI, cm/360 and converter from other games", SENS_ICON, "openSens"],
      ["Backups", "Back up, restore, export or import your training data", BACKUP_ICON, "openBackups"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "es-bar-btn";
      b.title = title;
      b.innerHTML = icon;
      const s = document.createElement("span");
      s.textContent = label;
      b.appendChild(s);
      b.addEventListener("click", () => window.__aimTools?.[open]());
      bar.appendChild(b);
    }

    // Round mode (round-panel.js).
    const round = document.createElement("button");
    round.type = "button";
    round.className = "es-bar-btn";
    round.title = "Round (beta): one VALORANT-style round vs 5 bots on Ascent. Wait out the barriers, then plant the spike.";
    round.innerHTML = ROUND_ICON;
    const roundLabel = document.createElement("span");
    roundLabel.textContent = "Round (beta)";
    round.appendChild(roundLabel);
    round.addEventListener("click", () => window.__aimRoundPanel?.open());
    bar.appendChild(round);

    if (quick) {
      const name = quick.querySelector("em")?.textContent.trim() || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "es-bar-quick";
      btn.title = name ? `Quick start: ${name}` : "Quick start";
      btn.innerHTML = PLAY;
      const span = document.createElement("span");
      span.textContent = "Quick start";
      btn.appendChild(span);
      btn.addEventListener("click", () => document.querySelector(".hall-rail-quick")?.click());
      bar.appendChild(btn);
    }

    for (const b of bar.querySelectorAll("button")) {
      b.setAttribute("aria-label", b.querySelector("span")?.textContent.trim() || b.title);
    }
  }

  // Use native wheel scrolling and the active tab fill for direct feedback.

  let queued = false;
  window.__aimWatchPage(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  }, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  sync();
})();
