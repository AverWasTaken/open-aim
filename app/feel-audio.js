// Sound mix, 3D enemy sound, enemy footsteps, headshot and kill sounds.
// The game script (tools/feel_audio_patch.py) makes the sound buses and calls window.__aimAudioMix;
// this file sets the bus volumes, places enemy sounds in 3D, plays bot footsteps and the new cues.
// Without the patched game script nothing here runs except the settings block.
(() => {
  const core = (() => {
    const KEY = 'al-audio-mix-v1';
    const LEVELS = ['weapon', 'enemy', 'steps', 'hits', 'ui'];
    const TOGGLES = ['headshot', 'killConfirm', 'spatial', 'botSteps'];
    const DEFAULTS = Object.freeze({ v: 1, weapon: 1, enemy: 1, steps: 1, hits: 1, ui: 1, headshot: true, killConfirm: true, spatial: true, botSteps: true });

    function sanitize(value) {
      const out = { ...DEFAULTS };
      if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
      for (const k of LEVELS) if (typeof value[k] === 'number' && Number.isFinite(value[k])) out[k] = Math.min(1, Math.max(0, value[k]));
      for (const k of TOGGLES) if (typeof value[k] === 'boolean') out[k] = value[k];
      return out;
    }
    function loadMix(raw) {
      if (raw == null) return { ...DEFAULTS };
      try { return sanitize(JSON.parse(raw)); } catch { return { ...DEFAULTS }; }
    }

    // Player footstep rules (OkAdunfX t1/Jp, Vandal speeds): steps build up while moving at
    // 60% of run speed or more and play every 0.29 s once speed is at least halfway from walk
    // to run. Walking is silent.
    const RUN = 5.4, WALK = RUN * 0.55, ACC_START = 0.6 * RUN, STEP_MIN = WALK + 0.5 * (RUN - WALK);
    const PLAY_TIME = 0.29, MIN_DT = 0.03, TELEPORT = 10, NEAR = 10, FAR = 40;
    // LAND_OFFSET: only `jump`-behaviour landings play. That arc lives in actor.offset.y and peaks
    // at the jump height (0.8 m in every shipped drill). Stairs, ledge drops and path/nav/replay
    // bots that go airborne move position.y instead, so they are silent (possible follow-up).
    // The player's 1.05 m rule is a fall distance and would silence every bot jump, so bots
    // keep 0.3 m.
    const CAP = 4, CAP_WINDOW = 0.1, LAND_OFFSET = 0.3, STALE = 5;
    const falloff = (d) => (d <= NEAR ? 1 : d >= FAR ? 0 : (FAR - d) / (FAR - NEAR));
    const byDist = (a, b) => a.dist - b.dist;

    // Pure footstep scheduler. update() returns how many events are in .events (nearest first,
    // at most CAP started per CAP_WINDOW seconds of game time).
    function createStepScheduler() {
      const bots = new Map(), pool = [], events = [], starts = [];
      let lastT = -Infinity, lastSweep = -Infinity;
      function event(n) { let e = pool[n]; if (!e) e = pool[n] = { id: 0, kind: 'step', dist: 0, gain: 0, x: 0, y: 0, z: 0 }; return e; }
      function update(actors, lx, ly, lz, t, dots) {
        let found = 0;
        if (!(t >= lastT)) { bots.clear(); starts.length = 0; lastSweep = -Infinity; }
        lastT = t;
        if (actors) for (const a of actors) {
          if (!a || !a.position) continue;
          if (!a.alive) { bots.delete(a.id); continue; }
          if (dots && dots.has(a.templateId)) continue;
          const off = a.offset, px = a.position.x + (off ? off.x : 0), py = a.position.y + (off ? off.y : 0), pz = a.position.z + (off ? off.z : 0);
          const jump = off ? off.y : 0;
          let s = bots.get(a.id);
          if (!s) { bots.set(a.id, { ax: px, az: pz, at: t, acc: 0, air: false, peak: 0, seen: t }); continue; }
          s.seen = t;
          const dt = t - s.at;
          if (!(dt >= MIN_DT)) continue;
          const speed = Math.hypot(px - s.ax, pz - s.az) / dt;
          s.ax = px; s.az = pz; s.at = t;
          if (speed > TELEPORT) { s.acc = 0; s.air = false; s.peak = 0; continue; }
          let kind = null;
          if (jump > 0.05) { s.air = true; if (jump > s.peak) s.peak = jump; }
          else if (s.air) { s.air = false; if (s.peak >= LAND_OFFSET) kind = 'land'; s.peak = 0; }
          if (!s.air) {
            if (speed >= ACC_START) s.acc += dt;
            else s.acc = Math.max(0, s.acc - (speed < 0.5 * WALK ? 1 : 2) * dt);
            if (s.acc >= PLAY_TIME) { s.acc -= PLAY_TIME; if (kind === null && speed >= STEP_MIN) kind = 'step'; }
          }
          if (kind === null) continue;
          const dist = Math.hypot(px - lx, py - ly, pz - lz), gain = falloff(dist);
          if (gain <= 0) continue;
          const e = event(found++);
          e.id = a.id; e.kind = kind; e.dist = dist; e.gain = gain; e.x = px; e.y = py; e.z = pz;
        }
        if (t - lastSweep >= 1) { lastSweep = t; for (const [id, s] of bots) if (s.seen < t - STALE) bots.delete(id); }
        let recent = 0;
        for (let i = 0; i < starts.length; i++) if (starts[i] > t - CAP_WINDOW) recent++;
        const allowed = Math.max(0, CAP - recent);
        events.length = found;
        for (let i = 0; i < found; i++) events[i] = pool[i];
        if (found > 1) events.sort(byDist);
        const count = Math.min(found, allowed);
        for (let i = 0; i < count; i++) { starts.push(t); if (starts.length > CAP) starts.shift(); }
        events.length = count;
        return count;
      }
      return { update, events, bots, reset() { bots.clear(); starts.length = 0; lastT = -Infinity; } };
    }

    // The nearest MAX_HRTF emitters get HRTF panning, the rest equal-power.
    const MAX_HRTF = 8;
    function hrtfNearest(list, max = MAX_HRTF) {
      const sorted = [...list].filter((e) => Number.isFinite(e.dist)).sort(byDist);
      return new Set(sorted.slice(0, max).map((e) => e.id));
    }

    // Today's kill ding rule (OkAdunfX qp.playHit(!0)).
    const killDingAllowed = (s, engine) => (s.killSound !== false && engine.weaponSounds !== null) || s.hitSound !== false;

    // Synth cues, WebAudio only.
    const noiseBuffers = new WeakMap();
    function noise(ctx) {
      let b = noiseBuffers.get(ctx);
      if (!b) { const n = Math.max(1, Math.floor(ctx.sampleRate * 0.02)); b = ctx.createBuffer(1, n, ctx.sampleRate); const d = b.getChannelData(0); let r = 0x2545f491; for (let i = 0; i < n; i++) { r = (r * 1664525 + 1013904223) >>> 0; d[i] = r / 0xffffffff * 2 - 1; } noiseBuffers.set(ctx, b); }
      return b;
    }
    function tone(ctx, dest, t, type, from, to, peak, decay) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(from, t); o.frequency.exponentialRampToValueAtTime(to, t + decay);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      o.connect(g); g.connect(dest); o.onended = () => { o.disconnect(); g.disconnect(); };
      o.start(t); o.stop(t + decay + 0.02);
    }
    const voices = {
      // Headshot: bright metallic dink, two detuned partials plus a 4 ms click (peak about 1 dB over the hit ding).
      dink(ctx, dest, t) {
        tone(ctx, dest, t, 'sine', 2600, 2480, 0.13, 0.12);
        tone(ctx, dest, t, 'triangle', 3912, 3800, 0.07, 0.09);
        const src = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
        src.buffer = noise(ctx); hp.type = 'highpass'; hp.frequency.value = 3000;
        g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004);
        src.connect(hp); hp.connect(g); g.connect(dest); src.onended = () => { src.disconnect(); hp.disconnect(); g.disconnect(); };
        src.start(t); src.stop(t + 0.01);
      },
      // Kill: two soft rising notes.
      kill(ctx, dest, t) {
        tone(ctx, dest, t, 'triangle', 660, 640, 0.14, 0.07);
        tone(ctx, dest, t + 0.075, 'triangle', 990, 970, 0.14, 0.07);
      },
    };

    const STEP_GAIN = { step: 0.5, land: 0.85 };
    function createFeelAudio(env = {}) {
      const storage = env.storage, win = env.win || {}, voice = env.voices || voices;
      const later = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
      const clock = env.now || (() => performance.now() / 1000);
      let mix;
      try { mix = loadMix(storage ? storage.getItem(KEY) : null); } catch { mix = { ...DEFAULTS }; }
      const listeners = new Set(), states = new WeakMap(), attached = new Set();
      const stats = { enemyShots: 0, spatialShots: 0, blockedShots: 0, headshots: 0, kills: 0, steps: 0, emitters: 0 };
      const lastStep = { step: -1, land: -1 };
      let current = null, checkEngine = null, checkRunning = false;

      const live = (ctx) => !!ctx && ctx.state !== 'closed';
      const soundOn = (engine) => { const s = engine && engine.settings && engine.settings.current; return !s || (s.enabled !== false && s.volume > 0); };
      const busOf = (out, name) => (out.bus && out.bus[name]) || out.master;

      function stateFor(ctx) {
        let st = states.get(ctx);
        if (!st) {
          st = { ctx, emitters: new Map(), sched: createStepScheduler(), lastFrame: -1, lastHrtf: -1, lastGc: -1,
            cam: { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, set: false } };
          states.set(ctx, st);
        }
        return st;
      }
      function dropState(st) {
        if (!st) return;
        for (const e of st.emitters.values()) disconnectEmitter(e);
        st.emitters.clear(); st.sched.reset();
      }
      function applyGains(engine) {
        const ctx = engine && engine.context, bus = engine && engine.bus;
        if (!live(ctx) || !bus) return;
        for (const k of LEVELS) { const node = bus[k]; if (node && node.gain) { try { node.gain.setTargetAtTime(mix[k], ctx.currentTime, 0.02); } catch { node.gain.value = mix[k]; } } }
      }

      function makePanner(ctx, hrtf) {
        const p = ctx.createPanner();
        p.panningModel = hrtf ? 'HRTF' : 'equalpower';
        p.distanceModel = 'linear'; p.rolloffFactor = 0; p.refDistance = 1; p.maxDistance = 10000;
        return p;
      }
      function setPos(p, x, y, z, ctx, smooth) {
        if (p.positionX) {
          const t = ctx.currentTime;
          if (smooth) { p.positionX.setTargetAtTime(x, t, 0.015); p.positionY.setTargetAtTime(y, t, 0.015); p.positionZ.setTargetAtTime(z, t, 0.015); }
          else { p.positionX.setValueAtTime(x, t); p.positionY.setValueAtTime(y, t); p.positionZ.setValueAtTime(z, t); }
        } else if (p.setPosition) p.setPosition(x, y, z);
      }
      function hrtfCount(st) { let n = 0; for (const e of st.emitters.values()) if (e.hrtf) n++; return n; }
      function emitter(st, id) {
        let e = st.emitters.get(id);
        if (!e) { e = { id, shot: null, step: null, hrtf: hrtfCount(st) < MAX_HRTF, x: 0, y: 0, z: 0, dist: Infinity, seen: st.ctx.currentTime }; st.emitters.set(id, e); stats.emitters = st.emitters.size; }
        return e;
      }
      function shotPart(st, e, out) {
        if (e.shot) return e.shot;
        const ctx = st.ctx, inClear = ctx.createGain(), inBlocked = ctx.createGain(), lp = ctx.createBiquadFilter(), panner = makePanner(ctx, e.hrtf);
        inBlocked.gain.value = Math.pow(10, -4 / 20);
        lp.type = 'lowpass'; lp.frequency.value = 20000;
        inClear.connect(lp); inBlocked.connect(lp); lp.connect(panner); panner.connect(busOf(out, 'enemy'));
        setPos(panner, e.x, e.y, e.z, ctx, false);
        return (e.shot = { inClear, inBlocked, lp, panner });
      }
      function stepPart(st, e, out) {
        if (e.step) return e.step;
        const p = makePanner(st.ctx, e.hrtf);
        p.connect(busOf(out, 'steps'));
        setPos(p, e.x, e.y - 1.45, e.z, st.ctx, false);
        return (e.step = p);
      }
      function disconnectEmitter(e) {
        try { if (e.shot) { e.shot.inClear.disconnect(); e.shot.inBlocked.disconnect(); e.shot.lp.disconnect(); e.shot.panner.disconnect(); } if (e.step) e.step.disconnect(); } catch {}
        e.shot = null; e.step = null;
      }
      function moveEmitter(e, x, y, z, ctx, smooth) {
        if (Math.abs(x - e.x) < 0.01 && Math.abs(y - e.y) < 0.01 && Math.abs(z - e.z) < 0.01) return;
        e.x = x; e.y = y; e.z = z;
        if (e.shot) setPos(e.shot.panner, x, y, z, ctx, smooth);
        if (e.step) setPos(e.step, x, y - 1.45, z, ctx, smooth);
      }
      function setHrtf(e, on) {
        if (e.hrtf === on) return;
        e.hrtf = on; const model = on ? 'HRTF' : 'equalpower';
        if (e.shot) e.shot.panner.panningModel = model;
        if (e.step) e.step.panningModel = model;
      }

      function playStep(out, dest, kind, gain) {
        const buffers = typeof win.__aimStepBuffers === 'function' ? win.__aimStepBuffers() : null, list = buffers && buffers[kind];
        if (!list || !list.length) return false;
        const ctx = out.context;
        let i = Math.floor(Math.random() * list.length);
        if (list.length > 1 && i === lastStep[kind]) i = (i + 1) % list.length;
        lastStep[kind] = i;
        const src = ctx.createBufferSource(), g = ctx.createGain();
        src.buffer = list[i]; src.playbackRate.value = 0.925 * (1 + (Math.random() - 0.5) * 0.08);
        g.gain.value = STEP_GAIN[kind] * gain;
        src.connect(g); g.connect(dest); src.onended = () => { src.disconnect(); g.disconnect(); };
        src.start(ctx.currentTime);
        stats.steps++;
        return true;
      }

      function updateListener(ctx, st, m) {
        const c = st.cam, x = m[12], y = m[13], z = m[14], fx = -m[8], fy = -m[9], fz = -m[10], ux = m[4], uy = m[5], uz = m[6];
        if (c.set && Math.abs(x - c.x) < 0.01 && Math.abs(y - c.y) < 0.01 && Math.abs(z - c.z) < 0.01 && fx * c.fx + fy * c.fy + fz * c.fz > 0.99996) return;
        c.x = x; c.y = y; c.z = z; c.fx = fx; c.fy = fy; c.fz = fz; c.ux = ux; c.uy = uy; c.uz = uz; c.set = true;
        const L = ctx.listener, t = ctx.currentTime;
        if (L.positionX) {
          L.positionX.setTargetAtTime(x, t, 0.015); L.positionY.setTargetAtTime(y, t, 0.015); L.positionZ.setTargetAtTime(z, t, 0.015);
          L.forwardX.setTargetAtTime(fx, t, 0.015); L.forwardY.setTargetAtTime(fy, t, 0.015); L.forwardZ.setTargetAtTime(fz, t, 0.015);
          L.upX.setTargetAtTime(ux, t, 0.015); L.upY.setTargetAtTime(uy, t, 0.015); L.upZ.setTargetAtTime(uz, t, 0.015);
        } else { L.setPosition?.(x, y, z); L.setOrientation?.(fx, fy, fz, ux, uy, uz); }
      }

      const notify = () => { const copy = { ...mix }; for (const fn of listeners) { try { fn(copy); } catch {} } };

      const api = {
        _stats: stats,
        get: () => ({ ...mix }),
        set(patch) {
          mix = sanitize({ ...mix, ...(patch && typeof patch === 'object' ? patch : {}) });
          try { storage && storage.setItem(KEY, JSON.stringify(mix)); } catch {}
          for (const engine of attached) applyGains(engine);
          if (!mix.spatial && current && current.context) { const st = states.get(current.context); if (st) { for (const e of st.emitters.values()) disconnectEmitter(e); st.emitters.clear(); stats.emitters = 0; } }
          notify();
          return { ...mix };
        },
        subscribe(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
        attach(engine) {
          if (!engine || !live(engine.context)) return;
          for (const e of [...attached]) if (!live(e.context) || !e.bus) attached.delete(e);
          attached.add(engine);
          applyGains(engine);
          if (engine === checkEngine) return;
          if (current && current.context !== engine.context) dropState(states.get(current.context));
          current = engine;
          stateFor(engine.context);
        },
        spatialOn: () => mix.spatial,
        enemyDest(out, sp) {
          try {
            stats.enemyShots++;
            if (!mix.spatial || !out || !live(out.context) || !sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y) || !Number.isFinite(sp.z)) return null;
            const st = stateFor(out.context), e = emitter(st, sp.id);
            e.seen = out.context.currentTime;
            moveEmitter(e, sp.x, sp.y, sp.z, out.context, false);
            const part = shotPart(st, e, out);
            part.lp.frequency.setValueAtTime(sp.blocked ? 1200 : 20000, out.context.currentTime);
            stats.spatialShots++;
            if (sp.blocked) stats.blockedShots++;
            return sp.blocked ? part.inBlocked : part.inClear;
          } catch { return null; }
        },
        cue(engine, kind, isHeadshot) {
          try {
            const s = engine && engine.settings && (engine.settings.current || null);
            if (!s || s.enabled === false || !(s.volume > 0)) return false;
            const head = isHeadshot === true && mix.headshot;
            if (kind === 'headshot') {
              if (!head) return false;
              if (s.hitSound === false) return true;
              const out = engine.ensure && engine.ensure();
              if (!out) return false;
              voice.dink(out.context, busOf(out, 'hits'), out.context.currentTime); stats.headshots++;
              return true;
            }
            // Kill with no skin sample. The game script asks for the headshot dink on its own
            // (cue "headshot" first), so this plays the kill cue only.
            if (kind !== 'kill' || !mix.killConfirm) return false;
            if (!killDingAllowed(s, engine)) return true;
            const out = engine.ensure && engine.ensure();
            if (!out) return false;
            voice.kill(out.context, busOf(out, 'hits'), out.context.currentTime); stats.kills++;
            return true;
          } catch { return false; }
        },
        frame(engine, m, snapshot, timeSec, dots) {
          if (!mix.spatial && !mix.botSteps) return;
          const ctx = engine && engine.context;
          if (!m || !live(ctx) || !soundOn(engine)) return;
          if (engine !== current && engine !== checkEngine) api.attach(engine);
          const st = stateFor(ctx), now = ctx.currentTime, wall = clock();
          if (wall >= st.lastFrame && wall - st.lastFrame < 1 / 60 - 0.001) return;
          st.lastFrame = wall;
          updateListener(ctx, st, m);
          const actors = snapshot && snapshot.actors, c = st.cam;
          if (st.emitters.size && actors) {
            for (const a of actors) {
              const e = st.emitters.get(a.id);
              if (!e || !a.position || !a.alive) continue;
              e.seen = now;
              const off = a.offset, x = a.position.x + (off ? off.x : 0), y = a.position.y + (off ? off.y : 0) + 1.45, z = a.position.z + (off ? off.z : 0);
              moveEmitter(e, x, y, z, ctx, true);
              e.dist = Math.hypot(x - c.x, y - c.y, z - c.z);
            }
            if (now - st.lastHrtf >= 0.25 || now < st.lastHrtf) {
              st.lastHrtf = now;
              const near = hrtfNearest(st.emitters.values());
              for (const e of st.emitters.values()) setHrtf(e, near.has(e.id));
            }
          }
          if (now - st.lastGc >= 1 || now < st.lastGc) {
            st.lastGc = now;
            for (const [id, e] of st.emitters) if (e.seen < now - STALE) { disconnectEmitter(e); st.emitters.delete(id); }
            stats.emitters = st.emitters.size;
          }
          if (!mix.botSteps || !Number.isFinite(timeSec)) return;
          const n = st.sched.update(actors, c.x, c.y, c.z, timeSec, dots);
          if (!n) return;
          const out = { context: ctx, master: engine.master, bus: engine.bus };
          if (!out.master) return;
          for (let i = 0; i < n; i++) {
            const ev = st.sched.events[i];
            let dest = busOf(out, 'steps');
            if (mix.spatial) { const e = emitter(st, ev.id); e.seen = now; moveEmitter(e, ev.x, ev.y + 1.45, ev.z, ctx, false); dest = stepPart(st, e, out); }
            playStep(out, dest, ev.kind, ev.gain);
          }
        },
        // The engine to use for a sound check: the drill's engine, or null.
        liveEngine() { const e = win.__aimAudio; return e && live(e.context) && e !== checkEngine ? e : null; },
        canSoundCheck() { return !!api.liveEngine() || typeof win.__aimAudioEngine === 'function'; },
        async soundCheck(opts = {}) {
          if (checkRunning) return { ok: false, reason: 'busy' };
          let engine = api.liveEngine(), temp = null;
          const prev = win.__aimAudio, restore = () => { if (temp && win.__aimAudio === temp) win.__aimAudio = prev; };
          if (!engine) {
            const Engine = win.__aimAudioEngine;
            if (typeof Engine !== 'function') return { ok: false, reason: 'no-engine' };
            temp = checkEngine = new Engine({ current: opts.settings || lobbySettings() });
            engine = temp;
          }
          checkRunning = true;
          const wait = (ms) => new Promise((r) => later(r, ms));
          const run = (fn) => { try { return fn(); } catch (err) { console.warn('Sound check:', err); return null; } finally { restore(); } };
          try {
            const out = run(() => engine.ensure());
            if (!out) return { ok: false, reason: 'muted' };
            if (temp) api.attach(temp);
            const st = stateFor(out.context), c = st.cam, rx = c.fy * c.uz - c.fz * c.uy, ry = c.fz * c.ux - c.fx * c.uz, rz = c.fx * c.uy - c.fy * c.ux;
            const at = (side, ahead, height) => ({ x: c.x + rx * side + c.fx * ahead, y: c.y + ry * side + c.fy * ahead + height, z: c.z + rz * side + c.fz * ahead });
            const gap = opts.gap ?? 600;
            run(() => engine.playFire());
            await wait(gap);
            for (const [id, side] of [[-101, -8], [-102, 8]]) {
              const p = at(side, 2, 0);
              run(() => engine.playEnemyFire(8, 'vandal', mix.spatial ? { id, x: p.x, y: p.y, z: p.z, blocked: false } : null));
              await wait(gap);
            }
            for (let i = 0; i < 6; i++) {
              const p = at(-6 + i * 2.4, 3, -1.5);
              run(() => {
                const o = engine.ensure(); if (!o) return;
                let dest = busOf(o, 'steps');
                if (mix.spatial) { const e = emitter(st, -103); e.seen = o.context.currentTime; moveEmitter(e, p.x, p.y + 1.45, p.z, o.context, false); dest = stepPart(st, e, o); }
                if (!playStep(o, dest, 'step', 1)) engine.playFootstep && engine.playFootstep();
              });
              await wait(Math.round(gap * 0.3));
            }
            await wait(Math.round(gap * 0.5));
            run(() => engine.playHit());
            await wait(gap);
            run(() => { const o = engine.ensure(); if (o) { voice.dink(o.context, busOf(o, 'hits'), o.context.currentTime); stats.headshots++; } });
            await wait(gap);
            run(() => { const o = engine.ensure(); if (o) { voice.kill(o.context, busOf(o, 'hits'), o.context.currentTime); stats.kills++; } });
            await wait(gap + 200);
            return { ok: true, lobby: !!temp };
          } finally {
            checkRunning = false;
            if (temp) {
              attached.delete(temp);
              try { const ctx = temp.context; temp.dispose(); if (ctx) states.delete(ctx); } catch {}
              if (win.__aimAudio === temp) win.__aimAudio = prev;
              checkEngine = null;
            }
          }
        },
      };
      // Game sound settings for the lobby sound check (same storage key and defaults as the game).
      function lobbySettings() {
        const base = { enabled: true, fireKit: 'gunVandal', hitSound: true, hitKit: 'ding', killSound: true, volume: 0.7 };
        try { const saved = JSON.parse(storage.getItem('al-audio-settings-v1') || 'null'); if (saved && typeof saved === 'object') return { ...base, ...saved }; } catch {}
        return base;
      }
      return api;
    }

    return { KEY, DEFAULTS, LEVELS, TOGGLES, sanitize, loadMix, createStepScheduler, hrtfNearest, falloff, killDingAllowed, createFeelAudio,
      constants: { RUN, WALK, ACC_START, STEP_MIN, PLAY_TIME, MIN_DT, TELEPORT, NEAR, FAR, CAP, CAP_WINDOW, MAX_HRTF, LAND_OFFSET } };
  })();

  if (typeof window === 'undefined') { module.exports = core; return; }
  if (window.__aimAudioMix) return;
  let storage = null;
  try { storage = window.localStorage; } catch {}
  const mixer = core.createFeelAudio({ storage, win: window });
  window.__aimAudioMix = mixer;
  if (window.__aimAudio) mixer.attach(window.__aimAudio);

  // Settings block under the master volume slider.
  const css = document.createElement('style');
  css.textContent = `.aim-audio-mix{display:flex;flex-direction:column;gap:inherit}.aim-audio-mix-check{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.aim-audio-mix-check button{padding:7px 14px;background:#222b36;color:#eee;border:1px solid #48515f;cursor:pointer;font:inherit}.aim-audio-mix-check button:hover:not(:disabled){border-color:#ff4655}.aim-audio-mix-check button:disabled{opacity:.5;cursor:default}.aim-audio-mix-check small{opacity:.75}`;
  document.head.append(css);
  const SLIDERS = [['weapon', 'Weapon', 'Your shots, reload and knife.'], ['enemy', 'Enemy shots', 'Bot gunfire and flashes.'], ['steps', 'Footsteps', 'Yours and the bots’.'], ['hits', 'Hits & kills', 'Hit, headshot, kill and target sounds.'], ['ui', 'Round & UI', 'Round beeps and the sound check.']];
  const SWITCHES = [['headshot', 'Headshot sound', 'A sharper ding when you hit the head.'], ['killConfirm', 'Kill confirm', 'Two short notes when a bot dies (skins with their own kill sound keep it).'], ['spatial', '3D enemy sound', 'Hear where bot shots come from.'], ['botSteps', 'Enemy footsteps', 'Hear running bots.']];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let unsubscribeMounted = null;
  function add() {
    const anchor = document.querySelector('[data-setting="volume"]');
    if (!anchor || !anchor.parentElement || anchor.parentElement.querySelector('.aim-audio-mix')) return;
    const scoped = [...anchor.attributes].filter((a) => a.name.startsWith('data-v-')).map((a) => a.name);
    const block = document.createElement('div');
    block.className = 'aim-audio-mix'; block.dataset.setting = 'audioMix';
    block.innerHTML = SLIDERS.map(([k, label, hint]) => `<div class="al-number-field" data-mix="${k}"><label><span>${esc(label)}</span><b></b></label><small class="al-number-hint">${esc(hint)}</small><div><input type="range" min="0" max="100" step="5" aria-label="${esc(label)}"><input type="number" min="0" max="100" step="5" aria-label="${esc(label)} %"><small class="al-number-unit">%</small></div></div>`).join('')
      + SWITCHES.map(([k, label, hint]) => `<label class="hall-field hall-switch" data-mix="${k}"><span class="hall-field-text"><b>${esc(label)}</b><small>${esc(hint)}</small></span><input class="hall-switch-input" type="checkbox"><span class="hall-switch-track" aria-hidden="true"><i></i></span></label>`).join('')
      + '<div class="hall-field aim-audio-mix-check"><button type="button">Sound check</button><small role="status"></small></div>';
    for (const el of [block, ...block.querySelectorAll('*')]) for (const attr of scoped) el.setAttribute(attr, '');
    for (const [k] of SLIDERS) {
      const row = block.querySelector(`[data-mix="${k}"]`), [range, num] = row.querySelectorAll('input');
      const commit = (v) => { const n = Number(v); if (Number.isFinite(n)) mixer.set({ [k]: Math.min(100, Math.max(0, n)) / 100 }); };
      range.addEventListener('input', () => commit(range.value));
      num.addEventListener('change', () => commit(num.value));
    }
    for (const [k] of SWITCHES) { const input = block.querySelector(`[data-mix="${k}"] input`); input.addEventListener('change', () => mixer.set({ [k]: input.checked })); }
    const button = block.querySelector('.aim-audio-mix-check button'), status = block.querySelector('.aim-audio-mix-check small');
    let busy = false;
    button.addEventListener('click', async () => {
      if (busy || !mixer.canSoundCheck()) return;
      busy = true; render(); status.textContent = 'Playing…';
      let result;
      try { result = await mixer.soundCheck(); } catch (err) { console.warn('Sound check:', err); result = { ok: false }; }
      busy = false; render();
      status.textContent = result.ok ? '' : result.reason === 'muted' ? 'Sound is off.' : result.reason === 'no-engine' ? 'Start a drill first' : '';
    });
    function render() {
      if (!block.isConnected) { unsubscribe(); return; }
      const s = mixer.get();
      for (const [k] of SLIDERS) {
        const row = block.querySelector(`[data-mix="${k}"]`), [range, num] = row.querySelectorAll('input'), v = Math.round(s[k] * 100);
        row.querySelector('b').textContent = v + ' %';
        if (document.activeElement !== range) range.value = String(v);
        if (document.activeElement !== num) num.value = String(v);
        range.style.setProperty('--fill', v + '%');
      }
      for (const [k] of SWITCHES) { const row = block.querySelector(`[data-mix="${k}"]`), on = !!s[k]; row.classList.toggle('is-on', on); row.querySelector('input').checked = on; }
      const can = mixer.canSoundCheck();
      button.disabled = busy || !can;
      if (!busy && !can) status.textContent = 'Start a drill first';
      else if (!busy && status.textContent === 'Start a drill first') status.textContent = '';
    }
    if (unsubscribeMounted) unsubscribeMounted();
    const unsubscribe = unsubscribeMounted = mixer.subscribe(render);
    anchor.after(block);
    render();
  }
  let queued = false;
  const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; add(); }); };
  if (typeof window.__aimWatchPage === 'function') window.__aimWatchPage(schedule, { childList: true, subtree: true });
  else new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  add();
})();
