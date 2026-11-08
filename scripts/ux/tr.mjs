// Translate source strings with the current translator (main.js wrapper + fixes).
// Usage: node scripts/ux/tr.mjs "继续" "本局" ...   (or --stdin, one source per line)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTranslator } from "./translator-harness.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const t = await loadTranslator(path.join(ROOT, "app", "main.js"));
let srcs = process.argv.slice(2);
if (srcs[0] === "--stdin") srcs = fs.readFileSync(0, "utf-8").split(/\r?\n/).filter(Boolean);
for (const s of srcs) console.log(`${JSON.stringify(s)} -> ${JSON.stringify(t.translateText(s))}${Object.hasOwn(t.dictionary, s) ? "" : "  (not a key)"}`);
