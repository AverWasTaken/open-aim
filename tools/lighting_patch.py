"""Add the "Map lighting" option (Enhanced / Original) to the patched three.js bundle in mods/.

The mods copy of BiMsX6Xn.js has hand edits that tools/perf_patch.py does not make, so
this script edits the mods copies in place (both paths, kept byte-identical) instead of
regenerating them from site/. Run it once on an unpatched mods bundle:

    python -I tools/lighting_patch.py

Map surfaces are unlit materials with baked lightmaps, so scene lights do not change them.
What "Enhanced" changes (colour changes on real maps only; the training range keeps
today's colours):
  * tone mapping: ACES Filmic (as before) followed by a saturation boost and a soft S-curve
    contrast, inside three's CustomToneMapping shader function (no extra pass);
  * more exposure, so walls stop looking grey and dim;
  * baked light pulled partly toward neutral (lmChroma), so a map's lighting tint (lilac on
    Ascent, brown on Bind) stops washing over every texture; texture colours are kept;
  * 4x anisotropic texture filtering (clamped to the GPU max), so floors and walls stay
    sharp at grazing angles (all mipmapped textures, range included). It is set when a
    texture is uploaded; apply() also updates the textures already on the GPU.
Measured cost (RTX-class GPU, 2560x1440, Bind pre-round view): the colour changes are within
FPS noise (~1%); anisotropy about 5%.
"Original" uses ACES, exposure 1, lmScale 1, untouched baked light and the textures' own
anisotropy (the game never sets it, so 1): the same pixels as before this patch.

The choice lives in localStorage["aim-map-lighting"] ("enhanced" | "original"; absent =
enhanced). app/lighting-settings.js shows it in Settings > Video and calls
window.__aimMapLighting.apply() so it switches live.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODS = os.path.join(HERE, "..", "app", "mods")
if len(sys.argv) > 2 and sys.argv[1] == "--mods":  # testing: patch another copy
    MODS = sys.argv[2]
BUNDLES = [os.path.join("next", "js", "BiMsX6Xn.js"), os.path.join("_assets", "r20261021-1", "next", "js", "BiMsX6Xn.js")]
MARKER = b"__aimMapLighting"

# Enhanced look. sat: 1 = unchanged colour; contrast: 0..1 blend toward a smoothstep S-curve
# in sqrt (roughly perceptual) space; exposure multiplies scene light before ACES;
# lmScale multiplies the baked lightmaps; lmChroma: 1 = baked light keeps its colour,
# lower pulls it toward grey; aniso: anisotropic filtering level.
LOOK = {"sat": "1.2", "contrast": ".25", "exposure": "1.35", "lmScale": "1", "lmChroma": ".6", "aniso": "4"}
LOOK_JS = b"{" + b",".join(k.encode() + b":" + v.encode() for k, v in LOOK.items()) + b"}"

STATE = (
    b"const aimLt={renderer:null,map:!1,grade:[1,0,0,0],aniso:1,look:" + LOOK_JS + b","
    b"enhanced(){try{return localStorage.getItem(\"aim-map-lighting\")!==\"original\"}catch{return!0}},"
    b"sync(){const e=this.enhanced(),l=this.look,m=e&&this.map;this.aniso=e?l.aniso:1;"
    b"this.grade[0]=m?l.sat:1;this.grade[1]=m?l.contrast:0;return m},"
    b"apply(){const m=this.sync(),l=this.look,n=this.renderer;"
    b"Gu.lmScale.value=m?l.lmScale:1;Gu.lmChroma.value=m?l.lmChroma:1;"
    b"n&&(n.toneMapping=this.map?m?Lm:FA:Qn,n.toneMappingExposure=this.map?m?l.exposure:oL:1,this.refilter())},"
    # Textures that went through the anisotropy code, so a live switch can update the ones
    # already on the GPU. Held weakly ({w: WeakRef(texture), g: gl context, L: GL target});
    # entries go once the texture is collected or its GPU texture is gone. Render-target
    # textures are skipped (three frees them without a dispose event on the texture).
    b"seen:new Set,ref:new WeakMap,"
    b"track(t,g,L){if(t.isRenderTargetTexture)return;let e=this.ref.get(t);"
    b"e||(e={w:new WeakRef(t)},this.ref.set(t,e),this.seen.add(e)),e.g=g,e.L=L},"
    b"refilter(){const n=this.renderer,g=n.getContext();"
    b"if(!n.extensions.has(\"EXT_texture_filter_anisotropic\"))return;"
    b"const x=n.extensions.get(\"EXT_texture_filter_anisotropic\"),mx=n.capabilities.getMaxAnisotropy();"
    b"for(const e of this.seen){const t=e.w.deref();if(!t){this.seen.delete(e);continue}if(e.g!==g)continue;"
    b"const p=n.properties.get(t),w=p.__webglTexture,a=Math.max(t.anisotropy,this.aniso);"
    b"if(!w){this.seen.delete(e),this.ref.delete(t);continue}"
    b"if(!(a>1||p.__currentAnisotropy)||p.__currentAnisotropy===a)continue;"
    b"n.state.bindTexture(e.L,w),g.texParameterf(e.L,x.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(a,mx)),p.__currentAnisotropy=a}}};"
    b"aimLt.sync(),globalThis.__aimMapLighting=aimLt;"
)

# Anchors use LF; the file is converted to LF before patching.
PATCHES = [
    # Remember the renderer and whether a real map is loaded; set tone mapping per the setting.
    (b"const oL=1;function cL(n,e){n.toneMapping=e?FA:Qn,n.toneMappingExposure=e?oL:1}",
     b"const oL=1;" + STATE + b"function cL(n,e){aimLt.renderer=n,aimLt.map=e,aimLt.apply()}"),
    # Enhanced tone mapping: ACES, then saturation and a soft S-curve (aimGrade = sat, contrast).
    (b"vec3 CustomToneMapping( vec3 color ) { return color; }",
     b"uniform vec4 aimGrade;\n"
     b"vec3 CustomToneMapping( vec3 color ) {\n"
     b"\tcolor = ACESFilmicToneMapping( color );\n"
     b"\tfloat aimL = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );\n"
     b"\tvec3 aimP = sqrt( clamp( mix( vec3( aimL ), color, aimGrade.x ), 0.0, 1.0 ) );\n"
     b"\taimP = mix( aimP, aimP * aimP * ( 3.0 - 2.0 * aimP ), aimGrade.y );\n"
     b"\treturn aimP * aimP;\n"
     b"}"),
    # Upload aimGrade next to toneMappingExposure (a no-op for programs that do not use it).
    (b'dt.setValue(k,"toneMappingExposure",w.toneMappingExposure)',
     b'dt.setValue(k,"toneMappingExposure",w.toneMappingExposure),dt.setValue(k,"aimGrade",aimLt.grade)'),
    # Baked-light tint control: shared uniform like lmScale; at 1 the shader skips it.
    (b"lmUseSH:{value:1},lmPerm:", b"lmUseSH:{value:1},lmChroma:{value:1},lmPerm:"),
    (b"n.uniforms.lmUseSH=Gu.lmUseSH,", b"n.uniforms.lmUseSH=Gu.lmUseSH,n.uniforms.lmChroma=Gu.lmChroma,"),
    (b"uniform float lmUseSH;\nuniform mat3 lmPerm;", b"uniform float lmUseSH;\nuniform float lmChroma;\nuniform mat3 lmPerm;"),
    (b"\t\tvec3 lmLight = lmIrrV * dirf * lmScale;`;function xv(",
     b"\t\tvec3 lmLight = lmIrrV * dirf * lmScale;\n"
     b"\t\tif ( lmChroma != 1.0 ) lmLight = mix( vec3( dot( lmLight, vec3( 0.2126, 0.7152, 0.0722 ) ) ), lmLight, lmChroma );"
     b"`;function xv("),
    # Anisotropic filtering floor for mipmapped textures (aimLt.aniso is 1 for Original).
    (b'if(x.anisotropy>1||i.get(x).__currentAnisotropy){const z=e.get("EXT_texture_filter_anisotropic");'
     b'n.texParameterf(L,z.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(x.anisotropy,r.getMaxAnisotropy())),'
     b'i.get(x).__currentAnisotropy=x.anisotropy}',
     b'{aimLt.track(x,n,L);const aA=Math.max(x.anisotropy,aimLt.aniso);if(aA>1||i.get(x).__currentAnisotropy){const z=e.get("EXT_texture_filter_anisotropic");'
     b'n.texParameterf(L,z.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(aA,r.getMaxAnisotropy())),'
     b'i.get(x).__currentAnisotropy=aA}}'),
]

paths = [os.path.join(MODS, rel) for rel in BUNDLES]
raw = open(paths[0], "rb").read()
for p in paths[1:]:
    if open(p, "rb").read() != raw:
        raise SystemExit(f"{p} differs from {paths[0]}; make the copies identical first")
# Windows checkouts get CRLF (.gitattributes text=auto); patch in LF and convert back.
crlf = b"\r\n" in raw
data = raw.replace(b"\r\n", b"\n")
if MARKER in data:
    raise SystemExit("already patched (found __aimMapLighting)")
for old, new in PATCHES:
    if data.count(old) != 1:
        raise SystemExit(f"expected exactly one match for {old[:50]!r}, found {data.count(old)}")
    data = data.replace(old, new)
if crlf:
    data = data.replace(b"\n", b"\r\n")
for p in paths:
    with open(p, "wb") as f:
        f.write(data)
    print("patched", p)
