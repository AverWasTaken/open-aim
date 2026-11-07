// Checks for tools/feel_audio_patch.py (audio buses, soft clipper and hooks for app/feel-audio.js in
// the mods OkAdunfX.js): every patched spot is there exactly once in both copies, the copies are
// identical, a second run refuses, the clipper curve is the identity below 0.8 and never above 1,
// the bus graph and the enemy-shot spatial helper work on stand-ins, and the file still parses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const JS = [path.join('app', 'mods', 'next', 'js'), path.join('app', 'mods', '_assets', 'r20261021-1', 'next', 'js')];
const FILE = 'OkAdunfX.js';
const copies = JS.map((d) => fs.readFileSync(path.join(root, d, FILE), 'utf-8').replace(/\r\n/g, '\n'));
const src = copies[0];
const count = (s, needle) => s.split(needle).length - 1;

// [text that only the patch writes, expected count]
const MARKERS = [
  ['typeof window<"u"&&(window.__aimStepBuffers=()=>(Wl(),cr));', 1],
  ['context=null;master=null;bus=null;', 1],
  ['__aimAudioBuild(this),window.__aimAudio=this,window.__aimAudioMix?.attach?.(this)', 1],
  ['{context:this.context,master:n,bus:this.bus}}', 1],
  ['playSkinFire(n.context,n.bus?.weapon??n.master,', 1],
  ['this.fire(n.context,n.bus?.weapon??n.master,', 1],
  ['playEnemyFire(t,n=null,sp=null){', 1],
  ['o.connect((sp&&window.__aimAudioMix?.enemyDest?.(s,sp))||s.bus?.enemy||s.master),', 1],
  ['__aimPlayGridTarget(a.context,a.bus?.hits??a.master)', 1],
  ['P0(t.context,t.bus?.enemy??t.master,', 1],
  ['D0(a.context,a.bus?.hits??a.master,', 1],
  ['playSkinKill(local.context,local.bus?.hits??local.master,', 1],
  ['O0(a.context,a.bus?.hits??a.master,', 1],
  ['Gl(t.context,t.bus?.steps??t.master,"step",', 1],
  ['Gl(t.context,t.bus?.steps??t.master,"land",', 1],
  ['U0(t.context,t.bus?.weapon??t.master,', 1],
  ['y=u(E,C.bus?.enemy??C.master)', 2],
  ['this.bus=null,typeof window<"u"&&window.__aimAudio===this&&(window.__aimAudio=null)}}', 1],
  ['typeof window<"u"&&(window.__aimAudioEngine=qp);const Zp=32.5,Qp=1.05', 1],
  ['"vandal",Be&&window.__aimAudioMix?.spatialOn?.()?__aimEnemySpatial(Be,he,de,Ae.player):null),', 1],
  ['const __aimHS=(he.pellets??[he]).some(', 1],
  ['(__aimHS&&window.__aimAudioMix?.cue?.(re,"headshot",!0),re.playKill?.(', 1],
  ['||window.__aimAudioMix?.cue?.(re,"kill",__aimHS)||re.playHit(!0))),Qn=0,', 1],
  ['&&!__aimDotOnly&&(__aimHS&&window.__aimAudioMix?.cue?.(re,"headshot",!0)||re.playHit());', 1],
  [',window.__aimAudioMix?.frame?.(re,r.camera.matrixWorld.elements,ce,Fe,__aimDotTemplates),re.flash){', 1],
  ['\nfunction __aimClipCurve(n,h){', 1],
  ['\nfunction __aimAudioBuild(e){', 1],
  ['\nfunction __aimEnemySpatial(b,h,d,p){', 1],
];
// Old routing that must be gone.
const GONE = ['this.master.connect(this.context.destination)', 'o.connect(s.master)', ',t.master,', ',a.master,',
  'a.context,a.master)', 'local.context,local.master', 'n.context,n.master', 'u(E,C.master)'];

// Pull one top-level `function name(...){...}` line out of the bundle tail and build it.
function extract(name, ...deps) {
  const m = src.match(new RegExp(`^function ${name}\\([^\\n]*$`, 'm'));
  assert.ok(m, `${name} not found`);
  return new Function(...deps, `${m[0]}\nreturn ${name};`);
}

test('every patched spot is there the expected number of times in both copies', () => {
  for (const [i, text] of copies.entries()) {
    for (const [needle, n] of MARKERS) assert.equal(count(text, needle), n, `${JS[i]}: ${needle}`);
    for (const needle of GONE) assert.equal(count(text, needle), 0, `${JS[i]}: old routing left: ${needle}`);
  }
});

test('both copies are byte-identical', () => {
  const raw = JS.map((d) => fs.readFileSync(path.join(root, d, FILE)));
  assert.ok(raw[0].equals(raw[1]));
});

test('a second run refuses and leaves the files alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feel-audio-patch-'));
  try {
    for (const d of JS) {
      const rel = path.relative(path.join('app', 'mods'), d);
      fs.mkdirSync(path.join(tmp, rel), { recursive: true });
      fs.copyFileSync(path.join(root, d, FILE), path.join(tmp, rel, FILE));
    }
    let failed = false, out = '';
    try {
      execFileSync('python', ['-I', path.join(root, 'tools', 'feel_audio_patch.py'), '--mods', tmp], { stdio: 'pipe' });
    } catch (e) {
      failed = true;
      out = String(e.stderr || '') + String(e.stdout || '');
    }
    assert.ok(failed, 'second run should fail');
    assert.match(out, /already patched/);
    for (const d of JS) {
      const rel = path.relative(path.join('app', 'mods'), d);
      assert.ok(fs.readFileSync(path.join(tmp, rel, FILE)).equals(fs.readFileSync(path.join(root, d, FILE))));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('soft clipper: identity below 0.8, monotonic, never above 1', () => {
  const build = src.match(/^function __aimAudioBuild\([^\n]*$/m)[0];
  // The graph the curve is used in: pre gain .5, 4097-point curve over +-2, post gain 2.
  assert.ok(build.includes('p.gain.value=.5'));
  assert.ok(build.includes('w.curve=__aimClipCurve(4097,2)'));
  assert.ok(build.includes('w.oversample="none"'));
  assert.ok(build.includes('q.gain.value=2'));
  const curve = extract('__aimClipCurve')()(4097, 2);
  assert.ok(curve instanceof Float32Array && curve.length >= 4096);
  // WaveShaperNode lookup (Web Audio spec: linear interpolation, inputs outside [-1, 1] clamp).
  const N = curve.length;
  const shape = (s) => {
    const v = ((N - 1) / 2) * (s + 1);
    if (v <= 0) return curve[0];
    if (v >= N - 1) return curve[N - 1];
    const k = Math.floor(v), f = v - k;
    return (1 - f) * curve[k] + f * curve[k + 1];
  };
  const transfer = (x) => 2 * shape(0.5 * x);
  let prev = -Infinity;
  for (let i = -30000; i <= 30000; i++) {
    const x = i / 10000; // -3 .. 3
    const y = transfer(x);
    if (Math.abs(x) <= 0.8) assert.ok(Math.abs(y - x) <= 1e-6, `not identity at ${x}: ${y}`);
    assert.ok(Math.abs(y) <= 1, `|y| > 1 at ${x}: ${y}`);
    assert.ok(y >= prev - 1e-9, `not monotonic at ${x}`);
    prev = y;
  }
  for (const v of curve) assert.ok(Math.abs(v) <= 0.5 + 1e-7); // times post gain 2 -> <= 1
  assert.equal(curve[(N - 1) / 2], 0);
  assert.ok(transfer(1) > 0.93 && transfer(1) < 0.96); // knee: 0.8 + 0.2 * tanh(1)
  assert.ok(transfer(3) > 0.999);
});

test('bus graph: buses -> master -> pre -> shaper -> post -> destination', () => {
  const edges = [];
  class Node {
    constructor(kind) { this.kind = kind; this.gain = { value: 1 }; }
    connect(to) { edges.push([this, to]); return to; }
  }
  const ctx = { destination: new Node('destination') };
  ctx.createGain = () => new Node('gain');
  ctx.createWaveShaper = () => new Node('shaper');
  const engine = { context: ctx, master: new Node('master') };
  extract('__aimAudioBuild', '__aimClipCurve')(extract('__aimClipCurve')())(engine);
  assert.deepEqual(Object.keys(engine.bus), ['weapon', 'enemy', 'steps', 'hits', 'ui']);
  for (const g of Object.values(engine.bus)) {
    assert.equal(g.gain.value, 1);
    assert.deepEqual(edges.filter(([a]) => a === g).map(([, b]) => b), [engine.master]);
  }
  const next = (n) => edges.filter(([a]) => a === n).map(([, b]) => b);
  const [pre] = next(engine.master);
  assert.equal(next(engine.master).length, 1);
  assert.equal(pre.gain.value, 0.5);
  const [shaper] = next(pre);
  assert.equal(shaper.kind, 'shaper');
  assert.equal(shaper.oversample, 'none');
  const [post] = next(shaper);
  assert.equal(post.gain.value, 2);
  assert.deepEqual(next(post), [ctx.destination]);
});

test('enemy shot spatial info: muzzle, wall flag, sight test only for misses', () => {
  const spatial = extract('__aimEnemySpatial')();
  const bot = { id: 7, position: { x: 1, y: 2, z: 3 }, offset: { x: 0.5, y: 0.25, z: -1 } };
  const player = { position: { x: 10, y: 0, z: 0 }, crouchAmount: 1 };
  const calls = [];
  const sim = (blocked) => ({ sightBlocked: (a, b) => (calls.push([a, b]), blocked) });
  let r = spatial(bot, { hit: false, wall: 0.5 }, sim(false), player);
  assert.deepEqual(r, { id: 7, x: 1.5, y: 2 + 0.25 + 1.45, z: 2, blocked: true });
  assert.equal(calls.length, 0);
  r = spatial(bot, { hit: true }, sim(true), player);
  assert.equal(r.blocked, false);
  assert.equal(calls.length, 0);
  r = spatial(bot, { hit: false }, sim(true), player);
  assert.equal(r.blocked, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { x: 1.5, y: 2 + 0.25 + 1.45, z: 2 });
  assert.deepEqual(calls[0][1], { x: 10, y: 1.5 * 0.7, z: 0 });
  r = spatial(bot, { hit: false }, { sightBlocked() { throw new Error('x'); } }, player);
  assert.equal(r.blocked, false);
});

test('patched OkAdunfX.js still parses (ES module)', () => {
  for (const d of JS) {
    execFileSync(process.execPath, ['--input-type=module', '--check'], {
      input: fs.readFileSync(path.join(root, d, FILE)),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
});
