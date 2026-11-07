// Round mode scenes: main.js serves /prod-api/.../scenes/round-<map>-<side>-<weapon>-<barrierSec>
// as a normal scene doc built here from app/mods/aim-rounds/<map>.json (tools/round_author.mjs).
// The doc carries rules.round (read by the sim through app/mods/aim-rounds/round-core.mjs).
"use strict";
const fs = require("fs");
const path = require("path");

const CODE = /^round-([a-z0-9]+)-(attack|defense)-([a-z]+)-(\d{1,2})$/;
const WEAPONS = ["vandal", "phantom", "sheriff", "operator", "spectre", "guardian", "marshal", "outlaw", "odin", "bulldog", "ghost", "classic"];
const AUTO = new Set(["vandal", "phantom", "spectre", "odin", "bulldog", "stinger", "ares"]);
const BARRIERS = [10, 20, 30];
const SIDES = ["attack"]; // defense comes with the attacker bots (milestone 3)

function parseCode(code) {
  const m = CODE.exec(String(code || ""));
  if (!m) return null;
  const [, map, side, weapon, sec] = m;
  if (!SIDES.includes(side) || !WEAPONS.includes(weapon) || !BARRIERS.includes(Number(sec))) return null;
  return { map, side, weapon, barrierSec: Number(sec) };
}

function hash16(text) {
  let a = 2166136261, b = 2654435761;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
  return ((a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0"));
}

// The enemy bots: one fixed spawner per setup spot (the sim keeps 5 of them per round and moves
// the kept ones onto distinct defender spawn points, see roundPrepare), one actor template with the
// drills' shooter settings (the Enemy rank setting replaces them, like in every drill), the roundBot
// behaviour (app/mods/aim-rounds/round-bots.mjs: walks from the spawn to the setup spot in
// setupBySpawner; it also turns the bot, so faceTarget is off), no respawn.
function buildDoc(data, opts) {
  const side = opts.side;
  const enemyTeam = side === "attack" ? "defense" : "attack";
  const spawners = [];
  const groups = {};
  const setupBySpawner = {};
  if (enemyTeam === "defense") {
    for (const [group, spots] of Object.entries(data.setups.defense)) {
      groups[group] = [];
      spots.forEach((p, i) => {
        const id = `round-${group}-${i + 1}`;
        groups[group].push(id);
        setupBySpawner[id] = { name: p.name, group, x: p.x, y: p.y, z: p.z };
        spawners.push({
          id, name: `${group} ${p.name}`, kind: "fixed", actorTemplateId: "round-enemy",
          position: { x: p.x, y: p.y, z: p.z }, size: { x: 0, y: 0, z: 0 },
          maxAlive: 1, spawnDelay: [0.1, 0.2], faceTarget: false, groundSnap: true,
        });
      });
    }
  } else {
    // Defense side (milestone 3): attacker bots stand at their spawn until they get movement.
    groups.spawn = [];
    data.spawns.attack.forEach((p, i) => {
      const id = `round-spawn-${i + 1}`;
      groups.spawn.push(id);
      spawners.push({
        id, name: `attacker ${i + 1}`, kind: "fixed", actorTemplateId: "round-enemy",
        position: { x: p.x, y: p.y, z: p.z }, size: { x: 0, y: 0, z: 0 },
        maxAlive: 1, spawnDelay: [0.1, 0.2], faceTarget: false, groundSnap: true,
      });
    });
  }
  const own = data.spawns[side][0];
  const barrierSec = opts.barrierSec;
  const round = {
    map: data.map, side, barrierSec, roundSec: 100, plantSec: 4, spikeSec: 45, defuseSec: 7, defuseCheckpointSec: 3.5,
    enemyCount: 5,
    spawns: data.spawns,
    barriers: data.barriers.map((b) => ({ id: b.id, team: b.team, a: b.a, b: b.b, y: b.y })),
    sites: data.sites,
    setups: { groups, splits: enemyTeam === "defense" ? data.setups.splits : [[5]], count: 5 },
    setupBySpawner,
    ...(enemyTeam === "defense" ? { botStart: "spawn" } : {}),
    ...(data.retake ? { retake: data.retake } : {}),
  };
  return {
    schemaVersion: 2,
    meta: { id: `round-${data.map}-${side}`, name: `Round: ${data.name}`, seed: 1, createdAt: 0 },
    environment: { skyColor: "#111820", fogNear: 14, fogFar: 33, ambientIntensity: 1.55, keyLightIntensity: 2.2, fogEnabled: false, map: data.map },
    blocks: [],
    playerSpawn: { position: { x: own.x, y: own.y, z: own.z }, yaw: own.yaw },
    spawners,
    actors: [{
      id: "round-enemy", name: "Enemy",
      body: { shape: "humanoid", headSize: 1, bodyWidth: 0.44, bodyHeight: 0, look: "bot", weapon: "vandal" },
      color: "#ff4655",
      behaviors: [
        // shooter first: roundBot reads what the shooter wrote this tick (lastSeenTick).
        { kind: "shooter", difficulty: "hard", reaction: [0.35, 0.5], cadence: "weapon", aimErrorDeg: 3, maxRangeM: 60, engage: "stop", resumeDelay: [0.4, 0.8] },
        { kind: "roundBot" },
        { kind: "respawn", delay: [0.4, 0.9], mode: "never" },
      ],
      hitSlow: true,
    }],
    rules: {
      // Long enough for barrier + round + spike + end; the game's own timer and end checks are
      // switched off for round scenes (tools/round_patch.py), the round controller ends it.
      duration: barrierSec + 100 + 45 + 30,
      scoring: "clicking", weapon: opts.weapon, playerMovable: true,
      fireMode: AUTO.has(opts.weapon) ? "hold" : "single",
      playerDeath: "endRound", buyMenu: false,
      round,
    },
  };
}

function loadData(modsDir, map) {
  if (!/^[a-z0-9]+$/.test(map)) return null;
  const file = path.join(modsDir, "aim-rounds", `${map}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}

// The scene envelope main.js sends for a round code, or null when the code isn't a round code.
function roundScene(modsDir, code) {
  const opts = parseCode(code);
  if (!opts) return null;
  const data = loadData(modsDir, opts.map);
  if (!data || data.schema !== 1) return null;
  const doc = buildDoc(data, opts);
  const text = JSON.stringify(doc);
  const hash = hash16(text);
  const time = "2026-11-06 12:00:00";
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  // Shown on the game's brief card before the round (round-hud.js hides the card's generic parts
  // and keeps the line breaks). Plain text: the card escapes it.
  const description = [
    `${data.name} · ${cap(opts.side)} · ${cap(opts.weapon)} · ${opts.barrierSec} s barrier.`,
    "Plant the spike. Defenders hold the sites.",
    "Enter: start · Hold 4: plant · T: restart · Esc: menu",
  ].join("\n");
  return {
    authorNickname: "open-aim", authorUid: "local", blockCount: 0, createTime: time,
    description,
    docBytes: Buffer.byteLength(text), name: `Round: ${data.name} (${cap(opts.side)})`, playCount: 0,
    sceneHash: hash, sceneKey: `set-${hash}`, schemaVersion: 2, shareCode: code, updateTime: time,
    doc: text,
  };
}

module.exports = { roundScene, parseCode, buildDoc, WEAPONS, BARRIERS, SIDES };
