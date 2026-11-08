// Practice scenes: main.js serves /prod-api/.../scenes/practice-<map>-<area>-<weapon>-<bots>-<count>
// as a normal scene doc built here from app/mods/aim-practice/areas.json (tools/practice_areas.mjs).
// No timer (24 h, the validator's maximum), no score pressure, bots that never shoot and come back
// 1.5 s after a kill. rules.practice makes the game skip the replay recorder and the timer chip
// (tools/practice_patch.py). bots: none | static | strafe.
"use strict";
const fs = require("fs");
const path = require("path");

const CODE = /^practice-([a-z0-9]+)-([a-z0-9]+)-([a-z]+)-(none|static|strafe)-(\d{1,2})$/;
const WEAPONS = ["vandal", "phantom", "sheriff", "operator", "spectre", "guardian", "marshal", "outlaw", "odin", "bulldog", "ghost", "classic"];
const AUTO = new Set(["vandal", "phantom", "spectre", "odin", "bulldog", "stinger", "ares"]);
const BOTS = ["none", "static", "strafe"];
const MAX_BOTS = 12;
const BACK_SEC = 1.5;
const MAX_SWING = 1.5; // metres of lane a strafing bot uses at most

function parseCode(code) {
  const m = CODE.exec(String(code || ""));
  if (!m) return null;
  const [, map, area, weapon, bots, n] = m;
  const count = Number(n);
  if (!WEAPONS.includes(weapon) || !BOTS.includes(bots) || count > MAX_BOTS) return null;
  if (bots !== "none" && count < 1) return null;
  return { map, area, weapon, bots, count: bots === "none" ? 0 : count };
}

function hash16(text) {
  let a = 2166136261, b = 2654435761;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
  return ((a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0"));
}

let cache = null; // { file, mtimeMs, data }
function loadAreas(modsDir) {
  const file = path.join(modsDir, "aim-practice", "areas.json");
  try {
    const st = fs.statSync(file);
    if (!cache || cache.file !== file || cache.mtimeMs !== st.mtimeMs) cache = { file, mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, "utf-8")) };
    return cache.data;
  } catch { return null; }
}

const down2 = (v) => Math.floor(v * 100 + 1e-9) / 100; // never past the lane
const r3 = (v) => Math.round(v * 1000) / 1000;

// Strafe setup for a spot with a checked lane [ax,az,min,max] (tools/spot_alts.mjs): the bot's home
// moves to the middle of the lane and it swings +-travel/2 along the lane axis (the game's strafe
// moves along the bot's right vector, set by the spawner's rotationY). Every point it can reach is
// on the checked lane.
function strafeOf(spot) {
  const [ax, az, lo, hi] = spot.lane;
  const span = Math.min(hi - lo, MAX_SWING);
  const mid = (lo + hi) / 2;
  return {
    home: { x: r3(spot.x + ax * mid), y: spot.y, z: r3(spot.z + az * mid) },
    rotationY: r3(Math.atan2(-az, ax)),
    travel: [down2(span * 0.6), down2(span)],
  };
}

function pickSpots(area, opts) {
  if (opts.bots === "none") return [];
  const spots = area.spots; // sorted by distance from the spawn
  const list = opts.bots === "strafe" ? [...spots.filter((s) => s.lane), ...spots.filter((s) => !s.lane)] : spots;
  return list.slice(0, Math.min(opts.count, list.length));
}

function buildDoc(mapEntry, area, opts) {
  const spawners = [];
  const actors = [{
    id: "practice-bot", name: "Bot",
    body: { shape: "humanoid", headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: "bot", weapon: "vandal" },
    color: "#ff4655",
    behaviors: [{ kind: "respawn", delay: [BACK_SEC, BACK_SEC], mode: "inPlace" }],
    hitSlow: true,
  }];
  pickSpots(area, opts).forEach((spot, i) => {
    const id = `practice-${i + 1}`;
    const base = {
      id, name: `Spot ${i + 1}`, kind: "fixed", actorTemplateId: "practice-bot",
      position: { x: spot.x, y: spot.y, z: spot.z }, size: { x: 0, y: 0, z: 0 },
      maxAlive: 1, spawnDelay: [0.3, 0.3], faceTarget: true, groundSnap: spot.snap !== false,
    };
    if (opts.bots === "strafe" && spot.lane) {
      const s = strafeOf(spot);
      const tid = `practice-strafe-${i + 1}`;
      actors.push({
        id: tid, name: `Strafing bot ${i + 1}`,
        body: { shape: "humanoid", headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: "bot", weapon: "vandal" },
        color: "#ff4655",
        behaviors: [
          { kind: "strafe", speed: [3.5, 5.4], dwell: [0.3, 1.0], travel: s.travel, counterStrafe: true },
          // reSpawner: home and strafe state reset every life (app/studio/drill.js does the same).
          { kind: "respawn", delay: [BACK_SEC, BACK_SEC], mode: "reSpawner" },
        ],
        hitSlow: true,
      });
      Object.assign(base, { actorTemplateId: tid, position: s.home, rotationY: s.rotationY });
    }
    spawners.push(base);
  });
  return {
    schemaVersion: 2,
    meta: { id: `practice-${opts.map}-${area.id}`, name: `Practice: ${mapEntry.name} ${area.name}`, seed: 1, createdAt: 0 },
    environment: { ...area.env, map: opts.map },
    blocks: [],
    playerSpawn: { position: { x: area.spawn.x, y: area.spawn.y, z: area.spawn.z }, yaw: area.spawn.yaw },
    spawners,
    actors,
    rules: {
      duration: 86400,
      scoring: "clicking", weapon: opts.weapon, playerMovable: true,
      fireMode: AUTO.has(opts.weapon) ? "hold" : "single",
      buyMenu: false,
      practice: true,
    },
  };
}

// The scene envelope main.js sends for a practice code, or null when the code isn't a valid one.
function practiceScene(modsDir, code) {
  const opts = parseCode(code);
  if (!opts) return null;
  const data = loadAreas(modsDir);
  const mapEntry = data?.maps?.[opts.map];
  const area = mapEntry?.areas?.find((a) => a.id === opts.area);
  if (!area) return null;
  const doc = buildDoc(mapEntry, area, opts);
  const text = JSON.stringify(doc);
  const hash = hash16(text);
  const time = "2026-11-07 12:00:00";
  return {
    authorNickname: "open-aim", authorUid: "local", blockCount: 0, createTime: time,
    description: "No timer. Bots come back 1.5 s after you kill them. Nothing is saved.",
    docBytes: Buffer.byteLength(text), name: `Practice: ${mapEntry.name} ${area.name}`, playCount: 0,
    sceneHash: hash, sceneKey: `set-${hash}`, schemaVersion: 2, shareCode: code, updateTime: time,
    doc: text,
  };
}

module.exports = { practiceScene, parseCode, buildDoc, pickSpots, strafeOf, loadAreas, WEAPONS, BOTS, MAX_BOTS, MAX_SWING };
