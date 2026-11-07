// Checks for app/feel-audio.js: mix settings, the bot footstep scheduler, 3D emitters and
// which hit/headshot/kill sounds play.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../app/feel-audio.js');
const { constants: C } = core;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

// A stand-in AudioContext: enough nodes for the emitter code, recording connections.
function fakeContext() {
  const param = (v = 0) => ({ value: v, setValueAtTime(x) { this.value = x; }, setTargetAtTime(x) { this.value = x; }, exponentialRampToValueAtTime() {} });
  const node = (kind, extra = {}) => ({ kind, outputs: [], connect(n) { this.outputs.push(n); return n; }, disconnect() { this.outputs.length = 0; }, ...extra });
  const ctx = {
    state: 'running', currentTime: 0, sampleRate: 48000, nodes: [],
    listener: { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(-1), upX: param(), upY: param(1), upZ: param() },
    createGain() { const n = node('gain', { gain: param(1) }); this.nodes.push(n); return n; },
    createBiquadFilter() { const n = node('filter', { type: 'lowpass', frequency: param(350), Q: param(1) }); this.nodes.push(n); return n; },
    createPanner() { const n = node('panner', { panningModel: 'equalpower', distanceModel: 'inverse', rolloffFactor: 1, positionX: param(), positionY: param(), positionZ: param() }); this.nodes.push(n); return n; },
    createBufferSource() { const n = node('source', { buffer: null, playbackRate: param(1), start() {}, stop() {} }); this.nodes.push(n); return n; },
  };
  return ctx;
}
function fakeEngine(settings = {}, weaponSounds = []) {
  const context = fakeContext();
  const bus = { weapon: context.createGain(), enemy: context.createGain(), steps: context.createGain(), hits: context.createGain(), ui: context.createGain() };
  const master = context.createGain();
  const engine = { context, master, bus, weaponSounds, settings: { current: { enabled: true, volume: 0.7, hitSound: true, killSound: true, ...settings } }, ensureCalls: 0 };
  engine.ensure = () => { engine.ensureCalls++; const s = engine.settings.current; return s.enabled && s.volume > 0 ? { context, master, bus } : null; };
  return engine;
}
function spies() {
  const calls = [];
  return { calls, voices: { dink: (ctx, dest) => calls.push(['dink', dest]), kill: (ctx, dest) => calls.push(['kill', dest]) } };
}
const IDENTITY_CAM = (x = 0, y = 1.6, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

// ---------- settings ----------
test('settings: defaults, bad JSON and clamping', () => {
  assert.deepEqual(core.loadMix(null), { ...core.DEFAULTS });
  assert.deepEqual(core.loadMix('{not json'), { ...core.DEFAULTS });
  assert.deepEqual(core.loadMix('[1,2]'), { ...core.DEFAULTS });
  assert.deepEqual(core.loadMix('null'), { ...core.DEFAULTS });
  const s = core.loadMix(JSON.stringify({ v: 9, weapon: 2, enemy: -1, steps: 0.25, hits: 'loud', ui: NaN, headshot: false, killConfirm: 'no', spatial: false, botSteps: 0, extra: 1 }));
  assert.deepEqual(s, { v: 1, weapon: 1, enemy: 0, steps: 0.25, hits: 1, ui: 1, headshot: false, killConfirm: true, spatial: false, botSteps: true });
  assert.equal(core.KEY, 'al-audio-mix-v1');
});

test('settings: set() saves, clamps and tells subscribers', () => {
  const storage = memoryStorage({ 'al-audio-mix-v1': JSON.stringify({ enemy: 0.5 }) });
  const mix = core.createFeelAudio({ storage });
  assert.equal(mix.get().enemy, 0.5);
  const seen = [];
  const off = mix.subscribe((s) => seen.push(s));
  mix.set({ weapon: 3, botSteps: false });
  assert.equal(mix.get().weapon, 1);
  assert.equal(mix.get().botSteps, false);
  assert.deepEqual(JSON.parse(storage.data.get('al-audio-mix-v1')), mix.get());
  assert.equal(seen.length, 1);
  off();
  mix.set({ weapon: 0.2 });
  assert.equal(seen.length, 1);
  // A storage that throws still works in memory.
  const broken = core.createFeelAudio({ storage: { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } } });
  assert.deepEqual(broken.get(), { ...core.DEFAULTS });
  assert.equal(broken.set({ ui: 0.3 }).ui, 0.3);
});

test('settings: bus gains follow the mix', () => {
  const engine = fakeEngine();
  const mix = core.createFeelAudio({ storage: memoryStorage({ 'al-audio-mix-v1': JSON.stringify({ hits: 0.4 }) }) });
  mix.attach(engine);
  assert.equal(engine.bus.hits.gain.value, 0.4);
  mix.set({ enemy: 0.25, ui: 0 });
  assert.equal(engine.bus.enemy.gain.value, 0.25);
  assert.equal(engine.bus.ui.gain.value, 0);
  assert.equal(engine.bus.weapon.gain.value, 1);
  // An engine without buses (old game script) is fine.
  mix.attach({ context: fakeContext(), master: {}, bus: null, settings: { current: {} } });
});

// ---------- footstep scheduler ----------
const bot = (id, x, z, extra = {}) => ({ id, templateId: 't' + id, alive: true, position: { x, y: 0, z }, offset: { x: 0, y: 0, z: 0 }, ...extra });
function runTrack(sched, track, seconds, { dt = 1 / 60, listener = [0, 1.6, 0], dots } = {}) {
  const out = [];
  for (let t = 0; t <= seconds + 1e-9; t += dt) {
    const actors = track(t);
    const n = sched.update(actors, listener[0], listener[1], listener[2], t, dots);
    for (let i = 0; i < n; i++) out.push({ t, ...sched.events[i] });
  }
  return out;
}

test('scheduler: running bot steps at the player cadence', () => {
  const sched = core.createStepScheduler();
  const steps = runTrack(sched, (t) => [bot(1, 5 + C.RUN * t, 3)], 3);
  assert.ok(steps.length >= 9 && steps.length <= 11, `steps ${steps.length}`);
  assert.ok(steps.every((s) => s.kind === 'step' && s.id === 1));
  for (let i = 1; i < steps.length; i++) {
    const gap = steps[i].t - steps[i - 1].t;
    assert.ok(Math.abs(gap - C.PLAY_TIME) < 0.04, `gap ${gap}`);
  }
});

test('scheduler: walking (60% of run speed or less) is silent', () => {
  const sched = core.createStepScheduler();
  assert.equal(runTrack(sched, (t) => [bot(1, 0.6 * C.RUN * t, 3)], 5).length, 0);
  assert.equal(runTrack(core.createStepScheduler(), (t) => [bot(1, 2 + Math.sin(t * 3) * 0.5, 3)], 5).length, 0);
});

test('scheduler: teleports are ignored and reset the step timer', () => {
  const sched = core.createStepScheduler();
  // Run for 0.25 s (just under one step), jump 6 m in one update, then keep running.
  const track = (t) => [bot(1, (t < 0.25 ? 0 : 6) + C.RUN * t, 3)];
  const steps = runTrack(sched, track, 0.7);
  assert.ok(steps.length >= 1);
  assert.ok(steps[0].t >= 0.25 + C.PLAY_TIME - 0.04, `first step at ${steps[0].t}`);
  // A bot that only ever teleports makes no sound.
  const hop = core.createStepScheduler();
  assert.equal(runTrack(hop, (t) => [bot(2, Math.floor(t * 4) * 8, 3)], 4).length, 0);
});

test('scheduler: at most 4 starts per 100 ms, nearest first', () => {
  const sched = core.createStepScheduler();
  const many = (t) => Array.from({ length: 10 }, (_, i) => bot(i, 2 + i * 2 + C.RUN * t * 0, 1 + i * 2 + C.RUN * t));
  const steps = runTrack(sched, many, 2);
  assert.ok(steps.length > 0);
  // Group by time: each update offers 10 steps at once; only the 4 nearest get through.
  const first = steps.filter((s) => s.t === steps[0].t);
  assert.equal(first.length, 4);
  assert.deepEqual(first.map((s) => s.id), [0, 1, 2, 3]);
  for (const s of steps) {
    const inWindow = steps.filter((o) => o.t > s.t - C.CAP_WINDOW && o.t <= s.t);
    assert.ok(inWindow.length <= 4, `window at ${s.t}: ${inWindow.length}`);
  }
});

test('scheduler: range falloff (full to 10 m, none from 40 m)', () => {
  assert.equal(core.falloff(0), 1);
  assert.equal(core.falloff(10), 1);
  assert.equal(core.falloff(25), 0.5);
  assert.equal(core.falloff(40), 0);
  assert.equal(core.falloff(80), 0);
  const near = runTrack(core.createStepScheduler(), (t) => [bot(1, C.RUN * t, 25)], 2);
  assert.ok(near.length > 0 && near.every((s) => s.gain > 0.3 && s.gain < 0.75), JSON.stringify(near[0]));
  assert.equal(runTrack(core.createStepScheduler(), (t) => [bot(1, C.RUN * t, 45)], 2).length, 0);
});

test('scheduler: grid dots, dead bots and dt = 0 are skipped safely', () => {
  const dots = new Set(['t1']);
  assert.equal(runTrack(core.createStepScheduler(), (t) => [bot(1, C.RUN * t, 3)], 2, { dots }).length, 0);
  assert.equal(runTrack(core.createStepScheduler(), (t) => [bot(1, C.RUN * t, 3, { alive: false })], 2).length, 0);
  // Paused game: the same time over and over.
  const sched = core.createStepScheduler();
  runTrack(sched, (t) => [bot(1, C.RUN * t, 3)], 0.2);
  for (let i = 0; i < 100; i++) {
    assert.equal(sched.update([bot(1, 3, 3)], 0, 1.6, 0, 0.2, null), 0);
  }
  // Missing actors / odd input does not throw.
  assert.equal(sched.update(null, 0, 0, 0, 0.3, null), 0);
  assert.equal(sched.update([null, {}, { id: 5, alive: true, position: { x: 0, y: 0, z: 0 } }], 0, 0, 0, 0.4, null), 0);
  // Time going back (replay seek) resets without throwing.
  assert.equal(sched.update([bot(1, 0, 3)], 0, 1.6, 0, 0.1, null), 0);
});

test('scheduler: landing after a jump', () => {
  const sched = core.createStepScheduler();
  const track = (t) => [bot(1, 3, 3, { offset: { x: 0, y: t > 0.5 && t < 1.1 ? Math.sin((t - 0.5) / 0.6 * Math.PI) * 0.9 : 0, z: 0 } })];
  const events = runTrack(sched, track, 1.5);
  assert.deepEqual(events.map((e) => e.kind), ['land']);
});

// The sim's bot `jump` behaviour (BiMsX6Xn aN): gravity 18, launch speed sqrt(2*g*h), so the arc
// peaks at exactly `height` (0.8 m in every shipped drill) and lasts 2*v/g.
function jumpArc(t, start, height = 0.8, g = 18) {
  const v = Math.sqrt(2 * g * height), a = t - start;
  return a > 0 && a < 2 * v / g ? Math.max(0, v * a - g * a * a / 2) : 0;
}

test('scheduler: every real bot jump lands; stairs, ledge drops and tiny hops do not', () => {
  // Three 0.8 m jumps, sampled at ~19 fps (hidden copy) and 60 fps.
  for (const dt of [1 / 19, 1 / 60]) {
    const track = (t) => [bot(1, 3, 3, { offset: { x: 0, y: jumpArc(t, 0.5) + jumpArc(t, 2) + jumpArc(t, 3.5), z: 0 } })];
    const events = runTrack(core.createStepScheduler(), track, 4.5, { dt });
    assert.deepEqual(events.map((e) => e.kind), ['land', 'land', 'land'], `dt ${dt}`);
  }
  // Walking down 0.3 m stairs and dropping off a 1.5 m ledge: position.y only, offset stays 0.
  const stairs = (t) => [bot(1, 3, 3, { position: { x: 3 + 0.6 * C.RUN * t, y: -0.3 * Math.floor(t * 4), z: 3 } })];
  assert.equal(runTrack(core.createStepScheduler(), stairs, 3).filter((e) => e.kind === 'land').length, 0);
  const ledge = (t) => [bot(1, 3, 3, { position: { x: 3, y: t < 1 ? 1.5 : Math.max(0, 1.5 - 9 * (t - 1) ** 2), z: 3 } })];
  assert.equal(runTrack(core.createStepScheduler(), ledge, 2).length, 0);
  // A hop lower than LAND_OFFSET stays silent.
  const hop = (t) => [bot(1, 3, 3, { offset: { x: 0, y: jumpArc(t, 0.5, 0.25), z: 0 } })];
  assert.equal(C.LAND_OFFSET, 0.3);
  assert.equal(runTrack(core.createStepScheduler(), hop, 1.5).length, 0);
});

test('HRTF goes to the nearest 8', () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ id: i, dist: [9, 3, 30, 1, 7, 12, 2, 40, 5, 6, 8, Infinity][i] }));
  assert.deepEqual([...core.hrtfNearest(list)].sort((a, b) => a - b), [0, 1, 3, 4, 6, 8, 9, 10]);
  assert.equal(core.hrtfNearest(list.slice(0, 3)).size, 3);
});

// ---------- 3D emitters ----------
test('enemy shots: one emitter per bot, HRTF for the nearest 8, walls muffle', () => {
  const engine = fakeEngine();
  const mix = core.createFeelAudio({ storage: memoryStorage(), now: () => engine.context.currentTime });
  mix.attach(engine);
  const out = engine.ensure();
  const nodes = [];
  for (let i = 0; i < 12; i++) nodes.push(mix.enemyDest(out, { id: i, x: 40 - i * 3, y: 1.45, z: 0, blocked: false }));
  assert.ok(nodes.every((n) => n && n.kind === 'gain'));
  assert.equal(mix._stats.emitters, 12);
  assert.equal(mix._stats.spatialShots, 12);
  const panners = engine.context.nodes.filter((n) => n.kind === 'panner');
  assert.equal(panners.length, 12);
  assert.ok(panners.every((p) => p.distanceModel === 'linear' && p.rolloffFactor === 0));
  assert.ok(panners.every((p) => p.outputs[0] === engine.bus.enemy));
  // Same bot again: same emitter.
  assert.equal(mix.enemyDest(out, { id: 3, x: 1, y: 1.45, z: 0, blocked: false }), nodes[3]);
  assert.equal(engine.context.nodes.filter((n) => n.kind === 'panner').length, 12);
  // Blocked shot: the -4 dB input and a 1.2 kHz low-pass.
  const blocked = mix.enemyDest(out, { id: 3, x: 1, y: 1.45, z: 0, blocked: true });
  assert.notEqual(blocked, nodes[3]);
  assert.ok(Math.abs(blocked.gain.value - Math.pow(10, -4 / 20)) < 1e-9);
  assert.equal(blocked.outputs[0].frequency.value, 1200);
  assert.equal(mix._stats.blockedShots, 1);
  // A frame with the bots in place: the 8 nearest are HRTF.
  engine.context.currentTime = 1;
  const actors = Array.from({ length: 12 }, (_, i) => bot(i, 40 - i * 3, 0));
  mix.frame(engine, IDENTITY_CAM(), { actors }, 1, new Set());
  const hrtf = panners.filter((p) => p.panningModel === 'HRTF').length;
  assert.equal(hrtf, 8);
  // Nearest bots are ids 4..11 (x = 28..7); the farthest (id 0, x = 40) is equal-power.
  assert.equal(panners[0].panningModel, 'equalpower');
  assert.equal(panners[11].panningModel, 'HRTF');
  // Listener follows the camera.
  assert.equal(engine.context.listener.positionY.value, 1.6);
  // Spatial off: no emitters, old path.
  mix.set({ spatial: false });
  assert.equal(mix.spatialOn(), false);
  assert.equal(mix.enemyDest(out, { id: 1, x: 0, y: 0, z: 0, blocked: false }), null);
  // Bad input falls back.
  mix.set({ spatial: true });
  assert.equal(mix.enemyDest(out, { id: 1, x: NaN, y: 0, z: 0 }), null);
  assert.equal(mix.enemyDest(null, { id: 1, x: 0, y: 0, z: 0 }), null);
});

test('frame: bot footsteps play on the steps bus, and do nothing when sound is off', () => {
  const engine = fakeEngine();
  const buffers = { step: [{}, {}, {}], land: [{}] };
  let clock = 0;
  const mix = core.createFeelAudio({ storage: memoryStorage(), win: { __aimStepBuffers: () => buffers }, now: () => clock });
  mix.attach(engine);
  for (let t = 0; t <= 2; t += 1 / 60) { clock = t; engine.context.currentTime = t; mix.frame(engine, IDENTITY_CAM(), { actors: [bot(1, C.RUN * t, 4)] }, t, new Set()); }
  assert.ok(mix._stats.steps >= 5, `steps ${mix._stats.steps}`);
  const stepPanner = engine.context.nodes.find((n) => n.kind === 'panner');
  assert.equal(stepPanner.outputs[0], engine.bus.steps);
  const before = engine.context.nodes.length;
  engine.settings.current.volume = 0;
  for (let t = 2; t <= 3; t += 1 / 60) { clock = t; engine.context.currentTime = t; mix.frame(engine, IDENTITY_CAM(), { actors: [bot(1, C.RUN * t, 4)] }, t, new Set()); }
  assert.equal(engine.context.nodes.length, before);
  // Both toggles off: no-op.
  engine.settings.current.volume = 0.7;
  mix.set({ spatial: false, botSteps: false });
  for (let t = 3; t <= 4; t += 1 / 60) { clock = t; engine.context.currentTime = t; mix.frame(engine, IDENTITY_CAM(), { actors: [bot(1, C.RUN * t, 4)] }, t, new Set()); }
  assert.equal(engine.context.nodes.length, before);
  // Footsteps without 3D: straight to the steps bus.
  mix.set({ botSteps: true });
  for (let t = 4; t <= 5; t += 1 / 60) { clock = t; engine.context.currentTime = t; mix.frame(engine, IDENTITY_CAM(), { actors: [bot(1, C.RUN * t, 4)] }, t, new Set()); }
  const gains = engine.context.nodes.slice(before).filter((n) => n.kind === 'gain');
  assert.ok(gains.length > 0 && gains.every((g) => g.outputs[0] === engine.bus.steps));
});

test('frame: parameter updates are capped at 60 per second', () => {
  const engine = fakeEngine();
  let clock = 0, sets = 0;
  const mix = core.createFeelAudio({ storage: memoryStorage(), now: () => clock });
  mix.attach(engine);
  const L = engine.context.listener, orig = L.positionX.setTargetAtTime;
  L.positionX.setTargetAtTime = function (v) { sets++; return orig.call(this, v); };
  for (let i = 0; i < 240; i++) { clock = i / 240; mix.frame(engine, IDENTITY_CAM(i, 1.6, 0), { actors: [] }, clock, null); }
  assert.ok(sets <= 61 && sets >= 50, `listener updates ${sets}`);
});

// ---------- hit / headshot / kill sounds ----------
function setup(settings = {}, mixSettings = {}, weaponSounds = []) {
  const engine = fakeEngine(settings, weaponSounds);
  const spy = spies();
  const mix = core.createFeelAudio({ storage: memoryStorage({ 'al-audio-mix-v1': JSON.stringify(mixSettings) }), voices: spy.voices });
  return { engine, mix, calls: spy.calls };
}
// How the game script uses cue() (tools/feel_audio_patch.py, OkAdunfX shot branch):
//   kill:  __aimHS && cue(re,"headshot",true); re.playKill(...) || cue(re,"kill",__aimHS) || re.playHit(true)
//   hit:   (__aimHS && cue(re,"headshot",true)) || re.playHit()
//   dot-only kill: re.playKill(...) only.
function shotBranch(mix, engine, { kill, head, skinPlayed = false, dotOnly = false }) {
  const played = [];
  const playHit = (isKill = false) => {
    const n = engine.settings.current;
    if (!(isKill && engine.weaponSounds !== null && n.killSound !== false) && n.hitSound === false) return;
    played.push(isKill ? 'killDing' : 'ding');
  };
  const playKill = () => { if (skinPlayed) played.push('skin'); return skinPlayed; };
  if (kill) {
    if (dotOnly) playKill();
    else { if (head) mix.cue(engine, 'headshot', true); playKill() || mix.cue(engine, 'kill', head) || playHit(true); }
  } else if (!(head && mix.cue(engine, 'headshot', true))) playHit();
  return played;
}
const names = (calls) => calls.map((c) => c[0]);

test('cue: hits and headshots', () => {
  let s = setup();
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: false, head: false }), ['ding']);
  assert.deepEqual(names(s.calls), []);
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: false, head: true }), []);
  assert.deepEqual(names(s.calls), ['dink']);
  assert.equal(s.calls[0][1], s.engine.bus.hits);
  // Headshot toggle off: the normal ding.
  s = setup({}, { headshot: false });
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: false, head: true }), ['ding']);
  assert.deepEqual(names(s.calls), []);
  // Hit sound off: silent, like today.
  s = setup({ hitSound: false });
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: false, head: true }), []);
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: false, head: false }), []);
  assert.deepEqual(names(s.calls), []);
});

test('cue: kills', () => {
  // No skin sample, kill sound on: the synth kill cue instead of the ding.
  let s = setup();
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: false }), []);
  assert.deepEqual(names(s.calls), ['kill']);
  // Headshot kill: dink layered with the kill cue.
  s = setup();
  shotBranch(s.mix, s.engine, { kill: true, head: true });
  assert.deepEqual(names(s.calls), ['dink', 'kill']);
  // Skin kill sample played: keep it, add the dink on a headshot only.
  s = setup();
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: false, skinPlayed: true }), ['skin']);
  assert.deepEqual(names(s.calls), []);
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: true, skinPlayed: true }), ['skin']);
  assert.deepEqual(names(s.calls), ['dink']);
  // Kill sound toggle (ours) off: the old kill ding, still with the dink on a headshot.
  s = setup({}, { killConfirm: false });
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: false }), ['killDing']);
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: true }), ['killDing']);
  assert.deepEqual(names(s.calls), ['dink']);
  // Game kill sound off but hit sound on: today's ding rule still plays -> kill cue.
  s = setup({ killSound: false });
  shotBranch(s.mix, s.engine, { kill: true, head: false });
  assert.deepEqual(names(s.calls), ['kill']);
  // Game kill sound on, hit sound off: plays only when weapon sounds are loaded (today's rule).
  s = setup({ hitSound: false });
  shotBranch(s.mix, s.engine, { kill: true, head: true });
  assert.deepEqual(names(s.calls), ['kill']);
  s = setup({ hitSound: false }, {}, null);
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: true }), []);
  assert.deepEqual(names(s.calls), []);
  // Both off: silent.
  s = setup({ hitSound: false, killSound: false });
  assert.deepEqual(shotBranch(s.mix, s.engine, { kill: true, head: true }), []);
  assert.deepEqual(names(s.calls), []);
  // Grid dot only: playKill only, no synth sounds.
  s = setup();
  shotBranch(s.mix, s.engine, { kill: true, head: true, dotOnly: true });
  assert.deepEqual(names(s.calls), []);
});

test('cue: sound off or odd input falls back to the old sounds', () => {
  const s = setup({ enabled: false });
  assert.equal(s.mix.cue(s.engine, 'headshot', true), false);
  assert.equal(s.mix.cue(s.engine, 'kill', true), false);
  const t = setup({ volume: 0 });
  assert.equal(t.mix.cue(t.engine, 'kill', false), false);
  assert.equal(t.mix.cue(null, 'kill', false), false);
  assert.equal(t.mix.cue({}, 'kill', false), false);
  assert.equal(t.mix.cue(setup().engine, 'other', true), false);
  assert.equal(t.mix.cue(setup().engine, 'headshot', false), false);
  const broken = setup();
  broken.engine.ensure = () => { throw new Error('closed'); };
  assert.equal(broken.mix.cue(broken.engine, 'kill', true), false);
  assert.deepEqual(names(t.calls), []);
});

test('sound check: needs an engine; runs with a stand-in engine in the lobby', async () => {
  const storage = memoryStorage();
  const none = core.createFeelAudio({ storage, win: {} });
  assert.equal(none.canSoundCheck(), false);
  assert.deepEqual(await none.soundCheck(), { ok: false, reason: 'no-engine' });
  const played = [];
  let disposed = 0;
  const REAL = { context: null, real: true };
  const win = { __aimAudio: undefined };
  class Engine {
    constructor(settings) { this.settings = settings; this.context = null; this.weaponSounds = null; }
    ensure() { if (!this.context) { const e = fakeEngine(); this.context = e.context; this.master = e.master; this.bus = e.bus; win.__aimAudio = this; win.__aimAudioMix?.attach(this); } return { context: this.context, master: this.master, bus: this.bus }; }
    playFire() { played.push('fire'); }
    playEnemyFire(d, w, sp) { played.push('enemy'); if (sp) win.__aimAudioMix.enemyDest(this.ensure(), sp); }
    playFootstep() { played.push('step'); }
    // The drill's real engine appears mid-check (a bot shot): the check must not undo it.
    playHit() { played.push('hit'); win.__aimAudio = REAL; }
    dispose() { disposed++; this.context = null; this.bus = null; }
  }
  win.__aimAudioEngine = Engine;
  const spy = spies();
  const mix = core.createFeelAudio({ storage, win, voices: spy.voices, setTimeout: (fn) => setImmediate(fn) });
  win.__aimAudioMix = mix;
  assert.equal(mix.canSoundCheck(), true);
  const result = await mix.soundCheck();
  assert.deepEqual(result, { ok: true, lobby: true });
  assert.deepEqual(played, ['fire', 'enemy', 'enemy', 'step', 'step', 'step', 'step', 'step', 'step', 'hit']);
  assert.deepEqual(names(spy.calls), ['dink', 'kill']);
  assert.equal(disposed, 1);
  assert.equal(win.__aimAudio, REAL);
  assert.equal(mix._stats.spatialShots, 2);
});
