// Round mode HUD: timers, alive counts, spike status, hints, plant / defuse progress, end banner
// and the spike beeps (WebAudio, synthesised; no sound files). Reads window.__aimRound, which the
// patched play page sets after every sim step of a round run (tools/round_patch.py); does nothing
// in normal drills (window.__aimRoundOn is false).
(() => {
  if (window.__aimRoundHud) return;
  window.__aimRoundHud = true;

  const css = `
#aim-round-hud { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: "DIN Next", "Bahnschrift", "Segoe UI", system-ui, sans-serif; color: #eef1f5; }
#aim-round-hud[hidden] { display: none; }
.arh-top { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; gap: 0; filter: drop-shadow(0 2px 6px rgba(0,0,0,.55)); }
.arh-team { min-width: 92px; padding: 6px 12px; background: rgba(14,18,24,.82); display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.arh-team.us { border-left: 3px solid #20e0b4; align-items: flex-end; }
.arh-team.them { border-right: 3px solid #ff4655; align-items: flex-start; }
.arh-team b { font-size: 10px; letter-spacing: .18em; color: #9aa3b2; font-weight: 600; }
.arh-pips { display: flex; gap: 4px; }
.arh-pip { width: 10px; height: 14px; border-radius: 2px; background: #ff4655; }
.arh-team.us .arh-pip { background: #20e0b4; }
.arh-pip.dead { background: rgba(255,255,255,.14); }
.arh-clock { min-width: 120px; padding: 4px 16px; background: rgba(8,10,14,.9); text-align: center; display: flex; flex-direction: column; justify-content: center; }
.arh-clock small { font-size: 10px; letter-spacing: .2em; color: #9aa3b2; font-weight: 600; }
.arh-clock span { font-size: 30px; line-height: 1.05; font-weight: 700; font-variant-numeric: tabular-nums; }
.arh-clock.spike span { color: #ff4655; }
.arh-clock.spike.late span { animation: arh-pulse .5s ease-in-out infinite alternate; }
.arh-clock.barrier span { color: #ffd166; }
@keyframes arh-pulse { from { opacity: 1; } to { opacity: .55; } }
.arh-spike { position: absolute; top: 76px; left: 50%; transform: translateX(-50%); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #ffb4ba; text-shadow: 0 1px 3px #000; }
.arh-hint { position: absolute; left: 50%; top: 62%; transform: translateX(-50%); padding: 7px 16px; background: rgba(10,12,16,.72); border-radius: 3px; font-size: 15px; letter-spacing: .04em; white-space: nowrap; }
.arh-hint kbd { display: inline-block; min-width: 20px; margin: 0 3px; padding: 0 5px; border: 1px solid #5a6272; border-bottom-width: 2px; border-radius: 3px; background: #1a1e26; font: 700 13px/20px inherit; text-align: center; }
.arh-bar { position: absolute; left: 50%; top: 56%; width: 300px; transform: translateX(-50%); }
.arh-bar small { display: block; margin-bottom: 5px; text-align: center; font-size: 11px; letter-spacing: .2em; font-weight: 700; }
.arh-track { position: relative; height: 8px; background: rgba(255,255,255,.14); border-radius: 4px; overflow: hidden; }
.arh-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: #ff4655; }
.arh-bar.defuse .arh-fill { background: #20e0b4; }
.arh-bar.enemy small { color: #ffb4ba; }
.arh-bar.enemy .arh-fill { background: #ff4655; }
.arh-mark { position: absolute; top: -3px; bottom: -3px; left: 50%; width: 2px; background: #fff; opacity: .8; }
.arh-banner { position: absolute; left: 0; right: 0; top: 30%; text-align: center; padding: 18px 0 20px; background: linear-gradient(90deg, transparent, rgba(10,12,16,.86) 25%, rgba(10,12,16,.86) 75%, transparent); }
.arh-banner b { display: block; font-size: 54px; line-height: 1; letter-spacing: .14em; font-weight: 800; }
.arh-banner.win b { color: #20e0b4; }
.arh-banner.loss b { color: #ff4655; }
.arh-banner span { display: block; margin-top: 8px; font-size: 16px; letter-spacing: .16em; text-transform: uppercase; color: #c9cfd9; }
.arh-dead { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); font-size: 18px; letter-spacing: .12em; text-transform: uppercase; color: #ffb4ba; text-shadow: 0 1px 4px #000; }
`;
  const root = document.createElement("div");
  root.id = "aim-round-hud";
  root.hidden = true;
  root.innerHTML = `<div class="arh-top"><div class="arh-team us"><b>YOU</b><div class="arh-pips" data-us></div></div><div class="arh-clock"><small></small><span></span></div><div class="arh-team them"><b>ENEMY</b><div class="arh-pips" data-them></div></div></div>
<div class="arh-spike"></div><div class="arh-bar" hidden><small></small><div class="arh-track"><div class="arh-fill"></div><div class="arh-mark" hidden></div></div></div>
<div class="arh-hint" hidden></div><div class="arh-dead" hidden>You died — spike planted</div><div class="arh-banner" hidden><b></b><span></span></div>`;
  const $ = (s) => root.querySelector(s);
  const el = {
    us: $("[data-us]"), them: $("[data-them]"), clock: $(".arh-clock"), clockLabel: $(".arh-clock small"), clockText: $(".arh-clock span"),
    spike: $(".arh-spike"), bar: $(".arh-bar"), barLabel: $(".arh-bar small"), fill: $(".arh-fill"), mark: $(".arh-mark"),
    hint: $(".arh-hint"), dead: $(".arh-dead"), banner: $(".arh-banner"), bannerTitle: $(".arh-banner b"), bannerText: $(".arh-banner span"),
  };
  function mount() {
    if (!document.getElementById("aim-round-hud-css")) {
      const s = document.createElement("style");
      s.id = "aim-round-hud-css";
      s.textContent = css;
      document.head.appendChild(s);
    }
    if (!root.isConnected) document.body.appendChild(root);
  }

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

  // ---------- state ----------
  let last = null, nextBeep = 0, nextDefuseBeep = 0, endShownFor = null, seenTick = -1, seenAt = 0;
  const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function pips(box, total, alive) {
    if (box.childElementCount !== total) { box.textContent = ""; for (let i = 0; i < total; i++) { const p = document.createElement("i"); p.className = "arh-pip"; box.appendChild(p); } }
    [...box.children].forEach((p, i) => p.classList.toggle("dead", i >= alive));
  }
  const text = (r) => (typeof window.__aimRoundText === "function" ? window.__aimRoundText(r) : r.reason || "");

  function render(r, now) {
    pips(el.us, 1, r.playerAlive ? 1 : 0);
    pips(el.them, r.enemyCount, r.enemiesAlive);
    const spike = r.phase === "planted";
    el.clock.classList.toggle("spike", spike);
    el.clock.classList.toggle("late", spike && r.timeLeft <= 10);
    el.clock.classList.toggle("barrier", r.phase === "barrier");
    el.clockLabel.textContent = r.phase === "barrier" ? "BARRIER" : spike ? "SPIKE" : r.phase === "ended" ? "ROUND OVER" : "ROUND";
    el.clockText.textContent = r.phase === "ended" ? "—" : fmt(r.timeLeft);
    const s = r.spike || {};
    const botDefusing = r.phase === "planted" && !!r.botDefusing;
    el.spike.textContent = r.phase === "ended" ? "" : botDefusing ? "Spike being defused" : s.planted ? `Spike planted${s.planted.site ? " · " + s.planted.site : ""}` : r.carrying ? "You carry the spike" : s.dropped ? "Spike dropped" : "";

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
    else if (r.phase === "live" && r.carrying && r.playerAlive) hint = r.zone ? (holding ? "" : `Hold <kbd>4</kbd> to plant`) : "Take the spike to A or B site";
    else if (r.phase === "planted" && r.side === "defense" && r.near && !holding) hint = `Hold <kbd>F</kbd> to defuse`;
    el.hint.hidden = !hint;
    if (hint && el.hint.innerHTML !== hint) el.hint.innerHTML = hint;
    el.dead.hidden = !(r.phase === "planted" && !r.playerAlive);

    // End banner.
    const ended = r.phase === "ended";
    el.banner.hidden = !ended;
    if (ended) {
      el.banner.classList.toggle("win", !!r.win);
      el.banner.classList.toggle("loss", !r.win);
      el.bannerTitle.textContent = r.win ? "ROUND WON" : "ROUND LOST";
      el.bannerText.textContent = text(r);
    }

    // Sounds on changes.
    if (last) {
      if (last.phase === "barrier" && r.phase === "live") { beep(330, 0.25, 0.14, "sawtooth"); }
      if (last.phase !== "planted" && r.phase === "planted") { beep(880, 0.09); setTimeout(() => beep(1320, 0.12), 110); nextBeep = now + 1; }
      if (ended && endShownFor !== r.tick && last.phase !== "ended") {
        endShownFor = r.tick;
        if (r.reason === "detonated") beep(70, 0.9, 0.3, "sawtooth");
        else if (r.reason === "defused" && r.win) { beep(660, 0.1); setTimeout(() => beep(990, 0.18), 120); }
        else beep(r.win ? 784 : 220, 0.3, 0.16, "triangle");
      }
    }
    // No beeps while the game is paused (the sim tick stops moving).
    if (r.tick !== seenTick) { seenTick = r.tick; seenAt = now; }
    const paused = now - seenAt > 0.25;
    if (paused) nextBeep = Math.max(nextBeep, now + 0.1);
    if (spike && !paused && now >= nextBeep) { beep(r.timeLeft <= 10 ? 1400 : 1150, 0.06, 0.12); nextBeep = now + beepGap(r.timeLeft); }
    // An enemy is defusing your spike: two short low beeps every 0.5 s.
    if (!botDefusing || paused) nextDefuseBeep = Math.max(nextDefuseBeep, now);
    else if (now >= nextDefuseBeep) { beep(260, 0.05, 0.16, "square"); setTimeout(() => beep(260, 0.05, 0.16, "square"), 90); nextDefuseBeep = now + 0.5; }
    last = { phase: r.phase };
  }

  let raf = 0;
  function frame() {
    raf = 0;
    const r = window.__aimRound;
    if (!window.__aimRoundOn || !r || r.done) { root.hidden = true; last = null; return; }
    mount();
    root.hidden = false;
    // Paused (pointer unlocked): the sim stops, so the view stops changing; keep showing it.
    render(r, performance.now() / 1000);
    raf = requestAnimationFrame(frame);
  }
  // Cheap check for a round starting; the frame loop only runs during a round.
  setInterval(() => { if (!raf && window.__aimRoundOn && window.__aimRound && !window.__aimRound.done) raf = requestAnimationFrame(frame); }, 250);
})();
