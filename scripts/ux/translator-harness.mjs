// Loads the English translator exactly as app/main.js serves it, in node.
// main.js builds the translator module from the TRANSLATOR_WRAPPER template literal;
// this evaluates that template (with english-fixes.js / translations.js next to the
// given main.js), points its imports at the site's dictionary and translator, and
// imports it. Each load gets its own copy of the dictionary (query-string import),
// so several versions can be compared in one process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const I18N = path.join(ROOT, "site", "_assets", "r20261021-1", "i18n");
let loads = 0;

export function wrapperSource(mainJsPath, env = {}) {
  const text = fs.readFileSync(mainJsPath, "utf-8");
  const start = text.indexOf("const TRANSLATOR_WRAPPER = `");
  if (start < 0) throw new Error("TRANSLATOR_WRAPPER not found in " + mainJsPath);
  const bodyStart = text.indexOf("`", start) + 1;
  const end = text.indexOf("\n`;", bodyStart);
  const body = text.slice(bodyStart, end + 1);
  const req = createRequire(mainJsPath);
  // Same semantics as node evaluating main.js: a template literal with require/process in scope.
  return new Function("require", "process", "return `" + body + "`;")(req, { env });
}

export async function loadTranslator(mainJsPath, env = {}) {
  const tag = `h${process.pid}-${++loads}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aim-tr-"));
  const dictUrl = pathToFileURL(path.join(I18N, "en.dict.mjs")).href + "?v=" + tag;
  const cacheUrl = pathToFileURL(path.join(I18N, "translation-cache.mjs")).href;
  const original = fs.readFileSync(path.join(I18N, "translate-en.mjs"), "utf-8")
    .replaceAll("'./en.dict.mjs'", JSON.stringify(dictUrl))
    .replaceAll("'./translation-cache.mjs'", JSON.stringify(cacheUrl));
  const originalPath = path.join(dir, "translate-en.original.mjs");
  fs.writeFileSync(originalPath, original);
  const wrapper = wrapperSource(mainJsPath, env)
    .replaceAll("'./en.dict.mjs'", JSON.stringify(dictUrl))
    .replaceAll("'./translate-en.original.mjs'", JSON.stringify(pathToFileURL(originalPath).href));
  const wrapperPath = path.join(dir, "translate-en.mjs");
  fs.writeFileSync(wrapperPath, wrapper);
  globalThis.window ??= {};
  const mod = await import(pathToFileURL(wrapperPath).href);
  const dictionary = (await import(dictUrl)).default;
  return { translateText: mod.translateText, localizeMetadata: mod.localizeMetadata, dictionary, wrapper, dir };
}
