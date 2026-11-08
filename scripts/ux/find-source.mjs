// Reverse lookup: which dictionary keys currently render as English containing a phrase.
// Usage: node scripts/ux/find-source.mjs "Empty Search" "No VPN" ...
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTranslator } from "./translator-harness.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const t = await loadTranslator(path.join(ROOT, "app", "main.js"));
const all = Object.keys(t.dictionary).map((k) => [k, t.translateText(k)]);
for (const q of process.argv.slice(2)) {
  const ql = q.toLowerCase();
  const hits = all.filter(([, v]) => typeof v === "string" && v.toLowerCase().includes(ql));
  console.log(`== ${q} (${hits.length})`);
  for (const [k, v] of hits.slice(0, 25)) console.log(`  ${JSON.stringify(k)} -> ${JSON.stringify(v)}`);
}
