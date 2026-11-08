// Round mode HUD: timers, alive counts, spike status, hints, plant / defuse progress, end banner
// with a stats line (also put in ux's result card container), and the spike beeps (WebAudio, synthesised; no sound files). Reads window.__aimRound, which the
// patched play page sets after every sim step of a round run (tools/round_patch.py); does nothing
// in normal drills (window.__aimRoundOn is false).
(() => {
  if (window.__aimRoundHud) return;
  window.__aimRoundHud = true;

  // Colours come from theme-esports.css (main.js loads it on every page but Studio); each var has
  // its value as a fallback in case the theme is missing.
  const css = `
#aim-round-hud { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: var(--es-head, "Bahnschrift", "Segoe UI", sans-serif); color: var(--es-text, #f4f5f7); }
#aim-round-hud[hidden] { display: none; }
.arh-top { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; gap: 0; filter: drop-shadow(0 2px 6px rgba(0,0,0,.55)); }
.arh-team { min-width: 92px; padding: 6px 12px; background: rgba(14,18,24,.82); display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.arh-team.us { border-left: 3px solid var(--es-green, #4ade80); align-items: flex-end; }
.arh-team.them { border-right: 3px solid var(--es-red, #ff4655); align-items: flex-start; }
.arh-team b { font-size: 11px; letter-spacing: .14em; color: var(--es-muted, #9aa1ae); font-weight: 600; }
.arh-pips { display: flex; gap: 4px; }
.arh-pip { width: 10px; height: 14px; border-radius: 0; background: var(--es-red, #ff4655); }
.arh-team.us .arh-pip { background: var(--es-green, #4ade80); }
.arh-pip.dead { background: rgba(255,255,255,.14); }
.arh-clock { min-width: 120px; padding: 4px 16px; background: rgba(8,10,14,.9); text-align: center; display: flex; flex-direction: column; justify-content: center; }
.arh-clock small { font-size: 11px; letter-spacing: .14em; color: var(--es-muted, #9aa1ae); font-weight: 600; }
.arh-clock span { font-size: 30px; line-height: 1.05; font-weight: 700; font-variant-numeric: tabular-nums; }
.arh-clock.spike span { color: var(--es-red, #ff4655); }
.arh-clock.spike.late span { animation: arh-pulse .5s ease-in-out infinite alternate; }
/* #ffd166 = the style guide's "warn" status colour; theme-esports.css has no var for it. */
.arh-clock.barrier span { color: #ffd166; }
@keyframes arh-pulse { from { opacity: 1; } to { opacity: .55; } }
.arh-spike { position: absolute; top: 76px; left: 50%; transform: translateX(-50%); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--es-red-2, #ff6b77); text-shadow: 0 1px 3px #000; white-space: nowrap; }
.arh-hint { position: absolute; left: 50%; top: 62%; transform: translateX(-50%); padding: 7px 16px; background: rgba(10,12,16,.72); border-radius: 0; font-size: 15px; letter-spacing: .04em; white-space: nowrap; }
.arh-hint kbd { display: inline-block; min-width: 20px; margin: 0 3px; padding: 0 5px; border: 1px solid var(--es-line-2, #343b4a); border-bottom-width: 2px; border-radius: 0; background: var(--es-raised, #171b23); font: 700 13px/20px inherit; text-align: center; }
.arh-bar { position: absolute; left: 50%; top: 56%; width: 300px; transform: translateX(-50%); }
.arh-bar small { display: block; margin-bottom: 5px; text-align: center; font-size: 11px; letter-spacing: .14em; font-weight: 700; }
.arh-track { position: relative; height: 8px; background: rgba(255,255,255,.14); border-radius: 0; overflow: hidden; }
.arh-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--es-red, #ff4655); }
.arh-bar.defuse .arh-fill { background: var(--es-green, #4ade80); }
.arh-bar.enemy small { color: var(--es-red-2, #ff6b77); }
.arh-bar.enemy .arh-fill { background: var(--es-red, #ff4655); }
.arh-mark { position: absolute; top: -3px; bottom: -3px; left: 50%; width: 2px; background: var(--es-text, #f4f5f7); opacity: .8; }
/* Spike detonation: a full-screen flash (white core, orange edge; effect colours, no theme var). */
.arh-flash { position: absolute; inset: 0; opacity: 0; background: radial-gradient(circle at 50% 50%, rgba(255,255,255,.95) 0%, rgba(255,220,160,.9) 35%, rgba(255,140,40,.75) 70%, rgba(255,90,30,.6) 100%); }
.arh-banner { position: absolute; left: 0; right: 0; top: 30%; text-align: center; padding: 18px 0 20px; background: linear-gradient(90deg, transparent, rgba(10,12,16,.86) 25%, rgba(10,12,16,.86) 75%, transparent); }
.arh-banner b { display: block; font-size: 54px; line-height: 1; letter-spacing: .14em; font-weight: 800; font-stretch: 75%; }
.arh-banner.win b { color: var(--es-green, #4ade80); }
.arh-banner.loss b { color: var(--es-red, #ff4655); }
.arh-banner span { display: block; margin-top: 8px; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; color: var(--es-soft, #d6d9df); }
.arh-banner .arh-stats { margin-top: 8px; font-size: 13px; letter-spacing: .04em; color: var(--es-muted, #9aa1ae); font-variant-numeric: tabular-nums; }
.arh-banner .arh-stats[hidden] { display: none; }
/* The same stats line in ux's result card container (ux-result.js, div.ux-result-extra). */
.ux-result-extra .arh-result-stats { font-size: 13px; letter-spacing: .04em; color: var(--es-soft, #d6d9df); font-variant-numeric: tabular-nums; }
.arh-dead { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); font-size: 18px; letter-spacing: .12em; text-transform: uppercase; color: var(--es-red-2, #ff6b77); text-shadow: 0 1px 4px #000; white-space: nowrap; }
/* While a round scene is loaded (html.aim-round-on, set below from window.__aimRoundOn): */
/* the game's own score / hit-rate chips sit under the round HUD's top bar, so hide them; */
html.aim-round-on .al-hud-top { display: none !important; }
/* the game's scene brief card keeps its title, description and Start / Back buttons but drops the
   parts made for player-made scenes (kicker, author, play count, specs, rules, seed). */
html.aim-round-on .al-scene-brief-head,
html.aim-round-on .al-scene-brief-author,
html.aim-round-on .al-scene-brief hr,
html.aim-round-on .al-scene-brief-specs,
html.aim-round-on .al-scene-brief-note,
html.aim-round-on .al-scene-brief-says > .al-start-kicker,
html.aim-round-on .al-scene-brief-foot { display: none !important; }
/* The game clamps the description to 3 lines (-webkit-line-clamp); the round text needs all of it. */
html.aim-round-on .al-scene-brief-says p { white-space: pre-line; display: block; -webkit-line-clamp: unset; overflow: visible; }
`;
  const root = document.createElement("div");
  root.id = "aim-round-hud";
  root.hidden = true;
  root.innerHTML = `<div class="arh-top"><div class="arh-team us"><b>YOU</b><div class="arh-pips" data-us></div></div><div class="arh-clock"><small></small><span></span></div><div class="arh-team them"><b>ENEMY</b><div class="arh-pips" data-them></div></div></div>
<div class="arh-spike"></div><div class="arh-bar" hidden><small></small><div class="arh-track"><div class="arh-fill"></div><div class="arh-mark" hidden></div></div></div>
<div class="arh-hint" hidden></div><div class="arh-dead" hidden>You died. Spike planted.</div><div class="arh-flash" hidden></div><div class="arh-banner" hidden><b></b><span></span><div class="arh-stats" hidden></div></div>`;
  const $ = (s) => root.querySelector(s);
  const el = {
    us: $("[data-us]"), them: $("[data-them]"), clock: $(".arh-clock"), clockLabel: $(".arh-clock small"), clockText: $(".arh-clock span"),
    spike: $(".arh-spike"), bar: $(".arh-bar"), barLabel: $(".arh-bar small"), fill: $(".arh-fill"), mark: $(".arh-mark"),
    hint: $(".arh-hint"), dead: $(".arh-dead"), flash: $(".arh-flash"), banner: $(".arh-banner"), bannerTitle: $(".arh-banner b"), bannerText: $(".arh-banner span"), stats: $(".arh-stats"),
  };
  // The stylesheet goes in right away (not only when a round runs): its html.aim-round-on rules
  // restyle the game's brief card before the round starts.
  function addCss() {
    if (document.getElementById("aim-round-hud-css") || !document.head) return;
    const s = document.createElement("style");
    s.id = "aim-round-hud-css";
    s.textContent = css;
    document.head.appendChild(s);
  }
  function mount() {
    addCss();
    if (!root.isConnected) document.body.appendChild(root);
  }
  addCss();

  // ---------- round scene loaded: html.aim-round-on ----------
  // The play page sets window.__aimRoundOn when a run starts (true for round scenes, false for
  // every other drill) and clears it when the run is disposed (tools/round_patch.py). That happens
  // before the brief card shows, while window.__aimRound is still null, so the property is wrapped
  // here to switch the class at the same moment. The poll below is a backup.
  const setOnClass = (on) => { try { document.documentElement.classList.toggle("aim-round-on", !!on); } catch {} };
  // A round starting (off -> on) also resets the round stats below.
  let roundStart = () => {};
  try {
    const d = Object.getOwnPropertyDescriptor(window, "__aimRoundOn");
    if (!d || d.configurable) {
      let value = d ? (d.get ? d.get.call(window) : d.value) : undefined;
      Object.defineProperty(window, "__aimRoundOn", {
        configurable: true, enumerable: true,
        get() { return d?.get ? d.get.call(window) : value; },
        set(v) {
          const was = !!(d?.get ? d.get.call(window) : value);
          if (d?.set) d.set.call(window, v); else value = v;
          setOnClass(v);
          if (v && !was) roundStart();
        },
      });
    }
  } catch {}
  setOnClass(window.__aimRoundOn);

  // ---------- sound ----------
  // Through the app's UI audio bus when there is one (window.__aimAudio.bus.ui: master volume and
  // its mixer slider apply), else an own AudioContext.
  let ac = null;
  function out() {
    const bus = window.__aimAudio?.bus?.ui;
    if (bus && bus.context && typeof bus.connect === "function") return { ctx: bus.context, dest: bus };
    ac ??= new (window.AudioContext || window.webkitAudioContext)();
    return { ctx: ac, dest: ac.destination };
  }
  function beep(freq, dur = 0.08, vol = 0.18, type = "square") {
    try {
      const { ctx, dest } = out();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(dest);
      o.start(t); o.stop(t + dur + 0.02);
    } catch {}
  }
  // Beep spacing while planted: 1 s at the start, faster towards the end (VALORANT-like).
  const beepGap = (left) => (left > 20 ? 1 : left > 10 ? 0.5 : left > 5 ? 0.25 : 0.12);

  // Enemy planting (defense side): a soft tone pulsing 5 times a second, panned left / right and as
  // loud as round-core's plantCue says ({pan -1..1, gain 0.1..1}, quantised, null when nobody
  // plants within 30 m). Silent while paused or when the round isn't live. One looping voice:
  // triangle 540 Hz -> pulse gain (a 5 Hz square LFO) -> level -> StereoPanner (if any) -> out().
  let cue = null, renderedAt = 0; // renderedAt: last render (s), for the stall check in the poll below
  function cueSet(c) {
    try {
      if (!cue) {
        const { ctx, dest } = out();
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const osc = ctx.createOscillator(), pulse = ctx.createGain(), lvl = ctx.createGain(), lfo = ctx.createOscillator(), depth = ctx.createGain();
        const pan = typeof ctx.createStereoPanner === "function" ? ctx.createStereoPanner() : null;
        osc.type = "triangle"; osc.frequency.value = 540;
        lfo.type = "square"; lfo.frequency.value = 5;
        pulse.gain.value = 0.5; depth.gain.value = 0.5; // pulse gain swings 0..1
        lvl.gain.value = 0;
        lfo.connect(depth); depth.connect(pulse.gain);
        osc.connect(pulse); pulse.connect(lvl);
        if (pan) { lvl.connect(pan); pan.connect(dest); } else lvl.connect(dest);
        const t = ctx.currentTime;
        osc.start(t); lfo.start(t);
        cue = { ctx, osc, lfo, lvl, pan };
      }
      const t = cue.ctx.currentTime;
      cue.lvl.gain.setTargetAtTime(0.03 + 0.09 * c.gain, t, 0.05);
      if (cue.pan) cue.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, c.pan)), t, 0.05);
    } catch {}
  }
  function cueStop() {
    if (!cue) return;
    const c = cue;
    cue = null;
    try {
      const t = c.ctx.currentTime;
      c.lvl.gain.setTargetAtTime(0, t, 0.015);
      c.osc.onended = () => { try { c.lvl.disconnect(); c.pan?.disconnect(); } catch {} };
      c.osc.stop(t + 0.08); c.lfo.stop(t + 0.08);
    } catch {}
  }

  // ---------- round stats (end banner and result card) ----------
  // Headshot % = head hits / hits on enemies, from the game's shot events: main.js makes the play
  // page call window.__aimShot(event) for every player shot. feel's shooting-error.js owns that
  // hook, so this chains onto it (the previous hook runs first, always) at round start and on each
  // frame if someone replaced it. A shotgun shot counts each pellet, a wallbang each enemy hit. The player can only fire while
  // live / planted and on the tick that ends the round (round-core roundNoFire), and the page hands
  // over a step's shots after window.__aimRound already shows that step, so "ended" counts too: it is
  // the shot that won the round. The counts reset when a round starts and during the barrier phase.
  let hits = 0, heads = 0, statsLine = "";
  const counted = new WeakSet(); // an event that reaches us twice (chained twice) counts once
  function countShot(e) {
    if (!e || typeof e !== "object" || counted.has(e) || !window.__aimRoundOn) return;
    counted.add(e);
    const ph = window.__aimRound?.phase;
    if (ph !== "live" && ph !== "planted" && ph !== "ended") return;
    const list = Array.isArray(e.pellets) && e.pellets.length ? e.pellets : [e];
    for (const p of list) {
      if (!p) continue;
      if (p.hitActorId !== null && p.hitActorId !== undefined) { hits++; if (p.hitPart === "head") heads++; }
      // A bullet that goes through one enemy into another lists the next ones in also: [{actorId, part}].
      if (Array.isArray(p.also)) for (const a of p.also) if (a && a.actorId !== null && a.actorId !== undefined) { hits++; if (a.part === "head") heads++; }
    }
  }
  function hookShots() {
    const prev = window.__aimShot;
    if (typeof prev === "function" && prev.__aimRoundStats) return;
    const hook = function (e) {
      try { if (typeof prev === "function") return prev.apply(this, arguments); }
      finally { try { countShot(e); } catch {} }
    };
    hook.__aimRoundStats = true;
    window.__aimShot = hook;
  }
  roundStart = () => { hits = 0; heads = 0; statsLine = ""; try { hookShots(); } catch {} };
  // "Kills 3 · HS 33% · Planted at 0:58". Attack: "Planted at <round clock>", "No plant" (time ran
  // out), "Enemy defused" (a bot defused it). Defense: "Enemy planted at <round clock>", "Defused
  // with 0:12 left" (spike time left). A part whose number is missing is left out (no hits: no HS).
  function buildStats(r) {
    const parts = [];
    if (Number.isFinite(r.kills)) parts.push(`Kills ${r.kills}`);
    if (hits > 0) parts.push(`HS ${Math.round((heads / hits) * 100)}%`);
    const at = Number.isFinite(r.plantClock) ? fmt(r.plantClock) : "";
    if (r.side === "defense") {
      if (r.reason === "defused" && Number.isFinite(r.defuseLeft)) parts.push(`Defused with ${fmt(r.defuseLeft)} left`);
      else if (at) parts.push(`Enemy planted at ${at}`);
    } else if (r.reason === "defused") parts.push("Enemy defused");
    else if (at) parts.push(`Planted at ${at}`);
    else if (r.reason === "timeout") parts.push("No plant");
    return parts.join(" · ");
  }
  // ux's result card container (ux-result.js: window "ux-result-extra" with detail.el, or
  // window.__aimUxResult.extra()). Filled only on a round's result card (its text says "Round won" /
  // "Round lost") with the line saved at the round end; one row, text only, nothing focusable.
  function fillResult(box) {
    if (!statsLine) return false;
    box = box || window.__aimUxResult?.extra?.();
    const card = document.querySelector?.(".al-result-overlay");
    if (!box || !card || !/\bRound (won|lost)\b/i.test(card.textContent || "")) return false;
    let row = null;
    for (const c of box.children || []) if (c.classList?.contains("arh-result-stats")) row = c;
    if (!row) { row = document.createElement("div"); row.classList.add("arh-result-stats"); box.appendChild(row); }
    row.textContent = statsLine;
    return true;
  }
  window.addEventListener?.("ux-result-extra", (e) => { try { fillResult(e?.detail?.el); } catch {} });
  // For the in-app check (shots/round/r5-check.mjs): the counts and the saved line.
  window.__aimRoundStats = { get hits() { return hits; }, get heads() { return heads; }, get line() { return statsLine; } };

  // ---------- state ----------
  let last = null, nextBeep = 0, nextDefuseBeep = 0, endShownFor = null, seenTick = -1, seenAt = 0;
  // Detonation: the screen flash starts at flashAt and fades over FLASH_SEC; the end banner waits
  // until bannerAt so it doesn't cover the flash. Other round ends show the banner at once.
  const FLASH_SEC = 0.6, BANNER_DELAY = 0.6;
  let flashAt = null, bannerAt = 0;
  const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function pips(box, total, alive) {
    if (box.childElementCount !== total) { box.textContent = ""; for (let i = 0; i < total; i++) { const p = document.createElement("i"); p.className = "arh-pip"; box.appendChild(p); } }
    [...box.children].forEach((p, i) => p.classList.toggle("dead", i >= alive));
  }
  const text = (r) => (typeof window.__aimRoundText === "function" ? window.__aimRoundText(r) : r.reason || "");
  // "Take the spike to A or B site" from the round's site ids (r.sites, round-core roundView):
  // "A site", "A or B site", "A, B or C site"; no usable ids -> "a site". Ids are 1-2 letters or
  // digits (anything else is dropped, so nothing odd reaches innerHTML). Cached per array.
  let sitesRef = null, sitesHint = "";
  function siteHint(sites) {
    if (sites === sitesRef && sitesHint) return sitesHint;
    const ids = (Array.isArray(sites) ? sites : []).map(String).filter((s) => /^[A-Za-z0-9]{1,2}$/.test(s));
    const list = ids.length > 1 ? `${ids.slice(0, -1).join(", ")} or ${ids[ids.length - 1]}` : ids[0];
    sitesRef = sites;
    sitesHint = list ? `Take the spike to ${list} site` : "Take the spike to a site";
    return sitesHint;
  }
  // Defense objective, same ids: "Defend A", "Defend A and B", "Defend A, B and C"; none -> "Defend
  // the sites". Cached per array.
  let defRef = null, defText = "";
  function defendHint(sites) {
    if (sites === defRef && defText) return defText;
    const ids = (Array.isArray(sites) ? sites : []).map(String).filter((s) => /^[A-Za-z0-9]{1,2}$/.test(s));
    const list = ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}` : ids[0];
    defRef = sites;
    defText = list ? `Defend ${list}` : "Defend the sites";
    return defText;
  }
  const siteId = (id) => (typeof id === "string" && /^[A-Za-z0-9]{1,2}$/.test(id) ? id : "");

  function render(r, now) {
    pips(el.us, 1, r.playerAlive ? 1 : 0);
    pips(el.them, r.enemyCount, r.enemiesAlive);
    const spike = r.phase === "planted";
    el.clock.classList.toggle("spike", spike);
    el.clock.classList.toggle("late", spike && r.timeLeft <= 10);
    el.clock.classList.toggle("barrier", r.phase === "barrier");
    el.clockLabel.textContent = r.phase === "barrier" ? "BARRIER" : spike ? "SPIKE" : r.phase === "ended" ? "ROUND OVER" : "ROUND";
    el.clockText.textContent = r.phase === "ended" ? "0:00" : fmt(r.timeLeft);
    const s = r.spike || {};
    const botDefusing = r.phase === "planted" && !!r.botDefusing;
    // Defense: the objective until the plant; never where the attackers' spike lies (dropped).
    const defense = r.side === "defense";
    el.spike.textContent = r.phase === "ended" ? "" : botDefusing ? "Spike being defused" : s.planted ? `Spike planted${s.planted.site ? " · " + s.planted.site : ""}` : r.carrying ? "You carry the spike" : defense ? defendHint(r.sites) : s.dropped ? "Spike dropped" : "";

    // Progress bar (your plant / defuse, or an enemy defusing your spike).
    const holding = r.holding;
    el.bar.hidden = !holding && !botDefusing;
    el.bar.classList.toggle("enemy", !holding && botDefusing);
    if (holding) {
      el.bar.classList.toggle("defuse", holding === "defuse");
      el.barLabel.textContent = holding === "plant" ? "PLANTING" : "DEFUSING";
      el.fill.style.width = `${Math.min(100, Math.round((holding === "plant" ? r.plant : r.defuse) * 100))}%`;
      el.mark.hidden = holding !== "defuse";
    } else if (botDefusing) {
      el.bar.classList.remove("defuse");
      el.barLabel.textContent = "SPIKE BEING DEFUSED";
      el.fill.style.width = `${Math.min(100, Math.round(r.defuse * 100))}%`;
      el.mark.hidden = false;
    }

    // Hint.
    let hint = "";
    if (r.phase === "barrier") hint = `Barriers drop in ${Math.ceil(r.timeLeft)} s`;
    else if (r.phase === "live" && r.carrying && r.playerAlive) hint = r.zone ? (holding ? "" : `Hold <kbd>4</kbd> to plant`) : siteHint(r.sites);
    else if (r.phase === "planted" && defense && r.playerAlive && !holding) {
      const site = siteId(s.planted?.site);
      hint = r.near ? `Hold <kbd>F</kbd> to defuse` : site ? `Defuse the spike at ${site}` : "Defuse the spike";
    }
    el.hint.hidden = !hint;
    if (hint && el.hint.innerHTML !== hint) el.hint.innerHTML = hint;
    el.dead.hidden = !(r.phase === "planted" && !r.playerAlive);

    // End banner (shown below, after the end-of-round check sets bannerAt).
    const ended = r.phase === "ended";
    if (ended) {
      el.banner.classList.toggle("win", !!r.win);
      el.banner.classList.toggle("loss", !r.win);
      el.bannerTitle.textContent = r.win ? "ROUND WON" : "ROUND LOST";
      el.bannerText.textContent = text(r);
      statsLine = buildStats(r);
      el.stats.textContent = statsLine;
      el.stats.hidden = !statsLine;
    } else {
      statsLine = ""; // a new round is on: the old line is gone
      if (r.phase === "barrier") { hits = 0; heads = 0; }
    }

    // Sounds on changes.
    if (last) {
      if (last.phase === "barrier" && r.phase === "live") { beep(330, 0.25, 0.14, "sawtooth"); }
      if (last.phase !== "planted" && r.phase === "planted") { beep(880, 0.09); setTimeout(() => beep(1320, 0.12), 110); nextBeep = now + 1; }
      if (ended && endShownFor !== r.tick && last.phase !== "ended") {
        endShownFor = r.tick;
        if (r.reason === "detonated") { beep(70, 0.9, 0.3, "sawtooth"); flashAt = now; bannerAt = now + BANNER_DELAY; }
        else if (r.reason === "defused" && r.win) { beep(660, 0.1); setTimeout(() => beep(990, 0.18), 120); }
        else beep(r.win ? 784 : 220, 0.3, 0.16, "triangle");
      }
    }
    el.banner.hidden = !ended || now < bannerAt;
    const fk = flashAt === null ? 1 : (now - flashAt) / FLASH_SEC;
    el.flash.hidden = !ended || fk >= 1;
    if (!el.flash.hidden) el.flash.style.opacity = (0.85 * (1 - fk) * (1 - fk)).toFixed(3);
    // No beeps while the game is paused (the sim tick stops moving).
    if (r.tick !== seenTick) { seenTick = r.tick; seenAt = now; }
    const paused = now - seenAt > 0.25;
    if (paused) nextBeep = Math.max(nextBeep, now + 0.1);
    if (spike && !paused && now >= nextBeep) { beep(r.timeLeft <= 10 ? 1400 : 1150, 0.06, 0.12); nextBeep = now + beepGap(r.timeLeft); }
    // An enemy is defusing your spike: two short low beeps every 0.5 s.
    if (!botDefusing || paused) nextDefuseBeep = Math.max(nextDefuseBeep, now);
    else if (now >= nextDefuseBeep) { beep(260, 0.05, 0.16, "square"); setTimeout(() => beep(260, 0.05, 0.16, "square"), 90); nextDefuseBeep = now + 0.5; }
    // An enemy is planting nearby (defense side): the panned pulsing tone.
    const pc = defense && r.phase === "live" && !paused && r.plantCue && Number.isFinite(r.plantCue.pan) && Number.isFinite(r.plantCue.gain) ? r.plantCue : null;
    if (pc) cueSet(pc); else cueStop();
    renderedAt = now;
    last = { phase: r.phase };
  }

  let raf = 0;
  function frame() {
    raf = 0;
    const r = window.__aimRound;
    if (!window.__aimRoundOn || !r || r.done) {
      // The run is over (done): its result card may already be up.
      if (r?.done && last) { try { fillResult(); } catch {} }
      root.hidden = true; last = null; flashAt = null; bannerAt = 0; cueStop(); return;
    }
    try { hookShots(); } catch {}
    mount();
    root.hidden = false;
    // Paused (pointer unlocked): the sim stops, so the view stops changing; keep showing it.
    render(r, performance.now() / 1000);
    raf = requestAnimationFrame(frame);
  }
  // Cheap check for a round starting; the frame loop only runs during a round.
  setInterval(() => {
    setOnClass(window.__aimRoundOn);
    // No frame for a while (frame loop stopped, e.g. a hidden window): don't leave the tone looping.
    if (cue && performance.now() / 1000 - renderedAt > 0.5) cueStop();
    if (!raf && window.__aimRoundOn && window.__aimRound && !window.__aimRound.done) raf = requestAnimationFrame(frame);
  }, 250);
})();
