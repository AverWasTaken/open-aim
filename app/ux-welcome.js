/* First-run welcome: a "getting started" banner in the lobby, right under the VALORANT Training
   hero (the only lobby view with the hero). Three steps: set your sensitivity, pick a crosshair,
   play your first drill. Each step has buttons that open the right place.

   Who sees it (localStorage "ux-welcome-v1"): decided once, the first time the lobby exists.
   Key missing + no runs -> "shown" (new player); key missing + runs -> "done" (existing players
   never see it). "shown" stays until all three steps are done or the player clicks Hide, then
   "done". "done" never shows. Runs = al-workshop-runs-v1 or al-pw-runs-v1 is a non-empty array.
   The sensitivity and crosshair keys never decide who is new: a VALORANT import writes both and
   reloads the page.

   Step done: 1 = al-sensitivity-v1 exists or its Sens tools / import button was used; 2 =
   al-crosshair-v1 exists or "Crosshair settings" was used; 3 = a run exists. The game only saves
   sens and crosshair when they change, so using the button counts too
   (localStorage "ux-welcome-steps-v1", a JSON array of step ids).

   Hidden while the startup screen (.es-startup) or a run (.al-aimlab-root) is on the page, and
   on lobby views without the hero. Not hidden for dialogs: their shade covers it, and hiding
   would make the drill list jump. At 800px tall or less it is one 40px line; to make room the
   hero's "VALORANT TRAINING" heading is hidden and its padding trimmed while it shows
   (html.ux-welcome-on). Not the whole .al-wk-hero-copy: it also holds the featured drill.

   decide(), stepsDone(), place(), sig() and render() are tested in node
   (scripts/test-ux-welcome.mjs). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else if (root && root.document) api.install(root, root.document);
})(globalThis, function () {
  "use strict";

  const KEY = "ux-welcome-v1";
  const STEPS_KEY = "ux-welcome-steps-v1";
  const SENS_KEY = "al-sensitivity-v1";
  const CROSSHAIR_KEY = "al-crosshair-v1";
  const RUN_KEYS = ["al-workshop-runs-v1", "al-pw-runs-v1"];
  const ON_CLASS = "ux-welcome-on";
  const LOBBY = ".hall-root";
  const HERO = ".hall-root header.al-wk-hero";
  const BLOCKERS = [".es-startup", ".al-aimlab-root"];
  const COMPACT_MAX_H = 800;

  function get(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
  }
  function readArray(storage, key) {
    const raw = get(storage, key);
    if (raw == null) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function hasRuns(storage) {
    return RUN_KEYS.some((k) => readArray(storage, k).length > 0);
  }

  // [step1, step2, step3] done flags.
  function stepsDone(storage) {
    if (!storage) return [false, false, false];
    const used = readArray(storage, STEPS_KEY);
    return [
      get(storage, SENS_KEY) != null || used.includes("sens"),
      get(storage, CROSSHAIR_KEY) != null || used.includes("crosshair"),
      hasRuns(storage),
    ];
  }

  /* Reads (and on first sight or completion writes) ux-welcome-v1.
     Returns {show, value, steps}. Storage missing or throwing -> {show:false}. */
  function decide(storage) {
    const none = { show: false, value: null, steps: [false, false, false] };
    if (!storage) return none;
    let value;
    try {
      value = storage.getItem(KEY);
      if (value == null) {
        value = hasRuns(storage) ? "done" : "shown";
        storage.setItem(KEY, value);
      }
    } catch { return none; }
    // "done" (the usual case for existing players): no more reads on every page change.
    if (value !== "shown") return { show: false, value, steps: [false, false, false] };
    const steps = stepsDone(storage);
    if (steps.every(Boolean)) {
      try { storage.setItem(KEY, "done"); } catch { /* still hide */ }
      return { show: false, value: "done", steps };
    }
    return { show: true, value, steps };
  }

  // Puts the banner right after the hero (a sibling, never inside: Vue owns the hero's children).
  // No hero, or the startup screen / a run on the page: the banner comes out.
  // No DOM write when it already sits in the right spot. Returns true when placed.
  function place(doc, banner) {
    const hero = doc.querySelector(HERO);
    const blocked = BLOCKERS.some((s) => doc.querySelector(s));
    if (!hero || blocked) {
      if (banner.isConnected) banner.remove();
      return false;
    }
    if (hero.nextElementSibling !== banner) hero.after(banner);
    return true;
  }

  // State string: redraw only when it changes.
  function sig(state) {
    return `${state.compact ? "c" : "f"}${state.importer ? "i" : "-"}${state.steps.map((d) => (d ? 1 : 0)).join("")}`;
  }
  // The part of the state that needs new markup (step changes only swap classes).
  function layoutSig(state) {
    return `${state.compact ? "c" : "f"}${state.importer ? "i" : "-"}`;
  }

  const STEPS = [
    {
      n: 1, name: "Set your sensitivity", short: "Set sensitivity",
      text: "Match your VALORANT sens, or convert from another game.",
      acts: [["sens", "Sens tools"], ["import", "Import from VALORANT"]],
    },
    {
      n: 2, name: "Pick a crosshair", short: "Pick a crosshair",
      text: "Paste a VALORANT crosshair code or make your own.",
      acts: [["crosshair", "Crosshair settings"]],
    },
    {
      n: 3, name: "Play your first drill", short: "Play a drill",
      text: "Play the drill shown at the top.",
      acts: [["play", "Play featured drill"]],
    },
  ];
  const CHECK = '<svg class="ux-welcome-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>';
  const HIDE = '<button type="button" class="ux-welcome-hide" data-ux-welcome="hide" aria-label="Hide getting started steps">Hide</button>';

  function stepClass(steps, i) {
    const next = steps.indexOf(false);
    return `ux-welcome-step${steps[i] ? " is-done" : ""}${i === next ? " is-next" : ""}`;
  }

  // Banner inner HTML (static strings only).
  function render(state) {
    const steps = state.steps;
    if (state.compact) {
      const items = STEPS.map((s, i) => {
        const [act] = s.acts[0];
        return `<li class="${stepClass(steps, i)}" data-ux-welcome-step="${s.n}">` +
          `<button type="button" data-ux-welcome="${act}" title="${s.text}" aria-describedby="ux-welcome-d${s.n}">` +
          `<span class="ux-welcome-num">${s.n}</span><span class="ux-welcome-label">${s.short}</span>` +
          `<span class="ux-welcome-next">Next</span><span class="ux-welcome-done">${CHECK}<span class="ux-welcome-sr">Done</span></span>` +
          `</button><span class="ux-welcome-sr" id="ux-welcome-d${s.n}">${s.text}</span></li>`;
      }).join("");
      return `<p class="ux-welcome-title">New here?</p><ol class="ux-welcome-steps">${items}</ol>${HIDE}`;
    }
    const items = STEPS.map((s, i) => {
      const acts = s.acts
        .filter(([act]) => act !== "import" || state.importer)
        .map(([act, label]) => `<button type="button" data-ux-welcome="${act}">${label}</button>`)
        .join("");
      return `<li class="${stepClass(steps, i)}" data-ux-welcome-step="${s.n}"><div class="ux-welcome-copy">` +
        `<p class="ux-welcome-cap"><span>Step ${s.n}</span><span class="ux-welcome-next">Next</span>` +
        `<span class="ux-welcome-done">${CHECK}Done</span></p>` +
        `<h3 class="ux-welcome-name">${s.name}</h3><p class="ux-welcome-text" title="${s.text}">${s.text}</p></div>` +
        `<div class="ux-welcome-acts">${acts}</div></li>`;
    }).join("");
    return `<div class="ux-welcome-head"><h2 class="ux-welcome-title">New here? Three quick steps</h2>${HIDE}</div>` +
      `<ol class="ux-welcome-steps">${items}</ol>`;
  }

  // Draws the banner for a new state: new markup when the layout changes, else step classes only
  // (keeps the focused button, so a dialog can hand focus back to it).
  function paint(banner, state, prevLayout) {
    const layout = layoutSig(state);
    const cls = `ux-welcome${state.compact ? " is-compact" : ""}`;
    if (banner.className !== cls) banner.className = cls;
    if (layout !== prevLayout) {
      banner.innerHTML = render(state);
      return layout;
    }
    for (let i = 0; i < STEPS.length; i++) {
      const li = banner.querySelector(`[data-ux-welcome-step="${STEPS[i].n}"]`);
      const want = stepClass(state.steps, i);
      if (li && li.className !== want) li.className = want;
    }
    return layout;
  }

  const P = "html[data-aim-local]:not(#es) body";
  const CSS = `
${P} .ux-welcome{flex:none;position:relative;z-index:4;box-sizing:border-box;display:flex;align-items:stretch;gap:12px;
 margin:10px 32px 0;padding:8px 12px;color:var(--es-text);background:var(--es-panel);border-top:4px solid var(--es-red);
 outline:1px solid var(--es-line);outline-offset:-1px;clip-path:var(--es-cut);font-family:var(--es-head);text-align:left}
${P} .ux-welcome *{box-sizing:border-box}
${P} .ux-welcome p{margin:0}
${P} .ux-welcome-head{flex:0 0 128px;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;gap:6px}
${P} .ux-welcome-title{margin:0;color:var(--es-text);font:800 15px/1.15 var(--es-head)!important;font-stretch:75%!important;
 text-transform:uppercase!important;letter-spacing:.03em}
${P} .ux-welcome-steps{flex:1;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0;padding:0;list-style:none}
${P} .ux-welcome-step{min-width:0;display:flex;align-items:center;gap:10px;padding:6px 10px;margin:0;background:var(--es-raised);
 border-left:3px solid transparent}
${P} .ux-welcome-step.is-next{border-left-color:var(--es-red)}
${P} .ux-welcome-copy{flex:1;min-width:0}
${P} .ux-welcome-cap{display:flex;align-items:center;gap:6px;color:var(--es-muted);font:700 11px/13px var(--es-head);
 text-transform:uppercase;letter-spacing:.06em}
${P} .ux-welcome-next,${P} .ux-welcome-done{display:none}
${P} .ux-welcome .is-next .ux-welcome-next{display:inline;color:var(--es-red-2)}
${P} .ux-welcome .is-done .ux-welcome-done{display:inline-flex;align-items:center;gap:3px;color:var(--es-green)}
${P} .ux-welcome-check{width:12px;height:12px;flex:none}
${P} .ux-welcome-name{margin:2px 0 0;color:var(--es-text);font:700 15px/17px var(--es-head)!important;font-stretch:75%!important;
 text-transform:uppercase!important;letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
${P} .ux-welcome-text{margin-top:2px!important;color:var(--es-soft);font:400 13px/17px var(--es-head);display:-webkit-box;
 -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
${P} .ux-welcome .is-done :is(.ux-welcome-name,.ux-welcome-text){color:var(--es-muted)}
${P} .ux-welcome-acts{flex:none;display:flex;flex-direction:column;gap:4px}
${P} .ux-welcome button{height:28px;min-width:0;padding:0 12px;margin:0;color:var(--es-text);cursor:pointer;
 background:var(--es-raised-2)!important;border:none!important;border-left:3px solid transparent!important;border-radius:0!important;
 box-shadow:none!important;font:700 13px/1 var(--es-head)!important;font-stretch:75%!important;text-transform:uppercase!important;
 letter-spacing:.04em;white-space:nowrap;transition:background-color .15s,border-color .15s}
${P} .ux-welcome button:hover{background:var(--es-line)!important;border-left-color:var(--es-red)!important}
${P} .ux-welcome button:focus-visible{outline:2px solid var(--es-red)!important;outline-offset:2px!important}
${P} .ux-welcome-hide{color:var(--es-muted)!important;height:24px!important;padding:0 10px!important}
${P} .ux-welcome-sr{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);
 white-space:nowrap;border:0}
${P} .ux-welcome.is-compact{align-items:center;gap:8px;margin-top:6px;padding:4px 12px}
${P} .ux-welcome.is-compact .ux-welcome-title{flex:none;color:var(--es-red-2);font:800 11px/1 var(--es-head)!important;
 letter-spacing:.06em;white-space:nowrap}
${P} .ux-welcome.is-compact .ux-welcome-steps{flex:0 1 auto;display:flex;gap:6px}
${P} .ux-welcome.is-compact .ux-welcome-step{display:block;padding:0;background:none;border:0;min-width:0}
${P} .ux-welcome.is-compact .ux-welcome-step button{display:inline-flex;align-items:center;gap:6px;max-width:100%;overflow:hidden}
${P} .ux-welcome.is-compact .is-next button{border-left-color:var(--es-red)!important}
${P} .ux-welcome.is-compact .ux-welcome-num{color:var(--es-muted)}
${P} .ux-welcome.is-compact .ux-welcome-label{overflow:hidden;text-overflow:ellipsis}
${P} .ux-welcome.is-compact .is-done :is(.ux-welcome-label,.ux-welcome-num){color:var(--es-muted)}
${P} .ux-welcome.is-compact .is-next .ux-welcome-next{font-size:11px;letter-spacing:.06em}
${P} .ux-welcome.is-compact .ux-welcome-hide{flex:none;margin-left:auto!important;height:28px!important}
@media (max-width:900px){${P} .ux-welcome{margin-left:20px;margin-right:20px}}
@media (max-height:${COMPACT_MAX_H}px){
 html[data-aim-local].${ON_CLASS}:not(#es) body .al-wk-hero-copy>h1{display:none!important}
 html[data-aim-local].${ON_CLASS}:not(#es) body .al-wk-hero-copy{padding-top:8px!important;padding-bottom:8px!important}
 html[data-aim-local].${ON_CLASS}:not(#es) body .al-wk-hero-copy>.al-wk-feat{margin-top:0!important}
}`;

  function injectStyle(doc) {
    if (doc.getElementById("ux-welcome-style")) return;
    const style = doc.createElement("style");
    style.id = "ux-welcome-style";
    style.textContent = CSS;
    (doc.head || doc.documentElement).append(style);
  }

  function createController(win, doc) {
    let banner = null;
    let lastSig = null;
    let lastLayout = null;
    let frame = 0;
    let warned = false;
    const warn = (msg) => {
      if (warned) return;
      warned = true;
      try { win.console.warn(`[ux-welcome] ${msg}`); } catch { /* ignore */ }
    };
    const storage = () => {
      try { return win.localStorage; } catch { return null; }
    };

    function setOn(on) {
      const cl = doc.documentElement.classList;
      if (cl.contains(ON_CLASS) !== on) cl.toggle(ON_CLASS, on);
    }
    function takeOut() {
      if (banner && banner.isConnected) banner.remove();
      setOn(false);
    }
    function ensureBanner() {
      if (banner) return banner;
      banner = doc.createElement("section");
      banner.className = "ux-welcome";
      banner.setAttribute("role", "region");
      banner.setAttribute("aria-label", "Getting started");
      banner.addEventListener("click", onClick);
      return banner;
    }

    function run() {
      frame = 0;
      if (!doc.querySelector(LOBBY)) return takeOut();
      const d = decide(storage());
      if (!d.show) return takeOut();
      if (!doc.querySelector(HERO) || BLOCKERS.some((s) => doc.querySelector(s))) return takeOut();
      const state = {
        steps: d.steps,
        compact: (win.innerHeight || 0) <= COMPACT_MAX_H,
        importer: !!win.__aimValorantImporter,
      };
      const b = ensureBanner();
      const s = sig(state);
      if (s !== lastSig) {
        lastLayout = paint(b, state, lastLayout);
        lastSig = s;
      }
      if (place(doc, b)) setOn(true);
      else setOn(false);
    }
    // Page watcher callback: accepts any records (also [] from page-watch.js on unlock).
    function sync() {
      if (frame) return;
      frame = win.requestAnimationFrame(run) || 1;
    }

    function markUsed(id) {
      const st = storage();
      if (!st) return;
      const used = readArray(st, STEPS_KEY);
      if (used.includes(id)) return;
      used.push(id);
      try { st.setItem(STEPS_KEY, JSON.stringify(used)); } catch { /* ignore */ }
    }

    function openSens() {
      const tools = win.__aimTools;
      if (tools && typeof tools.openSens === "function") return tools.openSens();
      const input = doc.querySelector(".hall-sens input");
      if (input) input.focus();
      else warn("no sens tools");
    }
    // Lobby Settings page, Crosshair tab. Gives up quietly after 3 s.
    function openCrosshair() {
      const tab = [...doc.querySelectorAll(".hall-root .hall-topnav .hall-tab")]
        .find((el) => /^(settings|设置)$/i.test((el.textContent || "").trim()));
      if (!tab) return warn("no Settings tab");
      markUsed("crosshair");
      tab.click();
      const until = Date.now() + 3000;
      const look = () => {
        const t = doc.querySelector('.hall-root .st-view .st-tabbar [data-tab="crosshair"]');
        if (t) return t.click();
        if (Date.now() > until) return warn("no crosshair tab");
        win.setTimeout(look, 50);
      };
      look();
    }
    // Synchronous on purpose: starting a drill asks for fullscreen, which needs the click.
    function playFeatured() {
      const go = doc.querySelector(".al-wk-hero .al-wk-go");
      if (go) return go.click();
      const card = doc.querySelector(".al-wk-card");
      if (!card) return warn("no drill to play");
      card.scrollIntoView({ block: "nearest" });
      const play = card.querySelector(".al-wk-split-go, .al-wk-play");
      if (play) play.focus();
    }
    function hide() {
      const st = storage();
      try { if (st) st.setItem(KEY, "done"); } catch { /* ignore */ }
      const hadFocus = banner && banner.contains(doc.activeElement);
      takeOut();
      if (hadFocus) {
        const go = doc.querySelector(".al-wk-hero .al-wk-go");
        if (go) go.focus({ preventScroll: true });
      }
    }

    function onClick(e) {
      const btn = e.target && e.target.closest ? e.target.closest("[data-ux-welcome]") : null;
      if (!btn) return;
      const act = btn.getAttribute("data-ux-welcome");
      try {
        if (act === "sens") { markUsed("sens"); openSens(); }
        else if (act === "import") {
          markUsed("sens");
          if (win.__aimValorantImporter && typeof win.__aimValorantImporter.open === "function") win.__aimValorantImporter.open();
        } else if (act === "crosshair") openCrosshair();
        else if (act === "play") playFeatured();
        else if (act === "hide") return hide();
      } catch (err) {
        warn(`${act} failed: ${err && err.message}`);
      }
      sync();
    }

    return { run, sync, get banner() { return banner; } };
  }

  function install(win, doc) {
    if (win.__aimUxWelcome) return;
    injectStyle(doc);
    const ctl = createController(win, doc);
    win.__aimUxWelcome = ctl;
    if (typeof win.__aimWatchPage === "function") win.__aimWatchPage(ctl.sync, { childList: true, subtree: true });
    else new win.MutationObserver(ctl.sync).observe(doc.documentElement, { childList: true, subtree: true });
    win.addEventListener("storage", ctl.sync);
    win.addEventListener("resize", ctl.sync);
    doc.addEventListener("change", ctl.sync, true);
    doc.addEventListener("visibilitychange", ctl.sync);
    ctl.sync();
  }

  return {
    decide, stepsDone, place, sig, render, createController, install,
    KEY, STEPS_KEY, SENS_KEY, CROSSHAIR_KEY, RUN_KEYS, ON_CLASS, HERO, CSS,
  };
});
