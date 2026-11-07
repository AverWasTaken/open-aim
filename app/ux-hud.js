// HUD extras during a run: a hit marker at the crosshair and a kills line under the stat box
// on bot drills ("Kills 7/10 · HS 60%").
// Events come from tools/ux_hud_patch.py (OkAdunfX.js): "aim-hit" once per shot that hits,
// "aim-hud" when the stat box changes. Both fire inside the 128 Hz game tick, so the listeners
// only store the values and ask for one animation frame; all page work happens there.
// Setting: Settings > Visuals (range tab) > "Hit marker", localStorage["aim-ux-hitmarker"]
// ("off" = hidden, anything else = shown).
(() => {
  if (window.__aimUxHud) return;
  const KEY = "aim-ux-hitmarker";

  // Pure logic (also used by scripts/test-ux-hit.mjs through window.__aimUxHud).
  const pct = (part, whole) => Math.round((part / whole) * 100);
  function killsText(d) {
    const kills = d.total != null ? `${d.kills}/${d.total}` : `${d.kills}`;
    const hs = d.humanoidHits > 0 ? `${pct(d.headshots, d.humanoidHits)}%` : "-";
    return `Kills ${kills} · HS ${hs}`;
  }
  // Bot drills only: a fixed target count or a hit on a humanoid. Not kills > 0: ball and grid
  // drills count their targets as kills too.
  function shouldShowKills(d, roundOn) {
    return !!d && !roundOn && (d.total != null || d.humanoidHits > 0);
  }
  // Ball/grid hits get the plain marker; a kill on them is not a kill marker.
  function markerVariant(d) {
    return { head: !!d.head && !d.dot, kill: !!d.kill && !d.dot };
  }
  const readOn = () => {
    try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
  };

  let markerOn = readOn();
  let phase = null;
  let hit = null; // merged hits since the last frame
  let hud = null; // latest aim-hud detail of this run
  let hudDirty = false;
  let frame = 0;
  let marker = null;
  let markerAnim = null;
  let kills = null;
  let placed = false; // kills line top computed for the current layout

  const roundOn = () => document.documentElement.classList.contains("aim-round-on") || !!window.__aimRoundOn;
  const live = () => phase === "running";

  function css() {
    if (document.getElementById("ux-hud-style")) return;
    const style = document.createElement("style");
    style.id = "ux-hud-style";
    style.textContent = `
.ux-hitmarker{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;opacity:0;z-index:2;
 color:var(--es-text,#f4f5f7);--ux-hm-gap:5px;--ux-hm-len:6px;--ux-hm-w:2px;filter:drop-shadow(0 0 1px rgba(0,0,0,.9))}
.ux-hitmarker.is-head{color:#ffd166}
.ux-hitmarker.is-kill{--ux-hm-gap:7px;--ux-hm-len:9px;--ux-hm-w:3px}
.ux-hitmarker i{position:absolute;left:calc(var(--ux-hm-w)/-2);top:calc(-1*(var(--ux-hm-gap) + var(--ux-hm-len)));
 width:var(--ux-hm-w);height:var(--ux-hm-len);background:currentColor;
 transform-origin:50% calc(var(--ux-hm-gap) + var(--ux-hm-len))}
.ux-hitmarker i:nth-child(1){transform:rotate(45deg)}
.ux-hitmarker i:nth-child(2){transform:rotate(135deg)}
.ux-hitmarker i:nth-child(3){transform:rotate(225deg)}
.ux-hitmarker i:nth-child(4){transform:rotate(315deg)}
.ux-hud-kills{position:absolute;left:50%;transform:translateX(-50%);pointer-events:none;white-space:nowrap;
 padding:4px 10px;background:rgba(9,11,15,.82);color:var(--es-soft,#d6d9df);
 font:700 11px/1.2 var(--es-head,"Bahnschrift",sans-serif);font-stretch:75%;text-transform:uppercase;
 letter-spacing:.06em;font-variant-numeric:tabular-nums}
.ux-hud-kills[hidden]{display:none}`;
    (document.head || document.documentElement).append(style);
  }

  // The marker lives in the crosshair's follow wrapper (StageCrosshair), so it moves with the
  // crosshair offset; fallback: the middle of the HUD.
  function markerHost() {
    return document.querySelector(".al-center-crosshair")?.parentElement || document.querySelector(".al-hud");
  }
  function showMarker(v) {
    const host = markerHost();
    if (!host) return;
    if (!marker) {
      marker = document.createElement("div");
      marker.className = "ux-hitmarker";
      marker.setAttribute("aria-hidden", "true");
      marker.innerHTML = "<i></i><i></i><i></i><i></i>";
    }
    if (marker.parentElement !== host) host.append(marker);
    marker.classList.toggle("is-head", v.head);
    marker.classList.toggle("is-kill", v.kill);
    markerAnim?.cancel();
    const show = v.kill ? 170 : 120, fade = v.kill ? 110 : 80;
    markerAnim = marker.animate(
      [{ opacity: 1 }, { opacity: 1, offset: show / (show + fade) }, { opacity: 0 }],
      { duration: show + fade, easing: "linear" },
    );
  }
  function hideMarker() {
    markerAnim?.cancel();
    markerAnim = null;
  }

  function renderKills() {
    const host = document.querySelector(".al-hud");
    const show = live() && host && shouldShowKills(hud, roundOn());
    if (!show) {
      if (kills) kills.hidden = true;
      return;
    }
    if (!kills) {
      kills = document.createElement("div");
      kills.className = "ux-hud-kills";
      kills.dataset.role = "ux-hud-kills";
    }
    const text = killsText(hud);
    if (kills.parentElement === host && placed && !kills.hidden && kills.textContent === text) return;
    if (kills.parentElement !== host) {
      host.append(kills);
      placed = false;
    }
    // Just under the stat box chips. Rects are read before any write, and only when the line is
    // first placed or the window was resized, not on every stat change.
    if (!placed) {
      const box = host.getBoundingClientRect();
      const chip = host.querySelector(".al-hud-top .al-hud-chip") || host.querySelector(".al-hud-top");
      const scale = host.offsetHeight > 0 ? box.height / host.offsetHeight : 1;
      const bottom = chip ? chip.getBoundingClientRect().bottom : 0;
      kills.style.top = `${Math.round((bottom > box.top ? (bottom - box.top) / (scale || 1) : 72) + 6)}px`;
      placed = bottom > box.top;
    }
    if (kills.textContent !== text) kills.textContent = text;
    kills.hidden = false;
  }

  function flush() {
    frame = 0;
    if (hit) {
      const v = hit;
      hit = null;
      if (markerOn && live()) showMarker(v);
    }
    if (hudDirty) {
      hudDirty = false;
      renderKills();
    }
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  window.addEventListener("aim-hit", (e) => {
    const d = e && e.detail;
    if (!d || !markerOn || !live()) return;
    const v = markerVariant(d);
    hit = hit ? { head: hit.head || v.head, kill: hit.kill || v.kill } : v;
    schedule();
  });
  window.addEventListener("aim-hud", (e) => {
    if (!e || !e.detail) return;
    hud = e.detail;
    hudDirty = true;
    schedule();
  });
  window.addEventListener("resize", () => {
    placed = false;
    hudDirty = true;
    schedule();
  });
  window.addEventListener("aim-round-phase", (e) => {
    const d = (e && e.detail) || {};
    phase = d.phase || null;
    // No reset on a new run: the game's run reset (To) sends a fresh aim-hud before "running".
    if (phase !== "running" && phase !== "paused") placed = false;
    if (!live()) {
      hit = null;
      hideMarker();
    }
    hudDirty = true;
    schedule();
  });

  // Settings row "Hit marker", after the game's "Hit effects" switch (same HallSwitch markup).
  function setOn(on) {
    markerOn = on;
    try {
      if (on) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "off");
    } catch {}
    if (!on) hideMarker();
    dispatchEvent(new Event("aim-ux-hitmarker-change"));
  }
  function addRow() {
    const anchor = document.querySelector('[data-setting="hitBursts"]');
    const parent = anchor?.parentElement;
    if (!parent || parent.querySelector('[data-setting="uxHitMarker"]')) return;
    const scoped = [...anchor.attributes].filter((a) => a.name.startsWith("data-v-")).map((a) => a.name);
    const row = document.createElement("label");
    row.className = "hall-field hall-switch";
    row.dataset.setting = "uxHitMarker";
    row.dataset.focus = "uxHitMarker";
    row.innerHTML =
      '<span class="hall-field-text"><span class="hall-field-head"><b>Hit marker</b>' +
      '<em class="hall-field-local" title="Saved on this PC only">This PC only</em></span>' +
      "<small>Short ticks around the crosshair when a shot hits. Yellow for a headshot, bigger for a kill on a bot.</small></span>" +
      '<input class="hall-switch-input" type="checkbox"><span class="hall-switch-track" aria-hidden="true"><i></i></span>';
    for (const el of [row, ...row.querySelectorAll("*")]) for (const attr of scoped) el.setAttribute(attr, "");
    const input = row.querySelector("input");
    input.addEventListener("change", () => setOn(input.checked));
    function render() {
      if (!row.isConnected) {
        removeEventListener("aim-ux-hitmarker-change", render);
        return;
      }
      input.checked = markerOn;
      row.classList.toggle("is-on", markerOn);
    }
    anchor.after(row);
    addEventListener("aim-ux-hitmarker-change", render);
    render();
  }

  // setMarker: same as the settings switch (used by scripts/ux/hit-check.mjs).
  window.__aimUxHud = { killsText, shouldShowKills, markerVariant, setMarker: (on) => setOn(!!on) };
  css();
  let queued = false;
  const watch = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!live()) addRow(); // no settings page during a run; skip the lookups on HUD updates
    });
  };
  if (typeof window.__aimWatchPage === "function") window.__aimWatchPage(watch, { childList: true, subtree: true });
  addRow();
})();
