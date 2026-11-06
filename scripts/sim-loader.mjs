// Node module hooks that let the game's sim (app/mods/next/js/CnrSARj_.js and its imports) load
// headless, for scripts/test-round-sim.mjs. Absolute site paths ("/aim-rounds/…") resolve to
// app/mods, then site/; relative chunk imports fall back to app/mods/next/js, then the game files
// in site/. The app shell chunk (index.uPZ7wDgX.js: Vue, DOM, chat) is replaced by inert stubs for
// exactly the names its importer asks for; the sim code paths never call them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = path.join(ROOT, 'app', 'mods');
const SITE = path.join(ROOT, 'site');
const SHELL = 'index.uPZ7wDgX.js';
const STUB = 'const S=new Proxy(function(){},{get(t,k){if(k===Symbol.toPrimitive)return()=>0;if(k==="then")return undefined;return S},apply(){return S},construct(){return S}});';

export async function resolve(spec, ctx, next) {
  if (spec === '/local/map-registry.mjs') {
    return { url: 'data:text/javascript,export const maps=[];export const mapIds=["ascent"];export const mapById=()=>null;', shortCircuit: true };
  }
  if (spec.endsWith(SHELL) && ctx.parentURL?.startsWith('file:')) {
    const src = fs.readFileSync(fileURLToPath(ctx.parentURL), 'utf-8');
    const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']\\./${SHELL.replace('.', '\\.')}["']`).exec(src);
    const names = m ? m[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
    const body = STUB + names.map((n, i) => `const _${i}=S;export{_${i} as ${n}};`).join('');
    return { url: 'data:text/javascript,' + encodeURIComponent(body), shortCircuit: true };
  }
  if (spec.startsWith('/')) {
    const p = fs.existsSync(path.join(MODS, spec)) ? path.join(MODS, spec) : path.join(SITE, spec);
    return { url: pathToFileURL(p).href, shortCircuit: true };
  }
  if (spec.startsWith('./') && ctx.parentURL?.startsWith('file:')) {
    const dir = path.dirname(fileURLToPath(ctx.parentURL));
    const hit = [dir, path.join(MODS, 'next', 'js'), path.join(SITE, 'next', 'js'), path.join(SITE, '_assets', 'r20261021-1', 'next', 'js')]
      .map((d) => path.join(d, spec)).find((c) => fs.existsSync(c));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  // The game's chunks are ES modules with a .js name and no package.json "type" next to them.
  if (url.startsWith('file:') && url.endsWith('.js')) {
    const r = await next(url, { ...ctx, format: 'module' });
    return { ...r, format: 'module' };
  }
  return next(url, ctx);
}
