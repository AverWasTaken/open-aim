// Lobby top bar: the left sidebar is hidden by theme-esports.css, and its Quick
// start and items (Favorites, Training Creator, Workshop manual, ...) are shown as
// buttons in the top bar instead. Each button clicks the hidden sidebar item, so
// the game's own handlers (and its links) keep working unchanged.
(() => {
  if (window.__aimLobbyBar) return;
  window.__aimLobbyBar = true;

  const SHORT = { favorites: "Favorites", "open-studio": "Creator", "open-studio-guide": "Manual" };
  const GAUGE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14l4-5"/></svg>';

  // Spike-ish diamond with a fuse, for Round mode.
  const ROUND_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 20 12 12 21 4 12Z"/><path d="M12 8v5M12 16v.5"/></svg>';
  const SENS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>';
  const BACKUP_ICON ='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v12H4z"/><path d="M3 4h18v3H3zM10 11h4"/></svg>';

  // The single game-render meter is owned by frame-meter.js.
  function meterOn() { return window.__aimFrameMeter?.enabled() ?? false; }
  function setMeter(on) { window.__aimFrameMeter?.setEnabled(on); }
  addEventListener('aim-frame-meter-change', () => {
    for (const button of document.querySelectorAll('.es-bar-fps')) button.classList.toggle('is-on', meterOn());
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

  function sync() {
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
        // Creator opens the Studio (studio/), which replaces the site's editor.
        if (key === "open-studio") return location.assign("/studio/");
        const live = railItems().find((it, j) => keyOf(it, j) === key);
        if (live) live.click();
      });
      bar.appendChild(btn);
    });

    const fps = document.createElement("button");
    fps.type = "button";
    fps.className = "es-bar-btn es-bar-fps" + (meterOn() ? " is-on" : "");
    fps.title = "FPS meter: live frame rate, frame time and 1% low (also shown during rounds)";
    fps.innerHTML = GAUGE;
    const fpsLabel = document.createElement("span");
    fpsLabel.textContent = "FPS";
    fps.appendChild(fpsLabel);
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
    round.title = "Round (beta): one VALORANT-style round vs 5 bots on Ascent — barriers, plant the spike";
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
