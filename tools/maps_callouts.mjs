// Real VALORANT callout names on every map: writes app/mods/aim-maps/<map>.minimap.json with the
// callout names replaced by Riot's in-game English names (tools/maps-callouts-en.json).
//
//   node tools/maps_callouts.mjs           write the files
//   node tools/maps_callouts.mjs --check   exit 1 if any file is missing or out of date (writes nothing)
//
// The site maps (site/aim-maps/<map>.minimap.json, Chinese names) are the source: the output is the
// source text with only each callouts[i].name token swapped, so every other byte (key order, number
// formatting, no trailing newline) stays the same. The data must list the same names in the same
// order as the source file, or the script stops. juliett (Sunset) only exists in app/mods/aim-maps;
// its names are rewritten in place, each index may hold the Chinese or the English name (so it can
// re-run), and its x/z must equal the values kept in the data file.
// app/mods overrides site/ at the same URL, so the game loads these files instead of the originals.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'maps-callouts-en.json'), 'utf8'));
export const SITE_MAPS = ['ascent', 'bonsai', 'duality', 'infinity', 'jam', 'plummet', 'rook', 'triad'];
export const MODS_ONLY_MAPS = ['juliett'];
export const MAPS = [...SITE_MAPS, ...MODS_ONLY_MAPS];

const fail = (msg) => { throw new Error(`maps_callouts: ${msg}`); };
const count = (text, token) => text.split(token).length - 1;

// Swap the name tokens in order: callouts[i] currently named from[i] becomes to[i].
function swapNames(map, src, from, to) {
  const parsed = JSON.parse(src);
  for (const name of new Set(from)) {
    const token = `"name":${JSON.stringify(name)}`;
    const want = from.filter((n) => n === name).length;
    if (count(src, token) !== want) fail(`${map}: expected ${want}x ${token}, found ${count(src, token)}`);
  }
  let out = '', cursor = 0;
  from.forEach((name, i) => {
    const token = `"name":${JSON.stringify(name)}`;
    const at = src.indexOf(token, cursor);
    if (at < 0) fail(`${map}: callout ${i} ${token} not found in order`);
    out += src.slice(cursor, at) + `"name":${JSON.stringify(to[i])}`;
    cursor = at + token.length;
  });
  out += src.slice(cursor);
  // Everything except the names must be unchanged.
  const result = JSON.parse(out);
  const expect = structuredClone(parsed);
  expect.callouts.forEach((c, i) => { c.name = to[i]; });
  if (!isDeepStrictEqual(result, expect)) fail(`${map}: output differs from the source beyond callout names`);
  return out;
}

export function build(map) {
  const data = DATA[map];
  if (!Array.isArray(data)) fail(`${map}: no data`);
  const outPath = path.join(ROOT, 'app', 'mods', 'aim-maps', `${map}.minimap.json`);
  const srcPath = SITE_MAPS.includes(map) ? path.join(ROOT, 'site', 'aim-maps', `${map}.minimap.json`) : outPath;
  const src = fs.readFileSync(srcPath, 'utf8');
  const callouts = JSON.parse(src).callouts;
  if (!Array.isArray(callouts) || callouts.length !== data.length) fail(`${map}: ${callouts?.length} callouts, data has ${data.length}`);
  const from = callouts.map((c, i) => {
    const d = data[i];
    if (SITE_MAPS.includes(map)) {
      if (c.name !== d.zh) fail(`${map}: callout ${i} is ${JSON.stringify(c.name)}, data says ${JSON.stringify(d.zh)}`);
    } else {
      if (c.name !== d.zh && c.name !== d.en) fail(`${map}: callout ${i} is ${JSON.stringify(c.name)}, data says ${JSON.stringify(d.zh)} / ${JSON.stringify(d.en)}`);
      if (c.x !== d.x || c.z !== d.z) fail(`${map}: callout ${i} at ${c.x},${c.z}, data says ${d.x},${d.z}`);
    }
    return c.name;
  });
  return { outPath, text: swapNames(map, src, from, data.map((d) => d.en)) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes('--check');
  let stale = 0;
  try {
    for (const map of MAPS) {
      const { outPath, text } = build(map);
      const rel = path.relative(ROOT, outPath).split(path.sep).join('/');
      const cur = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
      if (cur === text) { console.log(`ok      ${rel}`); continue; }
      if (check) { console.log(`STALE   ${rel}`); stale++; continue; }
      fs.writeFileSync(outPath, text);
      console.log(`wrote   ${rel}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (stale) { console.error(`${stale} file(s) out of date: run node tools/maps_callouts.mjs`); process.exit(1); }
}
