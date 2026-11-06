"use strict";
// One card per drill. Many official drills come as two list entries: "简单-<title>" (Easy, no bot
// shoots back) and "困难-<title>" (Hard, bots shoot back). main.js serves only the Hard entry in the
// training list and keeps the Easy one as its "No return fire" variant; the rank picker
// (rank-picker.js) asks which to play. The Easy entries stay playable by code (scene, history,
// replays): the game's own rules read the 简单 prefix of the launched entry's name, so the Easy
// variant is always started as its real list entry, never renamed.

// Same pattern as the game's own title parser (vt in site/next/js/BPUvDycd.js).
const NAME = /^(简单|普通|中等|困难)(?:\s*[-－—·]\s*|\s+)(.+)$/;
const EASY = "简单";
const HARD = "困难";

// Pairs whose titles differ slightly (checked by hand: same map, same route). [Hard, Easy].
// "Haven A Long attack (random)" (935efd2987c64ad4) stays its own card.
const NEAR_PAIRS = [
  ["becafa3cd2560b03", "10d043eea1794c53"], // Abyss B attack / Abyss B site pre-aim
  ["e759f847c60c90e5", "789f9e6dc075e747"], // Lotus A Main attack / Lotus A attack
  ["b69de2b10b5cfc06", "75551c4e540ca4e8"], // Summit B attack (bots shoot) / Summit B attack
  ["afcbc73b0048afcc", "46029355cfd99cf1"], // Haven A Long attack (bots shoot) / Haven A Long attack
];

function parseName(name) {
  const m = NAME.exec(String(name || "").trim());
  return m ? { label: m[1], title: m[2] } : { label: null, title: String(name || "") };
}

// Shooter configs (kind "shooter") anywhere in a parsed scene doc, reduced to what the rank math
// needs (reaction, aimErrorDeg; see aimBotRankOf in tools/bot_patch.py).
function shooterStats(doc) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (o.kind === "shooter") out.push({ reaction: Array.isArray(o.reaction) ? o.reaction.slice(0, 2) : null, aimErrorDeg: o.aimErrorDeg ?? null });
      for (const k in o) walk(o[k]);
    }
  };
  walk(doc);
  return out;
}

// Parses a scene's doc (a JSON string or an object). null when unreadable.
function docOf(scene) {
  try {
    const doc = typeof scene?.doc === "string" ? JSON.parse(scene.doc) : scene?.doc;
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

const newestFirst = (a, b) => String(b.createTime || "").localeCompare(String(a.createTime || ""));

// items: the full training list (Studio drills included). botsOf(item): its shooter stats (array).
// skip: codes never paired (the player's Studio drills).
// Returns { data, variants, hidden }:
//  data: the list without the Easy twins and the older copies of a published-twice pair;
//  variants: code -> { code, title, item, easy, bots } for every drill that has bots or a twin,
//   keyed by the card's code, its Easy twin's code and any hidden older copy's code;
//  hidden: the codes left out of data.
function mergeVariants(items, botsOf, skip = new Set()) {
  const info = new Map();
  for (const item of items) {
    if (!item || typeof item.shareCode !== "string") continue;
    const n = parseName(item.name);
    info.set(item.shareCode, { item, label: skip.has(item.shareCode) ? null : n.label, title: n.title, bots: null });
  }
  const bots = (code) => {
    const x = info.get(code);
    if (x.bots === null) x.bots = botsOf(x.item) || [];
    return x.bots;
  };
  const variants = {};
  const hidden = new Set();
  const used = new Set();
  const pair = (hardCode, easyCode, older) => {
    const h = info.get(hardCode);
    const group = { code: hardCode, title: h.title, item: h.item, easy: info.get(easyCode).item, bots: bots(hardCode) };
    for (const c of [hardCode, easyCode, ...older]) {
      variants[c] = group;
      used.add(c);
    }
    for (const c of [easyCode, ...older]) hidden.add(c);
  };

  // Exact pairs: same title (case ignored) and map, one Hard and one Easy entry.
  const groups = new Map();
  for (const [code, x] of info) {
    if (x.label !== EASY && x.label !== HARD) continue;
    const key = x.title.trim().toLowerCase() + "|" + (x.item.mapId ?? "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(code);
  }
  for (const codes of groups.values()) {
    const hard = codes.filter((c) => info.get(c).label === HARD).map((c) => info.get(c).item).sort(newestFirst);
    const easy = codes.filter((c) => info.get(c).label === EASY).map((c) => info.get(c).item).sort(newestFirst);
    if (!hard.length || !easy.length || !bots(hard[0].shareCode).length) continue;
    // A pair published twice: the newest pair is kept, the older copies are hidden.
    pair(hard[0].shareCode, easy[0].shareCode, [...hard.slice(1), ...easy.slice(1)].map((x) => x.shareCode));
  }

  for (const [hardCode, easyCode] of NEAR_PAIRS) {
    const h = info.get(hardCode);
    const e = info.get(easyCode);
    if (!h || !e || used.has(hardCode) || used.has(easyCode)) continue;
    if (h.label !== HARD || e.label !== EASY || (h.item.mapId ?? null) !== (e.item.mapId ?? null) || !bots(hardCode).length) continue;
    pair(hardCode, easyCode, []);
  }

  // Every other drill whose bots shoot back gets the rank picker without a "No return fire" choice.
  for (const [code, x] of info) {
    if (used.has(code)) continue;
    const b = bots(code);
    if (b.length) variants[code] = { code, title: x.title, item: x.item, easy: null, bots: b };
  }

  return { data: items.filter((x) => !hidden.has(x?.shareCode)), variants, hidden: [...hidden] };
}

module.exports = { parseName, shooterStats, docOf, mergeVariants, NEAR_PAIRS };
