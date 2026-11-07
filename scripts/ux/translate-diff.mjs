// Before/after diff of every English string the translator produces.
// Usage (from the repo root):
//   node scripts/ux/translate-diff.mjs [--base team/ux] [--extra <tsv>] [--out <file>]
// "before" = app/main.js + english-fixes.js + translations.js at --base (git);
// "after"  = the working tree. Sources = every dictionary key (before and after) plus
// column 2 of each --extra TSV (e.g. the ux audit's translation-unfixed.tsv).
// Writes only the strings whose English changed, plus counts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadTranslator } from "./translator-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const base = opt("--base", "team/ux");
const out = opt("--out", path.join(os.tmpdir(), "translate-diff.txt"));
const extras = args.flatMap((a, i) => (a === "--extra" ? [args[i + 1]] : []));

const beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-before-"));
for (const f of ["main.js", "english-fixes.js", "translations.js"]) {
  const text = execFileSync("git", ["show", `${base}:app/${f}`], { cwd: ROOT, encoding: "utf-8", maxBuffer: 1 << 26 });
  fs.writeFileSync(path.join(beforeDir, f), text);
}
const before = await loadTranslator(path.join(beforeDir, "main.js"));
const after = await loadTranslator(path.join(ROOT, "app", "main.js"));

const sources = new Set([...Object.keys(before.dictionary), ...Object.keys(after.dictionary)]);
for (const file of extras) {
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const col = line.split("\t")[1];
    if (col) sources.add(col);
  }
}
const changed = [];
for (const s of sources) {
  const b = before.translateText(s), a = after.translateText(s);
  if (a !== b) changed.push([s, b, a]);
}
const lines = [
  `translate-diff: base ${base} vs working tree`,
  `sources checked: ${sources.size}; changed: ${changed.length}`,
  "",
];
for (const [s, b, a] of changed) lines.push(`SRC  ${s}`, `OLD  ${b}`, `NEW  ${a}`, "");
fs.writeFileSync(out, lines.join("\n"));
console.log(`checked ${sources.size}, changed ${changed.length} -> ${out}`);
