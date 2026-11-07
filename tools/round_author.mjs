// Round mode map data (app/mods/aim-rounds/<map>.json), authored from the map files on disk.
//
//   node tools/round_author.mjs [--map ascent] [--image <barrier reference png>] [--plot <out.svg>] [--check]
//                               [--attack-plot <out.png>]
//
// Node only, no app or browser. Reads site/aim-maps/<map>.collision.json (pawn collision + the
// gameplay navmesh and BombsiteMarker volumes) and <map>.minimap.json (callout names + world spots).
//
// How the Ascent barriers were placed (reproducible, all inputs are in this file):
//  1. The user's top-down callout picture (800x400, red = defender side, green = attacker side,
//     grey = neutral, thick red/teal marks = defender/attacker barriers) is a reference only and is
//     not shipped. The pixel centres of its callout labels (LABELS) and of its barrier marks (MARKS,
//     found by colour segmentation: red r>200,g<110,b<110; teal r<110,g>170,b>150) are written down
//     below, so the data rebuilds without the picture.
//  2. A 2D similarity transform picture px -> world (x,z) is fitted by least squares to the labels
//     that also exist as game callouts (minimap.json, Chinese names mapped in CALLOUTS). Labels that
//     sit far from the game's callout spot (residual > 6 m on the first fit) are dropped and the fit
//     is redone; residuals are stored in the output (authoring.transform).
//  3. Each mark is moved into world space and snapped to the narrowest real choke within +-3 m
//     across the corridor: horizontal rays at 0.3/0.9/1.5 m above the floor, both ways along the
//     mark, against the pawn collision. The widest hit per side (+0.5 m into the wall) gives the
//     segment end points, so the segment spans the corridor at every height a player can be.
//     A mark whose rays don't hit walls on both sides within 20 m fails the build.
//     Collision = pawn set + greybox set (the game also walks on the art meshes, which are
//     meshopt-compressed in the GLB and not decoded here; greybox is the blockout of the same
//     walls), so segments reach 0.5 m into the walls to cover small differences.
//  4. Plant zones = the BombsiteMarker volumes (instances at the world origin are ignored), with
//     the floor height range sampled from the pawn collision inside the zone.
//  5. Spawns are a row of 5 points around each team's spawn callout (floor + clearance checked);
//     defender setup spots are spots of the shipped Ascent drills that lie on the defender side.
//  6. Retake staging points (where defender bots group up before retaking a planted site) are
//     authored in RETAKE below; how they were picked is written next to them.
//  7. Seal check: the real nav graph (app/mods/aim-rounds/<map>.nav.bin, tools/round_nav.mjs) is
//     flooded from each team's spawns with that team's barriers up, over walk edges only and over
//     all edges (walk, drop, jump, gap). No callout outside the team's side may be reached.
//     Needs the nav.bin (committed); it doesn't need the 57 MB pawn bake or any ray.
//     With --image, every spawn / setup spot is also checked against the picture's colours.
//  8. Attacker routes, staging points and plant spots (round mode R3) are authored in ATTACK below;
//     how they were picked is written next to them.
//
// Other maps (R4) use the same steps with per-map switches in MAPS (Corrode = rook is the example):
//  - WORLD 'json' (Ascent: rays against <map>.collision.json pawn + greybox, floor start from its
//    NavMesh) or 'terrain' (no greybox / NavMesh in the collision file: rays against the game's real
//    pawn world from tools/round_terrain.mjs loadTerrain, the same triangles the nav bake walks on;
//    floor rays start at height hints in the data: SPAWN_Y per spawn callout, zone plane top + 2,
//    the y of setups / retake / attack points). Terrain mode needs the triangle cache (built on first
//    use, ~30 s; tools/round_nav.mjs builds it too).
//  - MINIMAP 'mod': callouts from app/mods/aim-maps/<map>.minimap.json (English names, used as they
//    are; CALLOUTS optional). Ascent keeps site/aim-maps (Chinese names mapped in CALLOUTS).
//  - BARRIERS 'collision': the barrier walls are the map's own placed SM_Barrier prims (gameplay set,
//    zero-thickness vertical planes): segment = the plane's long horizontal axis, each end pushed
//    BARRIER_EXT m further into the wall; wall y range = [lowest floor - 1, highest floor + 4.5] with
//    floors sampled 1 and 2.5 m out on both sides along the whole length. The team is not guessed:
//    with every barrier up, the nav graph is flooded from each team's spawns (all edges); for each
//    barrier the edges it cuts must have one end in exactly one team's flood and the other end in
//    neither (that team owns it), at least BARRIER_MIN_CUT walk edges, no edge joining the two
//    teams' floods and none with both ends in one team's flood; anything else fails. Id = team +
//    nearest callout (stable across runs). Needs the nav.bin: the first run (no nav.bin) writes the
//    barriers without a team and fails; bake, then run again.
//  - MARKS without LABELS: barrier marks in world [x, z] (no picture), snapped to the choke like
//    Ascent's; id / team / name come from the mark; in terrain mode each mark needs `floor`.
//  - CALLOUT_SPOTS: per-callout [x, z] or [x, y, z] that replaces the minimap spot for the seal check
//    (minimap spots that lie off the walkable floor); recorded under authoring.calloutSpots.
//  - FACING: callout the spawn rows face (Ascent: Mid Courtyard).
// Seal rule (all maps): no leak in the walk or all-edge flood of either team, every callout listed
// in SIDES has a nav node within 4 m (a callout off the graph can't be checked, so it fails), and
// every callout of a team's own side is reached over all edges.
//
// --plot writes a top-down SVG (navmesh floor shaded by height, barriers, zones, spawns, setups;
// with --image the picture is drawn underneath, transformed, for checking by eye — keep that SVG
// local, the picture isn't ours to ship). --check rebuilds and fails if the stored file differs.
// --check has two parts: a ray-free part that always runs (the stored file's seal report and barrier
// teams against the committed nav.bin), then the full rebuild + compare. In terrain mode the rebuild
// needs the triangle cache; without it --check says so and stops after the ray-free part (the round
// tests warm the cache first, so in the tests the full check always runs).
// --attack-plot writes a top-down PNG of the attacker data from the nav.bin header (header `attack`,
// so run tools/round_nav.mjs --reuse first): routes, entry waypoints, plant and post-plant spots.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseRoundNav } from '../app/mods/aim-rounds/round-nav.mjs';
import { TYPES, nodeIndex, nodesNear, nearestNode, flood, barrierMask, edgeCutBy } from './round_navlib.mjs';
import { attackPlot } from './round_navdata.mjs';
import { Img } from './round_png.mjs';
import { loadTerrain, terrainCacheFile, mapFile } from './round_terrain.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MAP = opt('--map', 'ascent');
const IMAGE = opt('--image');
const PLOT = opt('--plot');
const CHECK = args.includes('--check');
const ATTACK_PLOT = opt('--attack-plot');
const OUT = path.join(ROOT, 'app', 'mods', 'aim-rounds', `${MAP}.json`);

// ---------------------------------------------------------------- per-map hand input
const MAPS = {
  ascent: {
    name: 'Ascent',
    // English name -> game callout (minimap.json, Chinese).
    CALLOUTS: {
      'Attacker Spawn': '攻方 重生点', 'Defender Spawn': '守方 重生点',
      'A Site': 'A区 部署区', 'A Tree': 'A区 树木', 'A Lobby': 'A区 大厅', 'A Main': 'A区 大道',
      'A Window': 'A区 窗口', 'A Garden': 'A区 花园', 'A Rafters': 'A区 高台', 'A Wine': 'A区 酒庄',
      'B Site': 'B区 部署区', 'B Lobby': 'B区 大厅', 'B Main': 'B区 大道', 'Boat House': 'B区 船屋',
      'Mid Bottom': '中区 坡底', 'Mid Top': '中区 坡顶', 'Mid Catwalk': '中区 窄道', 'Mid Cubby': '中区 小房间',
      'Mid Market': '中区 市场', 'Mid Courtyard': '中区 庭院', 'Mid Link': '中区 小道', 'Mid Plaza': '中区 比萨',
    },
    // Label centres in the reference picture (px), measured on the picture.
    LABELS: {
      'Defender Spawn': [412, 30.5], 'B Site': [276, 105], 'Boat House': [230, 101], 'Mid Market': [361, 108.5],
      'Mid Plaza': [399, 118], 'A Window': [470, 92], 'A Garden': [459, 107.5], 'A Rafters': [537, 92],
      'A Site': [534, 133], 'A Tree': [471.5, 153], 'B Main': [296, 155], 'Mid Bottom': [389, 157],
      'Mid Courtyard': [382, 192], 'Mid Cubby': [456, 184], 'A Main': [517.5, 188.5], 'A Wine': [560.5, 187],
      'Mid Link': [345, 204.5], 'B Lobby': [301.5, 222], 'Mid Catwalk': [419, 207.5], 'A Lobby': [484, 236.5],
      'Mid Top': [433, 265], 'Attacker Spawn': [351.5, 329],
    },
    // Barrier marks in the picture (px end points). The B Site mark is 3 dashes, each snapped on
    // its own (B Main has two doorways into B Site); dashes that snap to the same doorway merge.
    // `floor` = expected floor height near a mark (B has a roof above the doorways).
    // Mid Link and Mid Top marks are split by their labels and used whole.
    MARKS: [
      { id: 'def-b1', team: 'defense', name: 'B Site / B Main', a: [273, 141], b: [284, 141], floor: 1 },
      { id: 'def-b2', team: 'defense', name: 'B Site / B Main', a: [292, 141], b: [303, 141], floor: 1 },
      { id: 'def-b3', team: 'defense', name: 'B Site / B Main (right)', a: [315, 141], b: [326, 141], floor: 1 },
      { id: 'def-mid', team: 'defense', name: 'Mid Bottom / Market', a: [379, 141.5], b: [398, 141.5] },
      { id: 'def-tree', team: 'defense', name: 'A Tree / Mid Cubby', a: [451, 165.5], b: [459, 165.5] },
      { id: 'def-a', team: 'defense', name: 'A Site / A Main', a: [525, 172.5], b: [539, 172.5] },
      { id: 'atk-bmain', team: 'attack', name: 'B Lobby / B Main', a: [275, 188.5], b: [285, 188.5] },
      { id: 'atk-link', team: 'attack', name: 'B Lobby / Mid Link', a: [330, 198], b: [330, 209] },
      { id: 'atk-midtop', team: 'attack', name: 'Mid Top', a: [441.5, 253], b: [441.5, 273] },
      { id: 'atk-amain', team: 'attack', name: 'A Lobby / A Main', a: [469, 223.5], b: [498, 223.5] },
    ],
    SPAWNS: { attack: 'Attacker Spawn', defense: 'Defender Spawn' },
    // Barrier phase side of each callout (from the picture: red / green / grey).
    SIDES: {
      'Attacker Spawn': 'attack', 'B Lobby': 'attack', 'A Lobby': 'attack',
      'Defender Spawn': 'defense', 'B Site': 'defense', 'Boat House': 'defense', 'Mid Market': 'defense', 'Mid Plaza': 'defense',
      'A Garden': 'defense', 'A Window': 'defense', 'A Rafters': 'defense', 'A Site': 'defense', 'A Tree': 'defense',
      'B Main': 'neutral', 'Mid Bottom': 'neutral', 'Mid Courtyard': 'neutral', 'Mid Link': 'neutral', 'Mid Cubby': 'neutral',
      'Mid Catwalk': 'neutral', 'Mid Top': 'neutral', 'A Main': 'neutral', 'A Wine': 'neutral',
    },
    // Defender setup spots (x,y,z) from the shipped Ascent drills (codes in comments).
    SETUPS: {
      A: [[-69.7, 5.0, -63.3, 'A site default'], [-66.5, 5.0, -55.5, 'A site front'], [-65.2, 5.29, -69.1, 'A generator'],
        [-72.6, 5.11, -52.3, 'A site tree side'], [-78.8, 8.28, -58.8, 'A heaven'], [-79.5, 8.09, -52.7, 'A heaven tree side'],
        [-83.2, 8.09, -67.3, 'A rafters back']], // 1b59…
      mid: [[-72.6, 3.0, 0.7, 'Market'], [-80.8, 3.0, 4.7, 'Market back'], [-72.6, 3.0, -18.0, 'Pizza']], // 0466…, 54d7…
      B: [[-82.7, -1.0, 25.3, 'B default'], [-86.6, -0.95, 30.4, 'B back site'], [-76.7, -0.98, 34.1, 'B boathouse side'],
        [-69.1, 0.96, 23.7, 'B site front'], [-76.3, 1.0, 20.8, 'B workshop']], // 54d7…, 302e…
    },
    // Default defender splits [A, mid, B] (seeded pick at round start).
    SPLITS: [[2, 1, 2], [2, 1, 2], [3, 0, 2], [2, 0, 3], [1, 1, 3], [3, 1, 1]],
    // Retake staging points, 2 per site (x, floor y, z on the nav graph). Picked by computation on
    // the real nav graph: nodes 2.5-4 s (walk + drop) from the site centre, reachable from the
    // defender spawn inside the defender barriers, outside the plant zone, on open floor, and hidden
    // from 1 m above the site centre (the bots' sight ray to 1.0 and 1.6 m above the node); per
    // approach the one closest to 3 s with the least detour from the defender's own route
    // (`node tools/round_nav.mjs --candidates A` lists them; A heaven, A tree and B CT are the top
    // picks). On Ascent B has a single defender-side doorway, so every low-detour B candidate shares
    // one entry group (the other groups come in from the back, ~5 s detour); B market is the node on
    // the route from Mid Market (3.45 s), about 3 m before that route joins the CT one. tools/round_nav.mjs re-checks all four (header `staging`).
    RETAKE: {
      A: [[-82.83, 8.09, -50.33, 'A heaven'], [-61.33, 4.0, -46.83, 'A tree']],
      B: [[-86.33, 1.0, 13.17, 'B CT'], [-81.33, 1.0, 10.17, 'B market']],
    },
    // Attacker bot data (round mode R3, the player defends): 2 routes per site, each with 3 staging
    // points where the attackers group up and an entry waypoint the route passes; 2 plant spots per
    // site. All picked by computation on the real nav graph (tools/round_navdata.mjs):
    //  - staging: attackStagingCandidates() around the route's callout spot (A Main, Mid Cubby,
    //    B Main, Mid Bottom; all neutral in SIDES, never the defender side): open floor, reached from
    //    all 5 attacker spawns on walk + drop edges; nearest the callout, greedily 1.5 m apart.
    //  - entry: a node on the bots' shortest walk + drop path from the staging point to the site:
    //    A Main = the A Main doorway (def-a), Mid Cubby = A Tree (defender side), B Main = the right
    //    B Main doorway (def-b3; walk + drop paths from B Main into B all use it and come in past
    //    B CT), Mid Market = Market (defender side; the route stages at Mid Bottom).
    //  - plant: plantCandidates(): at least 1 m inside the zone, every attacker node within 1 m in
    //    the zone and defusable, open floor. "default" = the candidate nearest the site goal, the
    //    second about 6 m away on another part of the site (A: by the generator, B: boathouse side).
    // tools/round_nav.mjs (--reuse) derives the checks and the post-plant spots (header `attack`).
    ATTACK: {
      routes: {
        A: [
          { name: 'A Main', entry: [-55.33, 4.0, -59.33, 'A Main door'], staging: [[-47.33, 4.0, -53.33, 'A Main 1'], [-45.83, 4.0, -53.33, 'A Main 2'], [-47.33, 4.0, -51.83, 'A Main 3']] },
          { name: 'Mid Cubby', entry: [-56.83, 4.0, -40.83, 'A Tree'], staging: [[-51.33, 4.0, -33.83, 'Mid Cubby 1'], [-51.33, 4.0, -35.33, 'Mid Cubby 2'], [-49.83, 4.0, -33.83, 'Mid Cubby 3']] },
        ],
        B: [
          { name: 'B Main', entry: [-63.83, 1.0, 13.17, 'B Main door'], staging: [[-58.33, 1.0, 19.67, 'B Main 1'], [-58.33, 1.0, 21.17, 'B Main 2'], [-59.83, 1.0, 19.67, 'B Main 3']] },
          { name: 'Mid Market', entry: [-72.83, 3.0, -3.83, 'Market'], staging: [[-59.33, 2.0, -11.33, 'Mid Bottom 1'], [-60.83, 2.0, -11.33, 'Mid Bottom 2'], [-59.33, 2.0, -9.83, 'Mid Bottom 3']] },
        ],
      },
      plant: {
        A: [[-71.83, 5.0, -60.83, 'A default'], [-68.33, 5.0, -66.33, 'A generator']],
        B: [[-78.83, -1.07, 30.17, 'B default'], [-77.33, -0.99, 36.17, 'B boathouse']],
      },
    },
  },
  // Corrode. No greybox / NavMesh in rook.collision.json, so rays use the real pawn world (WORLD
  // 'terrain'); English callouts from app/mods/aim-maps/rook.minimap.json; barriers are the map's
  // 9 placed SM_Barrier walls (BARRIERS 'collision', team by flood).
  rook: {
    name: 'Corrode',
    WORLD: 'terrain', MINIMAP: 'mod', BARRIERS: 'collision', FACING: 'Mid Bottom',
    SPAWNS: { attack: 'Attacker Spawn', defense: 'Defender Spawn' },
    // Floor under each spawn callout (vertical rays against the pawn world).
    SPAWN_Y: { 'Attacker Spawn': 4, 'Defender Spawn': 6 },
    // Threshold overrides against the Ascent rules, recorded under authoring.notes.
    NOTES: {
      setupSpawnT: "setups: spawnT <= 10 s (shortest barrier) + attackers' fastest barrier -> zone time - 1 s (A 16.84 s, B 14.29 s; mid 11.5 s) instead of Ascent's 11.5 s cap: Corrode's sites are 10.4 s (A) and 14.6 s (B) from the defender spawn, no spot inside or near them is reachable in 11.5 s",
      setupsInZone: 'A has no setup inside the zone: no spot in it sees a defender barrier within 30 m; the A setups stand just outside it (A site front, A ramp, A link corner) and in A Pocket / A Yard',
      retake: 'A ramp (2.52 s, 5 s detour) and B link (2.56 s, 4 s detour) are the best of their approach groups; kept so each site has a retake point on two sides',
      plant: 'second plant spots are 5 m from the default (Ascent: about 6 m); none 6 m away has a better margin',
    },
    // Minimap spots off the walkable floor (no nav node within 4 m), moved onto it by hand from the
    // nav graph: A Lobby / A Main sit over empty space north of the real rooms (the minimap labels
    // stand outside them); A Crane is the crane over the drop, its floor is 5 m east.
    CALLOUT_SPOTS: { 'A Lobby': [26, 4, -32.83], 'A Main': [10.17, 4, -44.83], 'A Crane': [-35.33, 6, -42.33] },
    // Barrier phase side of each callout, by hand from the map: lobbies and the attacker spawn are
    // the attackers'; sites, the defender spawn and the defender's back areas (A Crane / Elbow / Pocket
    // / Yard, B Arch / Tower / Elbow, Mid Window) the defenders'; mains, links and the rest of mid are
    // neutral. The seal check proves it against the barriers (no leak, every own callout reached).
    SIDES: {
      'Attacker Spawn': 'attack', 'A Lobby': 'attack', 'B Lobby': 'attack',
      'Defender Spawn': 'defense', 'A Site': 'defense', 'A Crane': 'defense', 'A Elbow': 'defense', 'A Pocket': 'defense', 'A Yard': 'defense',
      'B Site': 'defense', 'B Arch': 'defense', 'B Tower': 'defense', 'B Elbow': 'defense', 'Mid Window': 'defense',
      'A Main': 'neutral', 'A Link': 'neutral', 'B Main': 'neutral', 'B Link': 'neutral', 'Mid Bottom': 'neutral', 'Mid Top': 'neutral', 'Mid Stairs': 'neutral',
    },
    // Defender setup spots, picked from `node tools/round_nav.mjs --map rook --setup-candidates <A|B|mid>`
    // (round_navdata.mjs setupCandidates: defender-walkable inside the defender barriers, open floor,
    // in the zone or within 12 m, spawnT <= 10 s barrier + attackers' fastest barrier -> zone time
    // - 1 s (A 16.84 s, B 14.29 s; mid 11.5 s), sees >= 1 defender barrier (attacker entrance) within
    // 30 m, seen from <= 2, all hidden from the attacker barriers), by hand among the top ones so
    // every entrance is watched: A Link (def-a-link) and A Yard (def-a-yard) for A, B Main door
    // (def-b-site) and B Link (def-b-site-2) for B, Mid Window (def-mid-window) for mid.
    // 'A pocket' and 'A link corner' are spots of the shipped Corrode drill (corrode-mid-to-a-peekers).
    SETUPS: {
      A: [[-17.83, 5.73, -34.83, 'A site front'], [-22.83, 6, -29.33, 'A link corner'], [-15.83, 5.35, -30.83, 'A ramp'],
        [-7.83, 6, -51.33, 'A pocket'], [-6.33, 5, -31.33, 'A yard']],
      mid: [[-30.83, 8, -1.33, 'Mid window'], [-30.83, 8, -7.33, 'Mid window left'], [-30.83, 8, 4.67, 'Mid window right']],
      B: [[-21.33, 6, 37.17, 'B site'], [-23.83, 6, 34.67, 'B link watch'], [-25.33, 6.84, 39.67, 'B back'],
        [-20.83, 7, 45.17, 'B elbow'], [-14.33, 7, 45.17, 'B corner']],
    },
    // Default defender splits [A, mid, B] (as on Ascent).
    SPLITS: [[2, 1, 2], [2, 1, 2], [3, 0, 2], [2, 0, 3], [1, 1, 3], [3, 1, 1]],
    // Retake staging points (same rules as Ascent, `node tools/round_nav.mjs --map rook --candidates <site>`):
    // 2.5-4 s from the site goal, defender-reachable, outside the zone, open floor, hidden from the
    // site centre. One per approach group: A crane (west, no detour) and A ramp (south-east, from the
    // A Link side; that group's best are all ~2.5 s with a 5 s detour); B elbow (north, 0.06 s detour)
    // and B link (south, 4 s detour; chosen over the second north group so the two come from
    // different sides).
    RETAKE: {
      A: [[-34.33, 6, -36.83, 'A crane'], [-13.33, 5, -31.33, 'A ramp']],
      B: [[-22.83, 7, 51.17, 'B elbow'], [-18.33, 6, 25.17, 'B link']],
    },
    // Attacker bot data, same rules as Ascent (`node tools/round_nav.mjs --map rook --attack-candidates
    // <site> --near "x,z|x,z"`): staging = attackStagingCandidates() at the route's callout (A Main
    // (moved spot), A Link, B Main, B Link; all neutral in SIDES), nearest first, 1.5 m apart; entry =
    // the defender barrier doorway the route goes through (nav node at the barrier's middle):
    // A Main -> def-a-yard, A Link -> def-a-link, B Main -> def-b-site, B Link -> def-b-site-2
    // (header attack.staging entryD proves the bots' shortest path passes it); plant = plantCandidates():
    // "default" nearest the site goal, the second one 5 m away on another part of the site.
    ATTACK: {
      routes: {
        A: [
          { name: 'A Main', entry: [0.67, 4.83, -43.83, 'A Yard door'], staging: [[10.17, 4, -44.83, 'A Main 1'], [11.67, 4, -44.83, 'A Main 2'], [10.17, 4, -46.33, 'A Main 3']] },
          { name: 'A Link', entry: [-11.83, 5, -22.33, 'A Link door'], staging: [[-11.33, 5, -17.83, 'A Link 1'], [-11.33, 5, -16.33, 'A Link 2'], [-12.83, 5, -17.83, 'A Link 3']] },
        ],
        B: [
          { name: 'B Main', entry: [-7.83, 7, 44.17, 'B Main door'], staging: [[7.67, 7, 27.17, 'B Main 1'], [7.67, 7, 25.67, 'B Main 2'], [6.17, 7, 27.17, 'B Main 3']] },
          { name: 'B Link', entry: [-17.83, 6, 22.17, 'B Link door'], staging: [[-18.33, 6, 12.67, 'B Link 1'], [-18.33, 6, 14.17, 'B Link 2'], [-19.83, 6, 12.67, 'B Link 3']] },
        ],
      },
      plant: {
        A: [[-18.33, 6, -43.83, 'A default'], [-21.33, 6, -39.83, 'A front']],
        B: [[-17.83, 6, 38.17, 'B default'], [-21.83, 6, 41.17, 'B back']],
      },
    },
  },
};
const M = MAPS[MAP];
if (!M) throw new Error(`no hand input for map ${MAP}`);

// ---------------------------------------------------------------- collision
const TERRAIN = M.WORLD === 'terrain';
const col = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'aim-maps', `${MAP}.collision.json`), 'utf8'));
const mini = JSON.parse(fs.readFileSync(M.MINIMAP === 'mod' ? mapFile(MAP, 'minimap.json') : path.join(ROOT, 'site', 'aim-maps', `${MAP}.minimap.json`), 'utf8'));
// English name -> minimap callout name (identity when the minimap is already English).
const CAL = M.CALLOUTS ?? Object.fromEntries(mini.callouts.map((c) => [c.name, c.name]));
function instances(setName, filter) {
  const set = col.sets[setName], out = [];
  for (let i = 0; i < set.count; i++) {
    const prim = col.prims[set.prim[i]];
    if (filter && !filter(prim.name, i)) continue;
    out.push({ i, prim, m: set.m.slice(i * 12, i * 12 + 12) });
  }
  return out;
}
function trisOf(list) {
  const out = [];
  for (const { prim, m } of list) {
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    const v = (k) => {
      const x = prim.pos[k * 3], y = prim.pos[k * 3 + 1], z = prim.pos[k * 3 + 2];
      return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
    };
    for (let t = 0; t < prim.idx.length; t += 3) {
      const a = v(prim.idx[t]), b = v(prim.idx[t + 1]), c = v(prim.idx[t + 2]);
      out.push(det < 0 ? [a, c, b] : [a, b, c]);
    }
  }
  return out;
}
// The game's walk world is the pawn set plus the map's art meshes (meshopt-compressed GLB, not
// decoded here). The greybox set (the level blockout) stands in for the art: floors and walls.
const pawn = [...trisOf(instances('pawn')), ...trisOf(instances('greybox'))];
const nav = trisOf(instances('gameplay', (n) => /NavMesh/.test(n)));
const box3 = (t) => [Math.min(t[0][0], t[1][0], t[2][0]), Math.max(t[0][0], t[1][0], t[2][0]), Math.min(t[0][2], t[1][2], t[2][2]), Math.max(t[0][2], t[1][2], t[2][2])];
const pawnBox = pawn.map(box3);

// Möller–Trumbore, both faces. Returns distance or -1.
function ray(o, d, tri, max) {
  const [a, b, c] = tri;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-9) return -1;
  const inv = 1 / det, s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return -1;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 1e-6 && t <= max ? t : -1;
}
// Terrain mode: the game's real pawn world (BVH) from the triangle cache. --check without the cache
// stops after its ray-free part (see the header).
const CACHE_OK = !TERRAIN || fs.existsSync(terrainCacheFile(MAP) ?? '');
const TW = TERRAIN && (!CHECK || CACHE_OK) ? await loadTerrain(MAP) : null;
if (TERRAIN && !CHECK && !TW) throw new Error(`terrain mode: no map files for ${MAP}`);
const FLOOR_NY = Math.cos(44.765 * Math.PI / 180); // the game's floor probe slope limit
function cast(o, d, max) {
  if (TERRAIN) return TW.ray(TW.pawn, o, d, max);
  let best = -1;
  const x0 = Math.min(o[0], o[0] + d[0] * max), x1 = Math.max(o[0], o[0] + d[0] * max);
  const z0 = Math.min(o[2], o[2] + d[2] * max), z1 = Math.max(o[2], o[2] + d[2] * max);
  for (let i = 0; i < pawn.length; i++) {
    const b = pawnBox[i];
    if (b[1] < x0 || b[0] > x1 || b[3] < z0 || b[2] > z1) continue;
    const t = ray(o, d, pawn[i], best < 0 ? max : best);
    if (t >= 0) best = t;
  }
  return best;
}
// Floor: the highest up-facing pawn surface at or below `from` (default: just above the navmesh).
function navHeight(x, z) {
  let best = null;
  for (const t of nav) { const h = ray([x, 200, z], [0, -1, 0], t, 400); if (h >= 0) { const y = 200 - h; if (best === null || y > best) best = y; } }
  return best;
}
function floorAt(x, z, from = null) {
  if (TERRAIN) {
    // No NavMesh to start from: the caller passes a height hint. Floors only (the game's slope limit).
    if (from === null) throw new Error(`floorAt(${x}, ${z}): terrain mode needs a start height`);
    const h = TW.ray(TW.pawn, [x, from, z], [0, -1, 0], 30, FLOOR_NY);
    return h < 0 ? null : +(from - h).toFixed(3);
  }
  const top = from ?? ((navHeight(x, z) ?? 20) + 0.3);
  const h = cast([x, top, z], [0, -1, 0], 30);
  return h < 0 ? null : +(top - h).toFixed(3);
}

// ---------------------------------------------------------------- picture -> world transform
const callout = Object.fromEntries(mini.callouts.map((c) => [c.name, [c.x, c.z]]));
function fitSimilarity(keys) {
  const pts = keys.map((k) => [...M.LABELS[k], ...callout[M.CALLOUTS[k]]]);
  const n = pts.length; let mu = 0, mv = 0, mx = 0, mz = 0;
  for (const [u, v, x, z] of pts) { mu += u / n; mv += v / n; mx += x / n; mz += z / n; }
  let a = 0, b = 0, d = 0;
  for (const [u, v, x, z] of pts) { const U = u - mu, V = v - mv, X = x - mx, Z = z - mz; a += U * X + V * Z; b += U * Z - V * X; d += U * U + V * V; }
  const A = a / d, B = b / d;
  const f = (u, v) => [A * (u - mu) - B * (v - mv) + mx, B * (u - mu) + A * (v - mv) + mz];
  const inv = (x, z) => { const X = x - mx, Z = z - mz, s = A * A + B * B; return [(A * X + B * Z) / s + mu, (-B * X + A * Z) / s + mv]; };
  const residuals = Object.fromEntries(keys.map((k) => { const w = f(...M.LABELS[k]); const c = callout[M.CALLOUTS[k]]; return [k, +Math.hypot(w[0] - c[0], w[1] - c[1]).toFixed(2)]; }));
  return { f, inv, A, B, mu, mv, mx, mz, residuals, metresPerPx: Math.hypot(A, B), rotationDeg: Math.atan2(B, A) * 180 / Math.PI };
}
// Picture mode only (maps with LABELS / MARKS, i.e. Ascent).
let keys = [], first = null, dropped = [], T = null, rms = null;
if (M.LABELS) {
  keys = Object.keys(M.LABELS).filter((k) => callout[M.CALLOUTS[k]]);
  first = fitSimilarity(keys);
  dropped = keys.filter((k) => first.residuals[k] > 6);
  keys = keys.filter((k) => !dropped.includes(k));
  T = fitSimilarity(keys);
  rms = Math.sqrt(Object.values(T.residuals).reduce((s, r) => s + r * r, 0) / keys.length);
}
// Callout spot for the seal check / names: CALLOUT_SPOTS override, else the minimap spot.
const spotOf = (name) => M.CALLOUT_SPOTS?.[name] ?? callout[CAL[name]] ?? null;

// ---------------------------------------------------------------- nav graph checks (ray-free)
const NAV_FILE = path.join(ROOT, 'app', 'mods', 'aim-rounds', `${MAP}.nav.bin`);
const NAV = fs.existsSync(NAV_FILE) ? parseRoundNav(fs.readFileSync(NAV_FILE)) : null;
const NAV_H = NAV ? nodeIndex(NAV) : null;
const BARRIER_EXT = 0.4, BARRIER_MIN_CUT = 5;
const r2 = (v) => +v.toFixed(2);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Seal check (see the header, step 7): returns { report, errors }.
function sealCheck(g, H, spawnsIn, bars) {
  const report = { nav: { file: path.relative(ROOT, NAV_FILE).split(path.sep).join('/'), nodes: g.count, edges: g.edgeCount } };
  const errors = [];
  const sample = (p) => {
    const [x, z] = [p[0], p[p.length - 1]], y = p.length === 3 ? p[1] : null;
    const n = y === null ? nearestNode(g, H, x, z, 4) : nearestNode(g, H, x, z, 4, y, 1.5); if (n < 0) return [];
    const l = nodesNear(g, H, x, z, 1, g.y[n], 0.6); return l.length ? l : [n];
  };
  for (const name of Object.keys(M.SIDES)) if (!CAL[name] && !M.CALLOUT_SPOTS?.[name]) errors.push(`seal check: SIDES callout ${name} is not a callout of the map`);
  const spots = Object.keys(CAL).filter((name) => M.SIDES[name] && spotOf(name))
    .map((name) => ({ name, side: M.SIDES[name], nodes: sample(spotOf(name)) }));
  const off = spots.filter((c) => !c.nodes.length).map((c) => c.name);
  if (off.length) errors.push(`seal check: callouts off the nav graph (no node within 4 m; add a CALLOUT_SPOTS entry): ${off.join(', ')}`);
  for (const team of ['attack', 'defense']) {
    const sp = spawnsIn[team].map((p) => nearestNode(g, H, p.x, p.z, 0.75, p.y, 1));
    if (sp.some((n) => n < 0)) errors.push(`seal check: a ${team} spawn is off the nav graph`);
    const mask = barrierMask(g, bars.filter((b) => b.team === team));
    const res = {};
    for (const [mode, types] of [['walk', TYPES.walk], ['all', TYPES.all]]) {
      const par = flood(g, sp, { types, mask });
      let nodes = 0; for (let i = 0; i < g.count; i++) if (par[i] !== -2) nodes++;
      const leaks = [], unreached = [];
      for (const c of spots) {
        const hit = c.nodes.some((i) => par[i] !== -2);
        if (c.side !== team && hit) leaks.push(c.name);
        if (c.side === team && !hit) unreached.push(c.name);
      }
      res[mode] = { nodes, leaks, unreached };
    }
    const leaks = [...new Set([...res.walk.leaks, ...res.all.leaks])];
    report[team] = { nodes: res.all.nodes, leaks, unreached: res.all.unreached, walk: res.walk, all: res.all };
    if (leaks.length) errors.push(`seal check: ${team} barriers leak into ${leaks.join(', ')}`);
    if (res.all.unreached.length) errors.push(`seal check: ${team} can't reach its own ${res.all.unreached.join(', ')}`);
  }
  return { report, errors };
}

// Barrier teams by flood (BARRIERS 'collision', see the header). bars: [{ a, b, y, ... }] in a fixed
// order; returns per barrier { team, id, name, cut: { walk, all }, votes, inside, conflict } and errors.
function barrierTeams(g, H, spawnsIn, bars) {
  const snapSp = (p) => nearestNode(g, H, p.x, p.z, 0.75, p.y, 1);
  const all = barrierMask(g, bars);
  const fl = {};
  for (const team of ['attack', 'defense']) fl[team] = flood(g, spawnsIn[team].map(snapSp), { types: TYPES.all, mask: all });
  const sideOf = (i) => { const a = fl.attack[i] !== -2, d = fl.defense[i] !== -2; return a && d ? 'both' : a ? 'attack' : d ? 'defense' : null; };
  const names = Object.keys(CAL).filter((n) => spotOf(n)).map((n) => { const p = spotOf(n); return { n, x: p[0], z: p[p.length - 1] }; });
  const errors = [], out = [], used = new Map();
  for (const b of bars) {
    const votes = { attack: { walk: 0, all: 0 }, defense: { walk: 0, all: 0 } }, cut = { walk: 0, all: 0 };
    let inside = 0, conflict = 0, sideSum = 0;
    const vx = b.b.x - b.a.x, vz = b.b.z - b.a.z, nx = -vz, nz = vx, mx = (b.a.x + b.b.x) / 2, mz = (b.a.z + b.b.z) / 2;
    const x0 = Math.min(b.a.x, b.b.x) - 2, x1 = Math.max(b.a.x, b.b.x) + 2, z0 = Math.min(b.a.z, b.b.z) - 2, z1 = Math.max(b.a.z, b.b.z) + 2;
    for (let i = 0; i < g.count; i++) {
      if (g.x[i] < x0 || g.x[i] > x1 || g.z[i] < z0 || g.z[i] > z1) continue;
      for (let e = g.edgeStart[i]; e < g.edgeStart[i + 1]; e++) {
        const j = g.edgeTo[e];
        if (!edgeCutBy(g, [b], i, j)) continue;
        const walk = g.edgeType[e] === 0;
        cut.all++; if (walk) cut.walk++;
        const si = sideOf(i), sj = sideOf(j);
        if (si === 'both' || sj === 'both' || (si && sj && si !== sj)) conflict++;
        else if (si && sj) inside++;
        else if (si || sj) {
          const t = si || sj, k = si ? i : j;
          votes[t].all++; if (walk) votes[t].walk++;
          sideSum += Math.sign((g.x[k] - mx) * nx + (g.z[k] - mz) * nz);
        }
      }
    }
    const team = votes.attack.all && !votes.defense.all ? 'attack' : votes.defense.all && !votes.attack.all ? 'defense' : null;
    const where = `barrier at (${r2(mx)}, ${r2(mz)})`;
    if (!team) errors.push(`${where}: cut edges touch ${votes.attack.all} attacker / ${votes.defense.all} defender flood edges (need exactly one team)`);
    if (conflict) errors.push(`${where}: ${conflict} cut edges join the two teams' floods`);
    if (inside) errors.push(`${where}: ${inside} cut edges have both ends in one team's flood (that team gets around it with every barrier up)`);
    if (team && votes[team].walk < BARRIER_MIN_CUT) errors.push(`${where}: only ${votes[team].walk} cut walk edges on the ${team} side (decorative or misplaced?)`);
    // Names: nearest callout on the team's side / on the far side (within 30 m); id from the nearest.
    const own = Math.sign(sideSum) || 1, d = (c) => Math.hypot(c.x - mx, c.z - mz);
    const near = [...names].sort((p, q) => d(p) - d(q) || p.n.localeCompare(q.n));
    const sideC = (sg) => near.find((c) => d(c) <= 30 && Math.sign((c.x - mx) * nx + (c.z - mz) * nz) === sg);
    const tn = sideC(own), on = sideC(-own);
    let id = `${team === 'defense' ? 'def' : team === 'attack' ? 'atk' : 'bar'}-${slug(near[0].n)}`;
    const k = (used.get(id) ?? 0) + 1; used.set(id, k); if (k > 1) id += `-${k}`;
    out.push({ team, id, name: [tn?.n, on?.n].filter(Boolean).join(' / ') || near[0].n, cut, votes, inside, conflict });
  }
  return { list: out, errors };
}

// Ray-free part of --check: the stored file against the committed nav.bin (runs without any ray).
if (CHECK) {
  const stored = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (!stored) { console.error(`${path.relative(ROOT, OUT)} is missing: run node tools/round_author.mjs`); process.exit(1); }
  if (!NAV) { console.error(`check: no ${path.relative(ROOT, NAV_FILE)}`); process.exit(1); }
  const errs = [];
  if (M.BARRIERS === 'collision') {
    const { list, errors } = barrierTeams(NAV, NAV_H, stored.spawns, stored.barriers);
    errs.push(...errors);
    list.forEach((t, k) => { const b = stored.barriers[k]; if (t.team !== b.team || t.id !== b.id) errs.push(`barrier ${b.id}: flood says ${t.id} (${t.team})`); });
  }
  const { report, errors } = sealCheck(NAV, NAV_H, stored.spawns, stored.barriers);
  errs.push(...errors);
  if (JSON.stringify(report) !== JSON.stringify(stored.authoring?.seal)) errs.push('stored seal report differs from the committed nav.bin');
  if (errs.length) { console.error(`${path.relative(ROOT, OUT)} ray-free check failed:\n  ` + errs.join('\n  ')); process.exit(1); }
  console.log(`${path.relative(ROOT, OUT)} ray-free check ok (seal report and barrier teams match ${path.relative(ROOT, NAV_FILE)})`);
  if (!TW && TERRAIN) {
    console.log(`full rebuild check skipped: no terrain triangle cache for ${MAP} (${terrainCacheFile(MAP)}); run node tools/round_nav.mjs --map ${MAP} --reuse or load the terrain once`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------- barriers (snap to choke)
// Marks are picture px (maps with LABELS) or world [x, z] (maps without a picture). In terrain mode a
// mark needs `floor` (the floor height near it) as the ray start hint.
function snapBarrier(mark) {
  if (TERRAIN && mark.floor === undefined) throw new Error(`barrier ${mark.id}: terrain mode needs the mark's floor height (floor: y)`);
  const a = T ? T.f(...mark.a) : mark.a, b = T ? T.f(...mark.b) : mark.b;
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz); dx /= L; dz /= L;
  const nx = -dz, nz = dx;
  let best = null;
  for (let t = -3; t <= 3.001; t += 0.25) {
    const px = c[0] + nx * t, pz = c[1] + nz * t;
    const fy = floorAt(px, pz, mark.floor === undefined ? null : mark.floor + 1.5);
    if (fy === null) continue;
    let plus = 0, minus = 0, ok = true;
    for (const h of [0.3, 0.9, 1.5]) {
      const o = [px, fy + h, pz];
      const p1 = cast(o, [dx, 0, dz], 20), m1 = cast(o, [-dx, 0, -dz], 20);
      if (p1 < 0 || m1 < 0) { ok = false; break; }
      plus = Math.max(plus, p1); minus = Math.max(minus, m1);
    }
    if (!ok) continue;
    const width = plus + minus;
    if (!best || width < best.width - 0.05) best = { t, width, px, pz, fy, plus, minus };
  }
  if (!best) throw new Error(`barrier ${mark.id}: no closed choke within 3 m of the mark`);
  const { px, pz, fy, plus, minus } = best;
  // Height range: the floors on both sides of the line (1 and 2.5 m out, across the opening),
  // from 1 m under the lowest to 4.5 m over the highest, so feet on either side are inside it.
  const floors = [fy];
  for (const side of [-1, 1]) for (const out of [1, 2.5]) for (const k of [-0.6, -0.3, 0, 0.3, 0.6]) {
    const along = k > 0 ? k * plus : k * minus;
    const f = floorAt(px + nx * out * side + dx * along, pz + nz * out * side + dz * along, fy + 2.2);
    if (f !== null && Math.abs(f - fy) < 2.5) floors.push(f);
  }
  const lo = Math.min(...floors), hi = Math.max(...floors);
  return {
    id: mark.id, team: mark.team, name: mark.name,
    a: { x: r2(px - dx * (minus + 0.5)), z: r2(pz - dz * (minus + 0.5)) },
    b: { x: r2(px + dx * (plus + 0.5)), z: r2(pz + dz * (plus + 0.5)) },
    y: [r2(lo - 1), r2(hi + 4.5)],
    width: r2(best.width), shift: r2(best.t), floors: [r2(lo), r2(hi)],
    mark: { a: mark.a, b: mark.b, world: { x: r2(c[0]), z: r2(c[1]) } },
  };
}
// BARRIERS 'collision': the map's placed SM_Barrier planes (see the header). Team / id / name come
// later from the nav graph (barrierTeams).
function collisionBarriers() {
  const out = [];
  for (const { i, prim, m } of instances('gameplay', (n) => n === 'SM_Barrier')) {
    if (Math.abs(m[3]) < 1e-6 && Math.abs(m[11]) < 1e-6) continue; // parked at the world origin
    const vs = trisOf([{ prim, m }]).flat();
    let A = vs[0], B = vs[0], L = -1;
    for (const p of vs) for (const q of vs) { const d = Math.hypot(p[0] - q[0], p[2] - q[2]); if (d > L + 1e-9) { L = d; A = p; B = q; } }
    if (A[0] > B[0] + 1e-6 || (Math.abs(A[0] - B[0]) <= 1e-6 && A[2] > B[2])) [A, B] = [B, A];
    const dx = (B[0] - A[0]) / L, dz = (B[2] - A[2]) / L, nx = -dz, nz = dx;
    const ys = vs.map((v) => v[1]), base = Math.min(...ys), top = Math.max(...ys);
    // Floors 1 and 2.5 m out on both sides along the whole length; start 5 m under the plane's top
    // (base + 2.5 for the usual 7.5 m plane, higher on the tall one that sits on a slope).
    const from = top - 5, floors = [];
    for (const side of [-1, 1]) for (const o of [1, 2.5]) for (const k of [0.05, 0.25, 0.5, 0.75, 0.95]) {
      const f = floorAt(A[0] + dx * L * k + nx * o * side, A[2] + dz * L * k + nz * o * side, from);
      if (f !== null && f >= base - 1.5) floors.push(f);
    }
    if (!floors.length) throw new Error(`SM_Barrier ${i}: no floor next to it`);
    const lo = Math.min(...floors), hi = Math.max(...floors);
    out.push({
      id: null, team: null, name: null,
      a: { x: r2(A[0] - dx * BARRIER_EXT), z: r2(A[2] - dz * BARRIER_EXT) },
      b: { x: r2(B[0] + dx * BARRIER_EXT), z: r2(B[2] + dz * BARRIER_EXT) },
      y: [r2(lo - 1), r2(hi + 4.5)],
      width: r2(L),
      meta: { prim: i, lengthM: r2(L), planeY: [r2(base), r2(top)], floors: [r2(lo), r2(hi)] },
    });
  }
  if (!out.length) throw new Error('BARRIERS collision: no SM_Barrier prims placed in the world');
  return out;
}
const barriers = [];
if (M.BARRIERS === 'collision') barriers.push(...collisionBarriers());
else for (const b of M.MARKS.map(snapBarrier)) {
  const same = barriers.find((o) => o.team === b.team && Math.hypot(o.a.x - b.a.x, o.a.z - b.a.z) + Math.hypot(o.b.x - b.b.x, o.b.z - b.b.z) < 2);
  if (!same) barriers.push(b);
}

// ---------------------------------------------------------------- sites / plant zones
const zoneTris = {}; // site id -> marker triangles (outline drawn in the plot)
function siteZones() {
  const out = [];
  // Ascent: BombsiteMarker_0_BombsiteA; Corrode: Bombsite_0_ASitePlane (outline strips; the map has
  // two copies of each with the same transform, the first one per site id is used).
  const ZONE = /^(?:BombsiteMarker_0_Bombsite([A-Z])|Bombsite_0_([A-C])SitePlane)$/;
  for (const { prim, m } of instances('gameplay', (n) => ZONE.test(n))) {
    if (Math.abs(m[3]) < 1e-6 && Math.abs(m[11]) < 1e-6) continue; // parked at the world origin
    const mm = ZONE.exec(prim.name), id = mm[1] ?? mm[2];
    if (out.some((o) => o.id === id)) continue;
    const tris = trisOf([{ prim, m }]);
    const xs = tris.flat().map((v) => v[0]), zs = tris.flat().map((v) => v[2]), ys = tris.flat().map((v) => v[1]);
    zoneTris[id] = tris;
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const heights = [];
    for (let x = x0 + 0.5; x < x1; x += 1) for (let z = z0 + 0.5; z < z1; z += 1) {
      const f = floorAt(x, z, Math.max(...ys) + 2);
      if (f !== null) heights.push(f);
    }
    heights.sort((p, q) => p - q);
    const lo = heights[Math.floor(heights.length * 0.02)], hi = heights[Math.floor(heights.length * 0.98)];
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    out.push({
      id, zone: [[r2(x0), r2(z0)], [r2(x1), r2(z0)], [r2(x1), r2(z1)], [r2(x0), r2(z1)]],
      y: [r2(lo - 0.3), r2(hi + 0.6)],
      center: { x: r2(cx), y: floorAt(cx, cz, Math.max(...ys) + 2) ?? r2(lo), z: r2(cz) },
    });
  }
  return out.sort((p, q) => p.id.localeCompare(q.id));
}
const sites = siteZones();

// ---------------------------------------------------------------- spawns, setups
const yawTo = (dx, dz) => r2(Math.atan2(-dx, -dz)); // the game's forward is (-sin yaw, -cos yaw)
function clearance(x, y, z) {
  let min = 99;
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; const h = cast([x, y + 0.9, z], [Math.cos(a), 0, Math.sin(a)], 3); if (h >= 0) min = Math.min(min, h); }
  return min;
}
function spawnRow(name, facing) {
  const sp = spotOf(name), cx = sp[0], cz = sp[sp.length - 1];
  const hint = M.SPAWN_Y ? M.SPAWN_Y[name] : null;
  const pts = [];
  // Rows across the facing direction; try a few rows until 5 clear points are found.
  const fx = facing[0] - cx, fz = facing[1] - cz, fl = Math.hypot(fx, fz);
  const ux = fx / fl, uz = fz / fl, sx = -uz, sz = ux;
  for (const row of [0, -2, 2, -4, 4]) for (const off of [0, -1.6, 1.6, -3.2, 3.2, -4.8, 4.8]) {
    if (pts.length >= 5) break;
    const x = cx + ux * row + sx * off, z = cz + uz * row + sz * off;
    const y = floorAt(x, z, hint === null ? null : hint + 1.5);
    if (y === null || (hint !== null && Math.abs(y - hint) > 1) || clearance(x, y, z) < 0.8) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.z - z) < 1.4)) continue;
    pts.push({ x: r2(x), y, z: r2(z), yaw: yawTo(ux, uz) });
  }
  if (pts.length < 5) throw new Error(`spawn ${name}: only ${pts.length} clear points`);
  return pts;
}
const face = spotOf(M.FACING ?? 'Mid Courtyard'), mid = face ? [face[0], face[face.length - 1]] : [0, 0];
const spawns = { attack: spawnRow(M.SPAWNS.attack, mid), defense: spawnRow(M.SPAWNS.defense, mid) };
const setups = {};
for (const [group, list] of Object.entries(M.SETUPS)) {
  setups[group] = list.map(([x, y, z, name]) => {
    const f = floorAt(x, z, y + 1.2);
    if (f === null || Math.abs(f - y) > 0.6) throw new Error(`setup ${name}: no floor near y=${y} (got ${f})`);
    return { name, x, y: f, z };
  });
}
const retake = {};
for (const [site, list] of Object.entries(M.RETAKE ?? {})) {
  retake[site] = list.map(([x, y, z, name]) => {
    const f = floorAt(x, z, y + 1.2);
    if (f === null || Math.abs(f - y) > 0.6) throw new Error(`retake ${name}: no floor near y=${y} (got ${f})`);
    return { name, x, y: f, z };
  });
}
// Attacker routes / plant spots (round mode R3): same floor check as the retake points.
const floored = ([x, y, z, name], what) => {
  const f = floorAt(x, z, y + 1.2);
  if (f === null || Math.abs(f - y) > 0.6) throw new Error(`${what} ${name}: no floor near y=${y} (got ${f})`);
  return { name, x, y: f, z };
};
let attack = null;
if (M.ATTACK) {
  attack = { routes: {}, plant: {} };
  for (const [site, list] of Object.entries(M.ATTACK.routes)) {
    attack.routes[site] = list.map((rt) => ({ name: rt.name, entry: floored(rt.entry, 'attack entry'), staging: rt.staging.map((p) => floored(p, 'attack staging')) }));
  }
  for (const [site, list] of Object.entries(M.ATTACK.plant)) attack.plant[site] = list.map((p) => floored(p, 'plant spot'));
}

// ---------------------------------------------------------------- seal check (real nav graph)
// Flood the baked nav graph from each team's 5 spawns with that team's barriers up (an edge is cut
// when its xz segment crosses a barrier and either end's floor is inside the barrier's y range),
// once over walk edges and once over all edges. A callout is reached when a node within 1 m of its
// spot (on the floor of the nearest node within 4 m) is reached. Any callout outside the team's own
// side reached = leak = failure, so is a SIDES callout off the graph or an own callout not reached
// over all edges (walk-only can miss some; listed). BARRIERS 'collision' maps get their barrier
// teams / ids / names from the same graph first (barrierTeams).
let sealReport = {};
if (!NAV) {
  console.error(`seal check: no ${path.relative(ROOT, NAV_FILE)}; write this file, run node tools/round_nav.mjs, then run this again`);
  process.exitCode = 1;
  for (const b of barriers) if (b.meta) b.id = `bar-${b.meta.prim}`;
} else {
  if (M.BARRIERS === 'collision') {
    const { list, errors } = barrierTeams(NAV, NAV_H, spawns, barriers);
    list.forEach((t, k) => {
      const b = barriers[k];
      Object.assign(b, { id: t.id, team: t.team, name: t.name });
      Object.assign(b.meta, { cutEdges: t.cut, votes: t.votes, inside: t.inside, conflict: t.conflict });
    });
    for (const e of errors) { console.error(e); process.exitCode = 1; }
  }
  const { report, errors } = sealCheck(NAV, NAV_H, spawns, barriers);
  sealReport = report;
  for (const e of errors) { console.error(e); process.exitCode = 1; }
}

// ---------------------------------------------------------------- optional picture checks
let picture = null;
if (IMAGE) {
  picture = decodePng(fs.readFileSync(IMAGE));
  // Majority colour within 6 px (labels are grey boxes drawn over the areas).
  const pxSide = (X, Y) => {
    if (X < 0 || Y < 0 || X >= picture.w || Y >= picture.h) return 'void';
    const o = (Y * picture.w + X) * 4, [r, g, b, a] = picture.data.subarray(o, o + 4);
    if (a < 128) return 'void';
    if (r > 235 && g > 235 && b > 235) return null; // label text
    if (r > g + 20 && r > b + 10) return 'defense';
    if (g > r + 20) return 'attack';
    return 'neutral';
  };
  const side = (x, z) => {
    const [u, v] = T.inv(x, z), n = {};
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      if (dx * dx + dy * dy > 36) continue;
      const k = pxSide(Math.round(u) + dx, Math.round(v) + dy); if (k) n[k] = (n[k] || 0) + 1;
    }
    return Object.entries(n).sort((p, q) => q[1] - p[1])[0]?.[0] ?? 'void';
  };
  const bad = [];
  for (const p of spawns.attack) if (side(p.x, p.z) !== 'attack') bad.push(`attacker spawn ${p.x},${p.z}: ${side(p.x, p.z)}`);
  for (const p of spawns.defense) if (side(p.x, p.z) !== 'defense') bad.push(`defender spawn ${p.x},${p.z}: ${side(p.x, p.z)}`);
  for (const list of Object.values(setups)) for (const p of list) if (side(p.x, p.z) !== 'defense') bad.push(`setup ${p.name}: ${side(p.x, p.z)}`);
  for (const s of sites) if (side(s.center.x, s.center.z) !== 'defense') bad.push(`site ${s.id}: ${side(s.center.x, s.center.z)}`);
  if (bad.length) { console.error('picture check failed:\n  ' + bad.join('\n  ')); process.exitCode = 1; }
  else console.log('picture check: spawns, setups and sites are on the right side');
}

// ---------------------------------------------------------------- output
const data = {
  schema: 1, map: MAP, name: M.name,
  // attack = the team that carries the spike. Both lists hold 5 points with the facing yaw.
  spawns,
  // Barrier phase walls: a team can't cross its own segments until the barriers drop.
  barriers: barriers.map(({ mark, shift, floors, meta, ...b }) => b),
  sites,
  setups: { defense: setups, splits: M.SPLITS },
  // Retake staging points per site (defender bots group here before retaking a planted site).
  retake,
  // Attacker bots (the player defends): routes per site (name, entry waypoint, staging points) and
  // plant spots per site. round-scene (R3 step S4) copies it into rules.round.attackData; header `attack` in
  // <map>.nav.bin holds the checks and the post-plant spots.
  ...(attack ? { attack } : {}),
  authoring: {
    tool: 'tools/round_author.mjs',
    ...(T ? { transform: {
      metresPerPx: r2(T.metresPerPx), rotationDeg: r2(T.rotationDeg), rmsM: r2(rms),
      residualsM: T.residuals, dropped: Object.fromEntries(dropped.map((k) => [k, first.residuals[k]])),
    } } : {}),
    ...(TERRAIN ? { world: 'terrain: rays against the pawn world of tools/round_terrain.mjs (the nav bake\'s triangles)' } : {}),
    ...(M.CALLOUT_SPOTS ? { calloutSpots: M.CALLOUT_SPOTS } : {}),
    ...(M.NOTES ? { notes: M.NOTES } : {}),
    barriers: Object.fromEntries(barriers.map((b) => [b.id, b.meta ?? { mark: b.mark, shiftM: b.shift, widthM: b.width, floors: b.floors }])),
    seal: sealReport,
  },
};
const text = JSON.stringify(data, null, 1) + '\n';
if (CHECK) {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (old !== text) { console.error(`${path.relative(ROOT, OUT)} is out of date: rerun node tools/round_author.mjs`); process.exit(1); }
  console.log(`${path.relative(ROOT, OUT)} is up to date`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}
if (T) console.log(`transform: ${T.metresPerPx.toFixed(3)} m/px, rotation ${T.rotationDeg.toFixed(1)} deg, rms ${rms.toFixed(2)} m over ${keys.length} callouts; dropped ${dropped.join(', ') || 'none'}`);
for (const b of barriers) {
  if (b.meta) console.log(`  ${String(b.id).padEnd(16)} ${String(b.team).padEnd(7)} ${String(b.name).padEnd(26)} (${b.a.x}, ${b.a.z})-(${b.b.x}, ${b.b.z}) plane ${b.meta.lengthM} m, floors ${b.meta.floors[0]}..${b.meta.floors[1]}, wall y ${b.y[0]}..${b.y[1]}, cut edges walk ${b.meta.cutEdges?.walk ?? '-'} / all ${b.meta.cutEdges?.all ?? '-'}, votes atk ${b.meta.votes?.attack.all ?? '-'} def ${b.meta.votes?.defense.all ?? '-'}, inside ${b.meta.inside ?? '-'}`);
  else console.log(`  ${b.id.padEnd(11)} ${b.name.padEnd(20)} width ${b.width.toFixed(2)} m, moved ${b.shift} m across, floors ${b.floors[0]}..${b.floors[1]}, wall y ${b.y[0]}..${b.y[1]}`);
}
for (const team of ['attack', 'defense']) {
  const r = sealReport[team]; if (!r) continue;
  console.log(`  seal ${team}: walk ${r.walk.nodes} / all edges ${r.all.nodes} nav nodes reached, leaks: ${r.leaks.join(', ') || 'none'}, own callouts not reached: ${r.unreached.join(', ') || 'none'} (walk only: ${r.walk.unreached.join(', ') || 'none'})`);
}
for (const s of sites) console.log(`  site ${s.id}: zone x ${s.zone[0][0]}..${s.zone[2][0]} z ${s.zone[0][1]}..${s.zone[2][1]}, floor ${s.y[0]}..${s.y[1]}`);
if (PLOT) {
  fs.writeFileSync(PLOT, plotSvg());
  console.log(`plot: ${PLOT} and ${plotPng()}`);
}
if (ATTACK_PLOT && NAV) {
  const g = NAV;
  if (!g.header.attack) { console.error('attack plot: the nav.bin header has no attack data; run node tools/round_nav.mjs --reuse'); process.exitCode = 1; }
  else console.log(`attack plot: ${attackPlot(g, data, g.header, ATTACK_PLOT, M.name.toUpperCase())}`);
}

// ---------------------------------------------------------------- plot
function plotSvg() {
  // world box = the callouts +-15 m; screen: right = -z, down = +x (like the picture)
  const pts = Object.keys(CAL).map(spotOf).filter(Boolean).map((p) => [p[0], p[p.length - 1]]);
  const S = 6, x0 = Math.floor(Math.min(...pts.map((p) => p[0])) - 15), x1 = Math.ceil(Math.max(...pts.map((p) => p[0])) + 15), z0 = Math.floor(Math.min(...pts.map((p) => p[1])) - 15), z1 = Math.ceil(Math.max(...pts.map((p) => p[1])) + 15);
  const W = (z1 - z0) * S, H = (x1 - x0) * S;
  const P = (x, z) => [((z1 - z) * S).toFixed(1), ((x - x0) * S).toFixed(1)];
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif" font-size="11">`, `<rect width="${W}" height="${H}" fill="#101418"/>`];
  if (picture) {
    // Picture px -> screen: world = T.f(px); screen = P(world). Both are similarities, so one matrix.
    const o = P(...T.f(0, 0)).map(Number), ex = P(...T.f(1, 0)).map(Number), ey = P(...T.f(0, 1)).map(Number);
    const png = encodePng(picture);
    out.push(`<image href="data:image/png;base64,${png.toString('base64')}" width="${picture.w}" height="${picture.h}" opacity="0.45" transform="matrix(${ex[0] - o[0]} ${ex[1] - o[1]} ${ey[0] - o[0]} ${ey[1] - o[1]} ${o[0]} ${o[1]})"/>`);
  }
  const ys = nav.flat().map((v) => v[1]); const ylo = Math.min(...ys), yhi = Math.max(...ys);
  for (const t of nav) {
    const y = (t[0][1] + t[1][1] + t[2][1]) / 3, k = (y - ylo) / (yhi - ylo || 1);
    const c = `rgb(${Math.round(60 + 120 * k)},${Math.round(70 + 110 * k)},${Math.round(90 + 60 * k)})`;
    out.push(`<polygon points="${t.map((v) => P(v[0], v[2]).join(',')).join(' ')}" fill="${c}" stroke="${c}" stroke-width="0.4"/>`);
  }
  for (const s of sites) {
    out.push(`<polygon points="${s.zone.map(([x, z]) => P(x, z).join(',')).join(' ')}" fill="rgba(255,190,40,0.25)" stroke="#ffbe28" stroke-width="2"/>`);
    const [sx, sy] = P(s.center.x, s.center.z); out.push(`<text x="${sx}" y="${sy}" fill="#ffbe28" font-size="22" text-anchor="middle">${s.id}</text>`);
  }
  for (const b of barriers) {
    const col = b.team === 'defense' ? '#ff4655' : '#20e0b4';
    const [ax, ay] = P(b.a.x, b.a.z), [bx, by] = P(b.b.x, b.b.z);
    out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${col}" stroke-width="4"/>`);
    if (b.mark) { const [mx, my] = P(b.mark.world.x, b.mark.world.z); out.push(`<circle cx="${mx}" cy="${my}" r="3" fill="none" stroke="#fff"/>`); }
    out.push(`<text x="${(+ax + +bx) / 2 + 6}" y="${(+ay + +by) / 2 - 6}" fill="${col}">${b.id} ${b.width.toFixed(1)}m</text>`);
  }
  for (const [team, list] of Object.entries(spawns)) for (const p of list) {
    const [x, y] = P(p.x, p.z); const col = team === 'attack' ? '#20e0b4' : '#ff4655';
    const [fx, fy] = P(p.x - Math.sin(p.yaw) * 2, p.z - Math.cos(p.yaw) * 2);
    out.push(`<circle cx="${x}" cy="${y}" r="4" fill="${col}"/><line x1="${x}" y1="${y}" x2="${fx}" y2="${fy}" stroke="${col}"/>`);
  }
  for (const [group, list] of Object.entries(setups)) for (const p of list) {
    const [x, y] = P(p.x, p.z);
    out.push(`<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="#ff8a00" stroke="#000"/><text x="${+x + 6}" y="${+y + 4}" fill="#ffd9a8" font-size="9">${group}: ${p.name}</text>`);
  }
  for (const c of mini.callouts) { const [x, y] = P(c.x, c.z); out.push(`<text x="${x}" y="${y}" fill="rgba(255,255,255,0.5)" font-size="9" text-anchor="middle">${Object.keys(CAL).find((k) => CAL[k] === c.name) ?? ''}</text>`); }
  out.push(`<text x="8" y="16" fill="#fff">${M.name} round data — navmesh floor (dark = low), barriers red = defender / teal = attacker (white ring = picture mark), yellow = plant zones, dots = spawns, orange = defender setups</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// Labelled top-down PNG (x right, z down; box = the callouts +-15 m): nav graph floor from the
// nav.bin (shaded by height), plant zones (yellow box = zone used by the round, orange = the map's
// site marker outline), barriers (red defender / teal attacker, id at the middle), spawns with facing,
// setups (orange), retake points (blue), callout names (CALLOUT_SPOTS overrides ringed, with a line
// from the minimap spot). With --image the picture is blended underneath (Ascent).
function plotPng() {
  const pts = Object.keys(CAL).map(spotOf).filter(Boolean).map((p) => [p[0], p[p.length - 1]]);
  const S = 6, x0 = Math.floor(Math.min(...pts.map((p) => p[0])) - 15), x1 = Math.ceil(Math.max(...pts.map((p) => p[0])) + 15);
  const z0 = Math.floor(Math.min(...pts.map((p) => p[1])) - 15), z1 = Math.ceil(Math.max(...pts.map((p) => p[1])) + 15), TOP = 44;
  const W = (x1 - x0) * S, Hh = (z1 - z0) * S + TOP, im = new Img(W, Hh, [16, 20, 24]);
  const px = (x) => (x - x0) * S, pz = (z) => (z - z0) * S + TOP;
  if (picture) {
    for (let Y = TOP; Y < Hh; Y++) for (let X = 0; X < W; X++) {
      const [u, v] = T.inv(X / S + x0, (Y - TOP) / S + z0), U = Math.round(u), V = Math.round(v);
      if (U < 0 || V < 0 || U >= picture.w || V >= picture.h) continue;
      const o = (V * picture.w + U) * 4; if (picture.data[o + 3] < 128) continue;
      const q = (Y * W + X) * 3; for (let k = 0; k < 3; k++) im.p[q + k] = Math.round(im.p[q + k] * 0.55 + picture.data[o + k] * 0.45);
    }
  }
  if (NAV) {
    const g = NAV, ys = Array.from(g.y), ylo = Math.min(...ys), yhi = Math.max(...ys);
    const order = [...Array(g.count).keys()].sort((a, b) => g.y[a] - g.y[b]);
    for (const i of order) { const k = (g.y[i] - ylo) / (yhi - ylo || 1); im.rect(px(g.x[i]), pz(g.z[i]), 3, [Math.round(50 + 110 * k), Math.round(58 + 105 * k), Math.round(70 + 70 * k)]); }
  }
  for (const s of sites) {
    for (const t of zoneTris[s.id] ?? []) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; im.line(px(a[0]), pz(a[2]), px(b[0]), pz(b[2]), [255, 140, 40], 1); }
    const z = s.zone; for (let k = 0; k < z.length; k++) { const q = z[(k + 1) % z.length]; im.line(px(z[k][0]), pz(z[k][1]), px(q[0]), pz(q[1]), [255, 210, 40], 2); }
    im.label(px(s.center.x) - 6, pz(s.center.z) - 8, s.id, [255, 210, 40], 4);
  }
  for (const c of Object.keys(CAL)) {
    const p = spotOf(c); if (!p) continue;
    const X = px(p[0]), Z = pz(p[p.length - 1]);
    if (M.CALLOUT_SPOTS?.[c]) { const o = callout[CAL[c]]; if (o) { im.line(px(o[0]), pz(o[1]), X, Z, [150, 150, 150], 1); im.rect(px(o[0]), pz(o[1]), 5, [150, 150, 150]); } im.circle(X, Z, 6, [230, 230, 230], 1); }
    im.rect(X, Z, 3, [230, 230, 230]);
    im.label(X - c.length * 4, Z + 6, c, [215, 215, 215], 2);
  }
  for (const b of barriers) {
    const col = b.team === 'defense' ? [255, 70, 85] : b.team === 'attack' ? [32, 224, 180] : [255, 255, 255];
    im.line(px(b.a.x), pz(b.a.z), px(b.b.x), pz(b.b.z), col, 3);
    if (b.mark) im.circle(px(b.mark.world.x), pz(b.mark.world.z), 3, [255, 255, 255], 1);
    im.label((px(b.a.x) + px(b.b.x)) / 2 + 6, (pz(b.a.z) + pz(b.b.z)) / 2 - 12, String(b.id), col, 2);
  }
  for (const [team, list] of Object.entries(spawns)) for (const p of list) {
    const c = team === 'attack' ? [32, 224, 180] : [255, 70, 85];
    im.circle(px(p.x), pz(p.z), 4, c, 2); im.line(px(p.x), pz(p.z), px(p.x - Math.sin(p.yaw) * 2.5), pz(p.z - Math.cos(p.yaw) * 2.5), c, 1);
  }
  for (const [group, list] of Object.entries(setups)) for (const p of list) {
    im.rect(px(p.x), pz(p.z), 9, [0, 0, 0]); im.rect(px(p.x), pz(p.z), 7, [255, 138, 0]);
    im.label(px(p.x) + 7, pz(p.z) - 4, p.name, [255, 200, 140], 2);
  }
  for (const [site, list] of Object.entries(retake)) for (const p of list) {
    im.rect(px(p.x), pz(p.z), 9, [0, 0, 0]); im.rect(px(p.x), pz(p.z), 7, [80, 200, 255]);
    im.label(px(p.x) + 7, pz(p.z) - 4, `RETAKE ${p.name}`, [150, 220, 255], 2);
  }
  [`${M.name} ROUND DATA. X RIGHT Z DOWN. GREY NAV FLOOR (LIGHT = HIGH). YELLOW PLANT ZONE, ORANGE SITE MARKER.`,
    'BARRIERS RED DEFENDER, TEAL ATTACKER. RINGS = SPAWNS (TEAL ATK, RED DEF).',
    'ORANGE = SETUPS, BLUE = RETAKE. RINGED CALLOUT = MOVED SPOT (GREY = MINIMAP SPOT).'].forEach((t, k) => im.text(6, 4 + k * 13, t, [255, 255, 255], 2));
  const file = PLOT.replace(/[.]svg$/i, '') + '.png';
  im.save(file);
  return file;
}

// ---------------------------------------------------------------- tiny PNG codec (8-bit RGB/RGBA)
function decodePng(buf) {
  let p = 8, w, h, ct, bd, il; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; il = d[12]; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6) || il) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, not interlaced)');
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, up = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < bpp ? line[x * bpp + k] : 255;
    prev = line;
  }
  return { w, h, data: out };
}
function encodePng({ w, h, data }) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
