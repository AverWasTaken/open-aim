"""Audio buses, soft clipper and hooks for app/feel-audio.js in the play page script (OkAdunfX.js).

Edits the mods copies in place (both paths, kept byte-identical), like tools/round_patch.py. Run it
after round_patch.py (order in tools/README.md):

    python -I tools/feel_audio_patch.py
    python -I tools/feel_audio_patch.py --mods <dir>   # testing: patch another copy of app/mods

Refuses to run twice (marker __aimAudioBuild). Every anchor's count is checked before anything is
written. Render side only: no sim change, nothing in the replay. With window.__aimAudioMix absent
(app/feel-audio.js not loaded) every sound plays as before, except that it now goes
source -> category bus (gain 1) -> master (volume) -> soft clipper -> speakers. The clipper is the
identity for |x| <= 0.8, so normal levels are unchanged.

What the engine (class qp) provides:
- engine.bus = {weapon, enemy, steps, hits, ui}: GainNodes (gain 1) into engine.master, built when
  the AudioContext is created in ensure(). dispose() sets bus to null.
- master -> pre gain 0.5 -> WaveShaper (4097-point curve, oversample "none") -> post gain 2 ->
  destination. Transfer y = x for |x| <= 0.8, y = sign(x) * (0.8 + 0.2 * tanh((|x| - 0.8) / 0.2))
  above (slope 1 at the knee, 0.99999 at |x| = 2, inputs beyond 2 held at the curve end). The curve
  covers +-2 instead of the shaper's native +-1 so loud stacks get the knee, not a hard edge at 1.
  Curve builder: __aimClipCurve(n, headroom) (tail of the file; scripts/test-feel-audio-patch.cjs
  extracts and checks it).
- ensure() returns {context, master, bus}.
- window.__aimAudio = the engine, set when its AudioContext is created; dispose() clears it again
  when it still points at that engine (addition to the contract: a closed engine is never left
  there).
- window.__aimAudioEngine = qp (the class; constructor takes {current: settings}).
- window.__aimStepBuffers() -> {step: AudioBuffer[], land: AudioBuffer[]} once the step samples are
  decoded (starts decoding on an OfflineAudioContext if nothing started it yet), else null.
- Routing (each falls back to master when bus is missing):
  weapon: playFire (skin fire + built-in fire), playJam;
  enemy:  playEnemyFire (see below), playHurt, flash sounds (both Kp call sites);
  hits:   playHit (hit and kill ding), playGridTargetSound, playSkinKill, the dead kill-kit path;
  steps:  playFootstep, playLanding.
  ui: nothing in the bundle (round beeps / sound check live in shell scripts).
- playEnemyFire(distance, weapon = null, sp = null): the per-shot gain node `o` (distance law
  jp(d) = .7 / (1 + d / 14), unchanged) connects to
  (sp && __aimAudioMix.enemyDest(ensureResult, sp)) || bus.enemy || master.
  Both the bot weapon sample path and the fallback synth play into `o`, so they share that
  destination. The bundle disconnects `o` after 2 s as before.

What the play page calls (all optional chaining; a missing function or a falsy result means the old
behaviour):
- __aimAudioMix.attach(engine) once per new AudioContext (inside ensure()).
  attach() and frame() go through __aimAudioMixCall (tail of the file), which catches anything they
  throw (one console warning per page) so a shell bug can't stop ensure() or the render frame.
  cue(), spatialOn() and enemyDest() are called directly (optional chaining); the shell must not let
  them throw.
- enemy shot: re.playEnemyFire(he.distance, <weapon, unchanged>,
  Be && __aimAudioMix.spatialOn() ? {id, x, y, z, blocked} : null)
  x, y, z = muzzle = Be.position + Be.offset, y + 1.45 (same as the tracer origin).
  blocked = he.wall !== undefined || (!he.hit && de.sightBlocked(muzzle, eye)),
  eye = player position, y + 1.5 * (1 - .3 * crouchAmount) (the tracer's head target).
  sightBlocked only runs when spatialOn() is true.
- headshot = some pellet (or the shot) with hitActorId !== null && hitPart === "head" that is not a
  grid target dot.
- plain hit (no kill this step, not dot-only):
    (headshot && __aimAudioMix.cue(engine, "headshot", true)) || re.playHit()
- kill (not dot-only):
    headshot && __aimAudioMix.cue(engine, "headshot", true);      // layered dink, result ignored
    re.playKill(...) || __aimAudioMix.cue(engine, "kill", headshot) || re.playHit(true)
  So the shell's "kill" cue must NOT play the dink itself (the bundle already asked for it).
- dot-only kill: re.playKill(...) only, as before (no cue).
- every frame, right before the flash audio frame (and also when there is no flash audio):
  __aimAudioMix.frame(engine, camera.matrixWorld.elements, snapshot, timeSec, dotTemplateSet)

Notes for the shell (app/feel-audio.js):
- cue("headshot", ...) is only called for headshots (the third argument is always true there).
- The -4 dB for a blocked shot is not applied in the bundle: enemyDest() gets sp.blocked and does
  it (per-shot gain); the bundle only disconnects its own node `o` after 2 s.
- playSkinKill now gets bus.hits as its destination (Prime Guardian kill sample included), while
  playSkinFire gets bus.weapon. app/local-customization.js caches guardianBus() by destination, so
  its warm-up for "kill" should use bus.hits.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
MODS = os.path.join(ROOT, "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
DIRS = [os.path.join("next", "js"), os.path.join("_assets", "r20261021-1", "next", "js")]

MARKER = b"__aimAudioBuild"

# (old, new, expected count). Every occurrence of `old` is replaced.
OKA = [
    # --- engine (class qp) ---
    # Step buffers for bot footsteps.
    (b"const Vl={step:-1,land:-1};",
     b"const Vl={step:-1,land:-1};typeof window<\"u\"&&(window.__aimStepBuffers=()=>(Wl(),cr));", 1),
    # Field.
    (b"context=null;master=null;", b"context=null;master=null;bus=null;", 1),
    # New context: buses + clipper, publish the engine, tell the shell.
    (b"this.context=new AudioContext,this.master=this.context.createGain(),this.master.connect(this.context.destination)",
     b"this.context=new AudioContext,this.master=this.context.createGain(),__aimAudioBuild(this),"
     b"window.__aimAudio=this,__aimAudioMixCall(\"attach\",this)", 1),
    (b"{context:this.context,master:n}}", b"{context:this.context,master:n,bus:this.bus}}", 1),
    # Routing.
    (b"playSkinFire(n.context,n.master,", b"playSkinFire(n.context,n.bus?.weapon??n.master,", 1),
    (b"this.fire(n.context,n.master,", b"this.fire(n.context,n.bus?.weapon??n.master,", 1),
    (b"playEnemyFire(t,n=null){", b"playEnemyFire(t,n=null,sp=null){", 1),
    (b"o.connect(s.master),", b"o.connect((sp&&window.__aimAudioMix?.enemyDest?.(s,sp))||s.bus?.enemy||s.master),", 1),
    (b"__aimPlayGridTarget(a.context,a.master)", b"__aimPlayGridTarget(a.context,a.bus?.hits??a.master)", 1),
    (b"P0(t.context,t.master,", b"P0(t.context,t.bus?.enemy??t.master,", 1),
    (b"D0(a.context,a.master,", b"D0(a.context,a.bus?.hits??a.master,", 1),
    (b"playSkinKill(local.context,local.master,", b"playSkinKill(local.context,local.bus?.hits??local.master,", 1),
    (b"O0(a.context,a.master,", b"O0(a.context,a.bus?.hits??a.master,", 1),
    (b'Gl(t.context,t.master,"step",', b'Gl(t.context,t.bus?.steps??t.master,"step",', 1),
    (b'Gl(t.context,t.master,"land",', b'Gl(t.context,t.bus?.steps??t.master,"land",', 1),
    (b"U0(t.context,t.master,", b"U0(t.context,t.bus?.weapon??t.master,", 1),
    # Flash sounds (Kp, two call sites of its input builder).
    (b"y=u(E,C.master)", b"y=u(E,C.bus?.enemy??C.master)", 2),
    # dispose().
    (b"this.context=null,this.master=null}}const Zp=32.5,Qp=1.05",
     b"this.context=null,this.master=null,this.bus=null,typeof window<\"u\"&&window.__aimAudio===this&&(window.__aimAudio=null)}}"
     b"typeof window<\"u\"&&(window.__aimAudioEngine=qp);const Zp=32.5,Qp=1.05", 1),
    # --- play page event loop ---
    # Enemy shot: spatial info for the shell.
    (b're.playEnemyFire(he.distance,yo.get(Be?.templateId??"")??"vandal"),',
     b're.playEnemyFire(he.distance,yo.get(Be?.templateId??"")??"vandal",'
     b"Be&&window.__aimAudioMix?.spatialOn?.()?__aimEnemySpatial(Be,he,de,Ae.player):null),", 1),
    # Headshot flag for the player's shot.
    (b"if(__aimDotHit)re.playGridTargetSound?.();",
     b"if(__aimDotHit)re.playGridTargetSound?.();const __aimHS=(he.pellets??[he]).some(__aimP=>__aimP.hitActorId!==null&&"
     b"__aimP.hitPart===\"head\"&&!__aimIsGridTargetActor(__aimP.hitActorId,Ae.actors,__aimDotTemplates));", 1),
    # Kill: layered dink, then skin kill sample || synth kill cue || old kill ding.
    (b"__aimDotOnly?re.playKill?.(ge,Ae.player.weapon??Ye()):(re.playKill?.(ge,Ae.player.weapon??Ye())||re.playHit(!0))),Qn=0,",
     b"__aimDotOnly?re.playKill?.(ge,Ae.player.weapon??Ye()):(__aimHS&&window.__aimAudioMix?.cue?.(re,\"headshot\",!0),"
     b"re.playKill?.(ge,Ae.player.weapon??Ye())||window.__aimAudioMix?.cue?.(re,\"kill\",__aimHS)||re.playHit(!0))),Qn=0,", 1),
    # Plain hit: dink instead of the ding on a headshot (when the shell says so).
    (b"}else he.hitActorId!==null&&!__aimDotOnly&&re.playHit();",
     b"}else he.hitActorId!==null&&!__aimDotOnly&&(__aimHS&&window.__aimAudioMix?.cue?.(re,\"headshot\",!0)||re.playHit());", 1),
    # Every frame: listener / bot footsteps in the shell (also when there is no flash audio).
    (b",re.flash){const xe=r.camera.matrixWorld.elements;re.flash.frame(",
     b",__aimAudioMixCall(\"frame\",re,r.camera.matrixWorld.elements,ce,Fe,__aimDotTemplates),"
     b"re.flash){const xe=r.camera.matrixWorld.elements;re.flash.frame(", 1),
]

OKA_TAIL = b"""
function __aimClipCurve(n,h){const c=new Float32Array(n);for(let i=0;i<n;i++){const u=(i*2/(n-1)-1)*h,a=Math.abs(u),y=a<=.8?a:.8+.2*Math.tanh((a-.8)/.2);c[i]=(u<0?-y:y)/h}return c}
function __aimAudioBuild(e){const c=e.context,m=e.master,p=c.createGain(),w=c.createWaveShaper(),q=c.createGain();p.gain.value=.5,w.curve=__aimClipCurve(4097,2),w.oversample="none",q.gain.value=2,m.connect(p).connect(w).connect(q).connect(c.destination);const b={};for(const k of["weapon","enemy","steps","hits","ui"]){const g=c.createGain();g.connect(m),b[k]=g}e.bus=b}
function __aimAudioMixCall(k,...a){const m=typeof window<"u"?window.__aimAudioMix:void 0;if(!m||typeof m[k]!=="function")return;try{return m[k](...a)}catch(x){__aimAudioMixCall.warned||(__aimAudioMixCall.warned=!0,console.warn("[aim-audio] __aimAudioMix."+k+" failed",x))}}
function __aimEnemySpatial(b,h,d,p){const x=b.position.x+(b.offset?.x??0),y=b.position.y+(b.offset?.y??0)+1.45,z=b.position.z+(b.offset?.z??0);let k=h.wall!==void 0;if(!k&&!h.hit&&p)try{k=!!d.sightBlocked({x,y,z},{x:p.position.x,y:p.position.y+1.5*(1-.3*(p.crouchAmount??0)),z:p.position.z})}catch{k=!1}return{id:b.id,x,y,z,blocked:k}}
"""


def load(name):
    """Both copies of `name` as (paths, raws, LF text); the copies must match apart from line ends."""
    paths = [os.path.join(MODS, d, name) for d in DIRS]
    raws = [open(p, "rb").read() for p in paths]
    text = raws[0].replace(b"\r\n", b"\n")
    for p, r in zip(paths[1:], raws[1:]):
        if r.replace(b"\r\n", b"\n") != text:
            raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
    return paths, raws, text


def apply(name, data, patches, tail=b""):
    for old, new, count in patches:
        found = data.count(old)
        if found != count:
            raise SystemExit(f"{name}: expected {count} match(es) for {old[:70]!r}, found {found}")
        data = data.replace(old, new)
    if tail:
        if not data.endswith(b"\n"):
            data += b"\n"
        data += tail.lstrip(b"\n")
    return data


paths, raws, text = load("OkAdunfX.js")
if MARKER in text:
    raise SystemExit("OkAdunfX.js: already patched (found __aimAudioBuild)")
out = apply("OkAdunfX.js", text, OKA, OKA_TAIL)
for p, raw in zip(paths, raws):
    # Keep each copy's own line ends (git stores LF; .gitattributes text=auto).
    with open(p, "wb") as f:
        f.write(out.replace(b"\n", b"\r\n") if b"\r\n" in raw else out)
    print("patched", p)
