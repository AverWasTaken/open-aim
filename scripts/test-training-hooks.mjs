// tools/training_launch_patch.py: the lobby hooks the training shell scripts (routines, progress)
// rely on must be present in both copies of ChJ6FlD4.js, and the copies must stay identical.
// Run: node --test scripts/test-training-hooks.mjs   (npm run test:training-hooks in app/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPIES = [
  path.join(ROOT, 'app', 'mods', 'next', 'js', 'ChJ6FlD4.js'),
  path.join(ROOT, 'app', 'mods', '_assets', 'r20261021-1', 'next', 'js', 'ChJ6FlD4.js'),
];
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('both ChJ6FlD4.js copies are identical', () => {
  assert.equal(read(COPIES[0]), read(COPIES[1]));
});

test('launch/leave hooks are patched in once, right after the layer exit wiring', () => {
  for (const p of COPIES) {
    const s = read(p);
    const anchor = 'const yt=G7();yt.setExit(di);';
    assert.equal(s.split(anchor).length - 1, 1, `${p}: anchor count`);
    const after = s.slice(s.indexOf(anchor) + anchor.length);
    assert.ok(after.startsWith('window.__aimLaunchWorkshop=function(R){'), `${p}: launch hook missing (re-run tools/training_launch_patch.py)`);
    assert.equal(s.split('window.__aimLaunchWorkshop=').length - 1, 1, `${p}: launch hook count`);
    assert.equal(s.split('window.__aimLeaveTraining=function(){').length - 1, 1, `${p}: leave hook count`);
    // launch refuses while a drill is open or loading, completes the item from the catalogue
    assert.ok(after.includes('l.value||yt.view.open)return!1;'), `${p}: launch guard`);
    assert.ok(after.includes('si(R.shareCode,R)'), `${p}: catalogue lookup`);
    // the lobby's own launch path is used (rank picker gate, workshop brief)
    assert.ok(/window\.__aimLaunchWorkshop=function\(R\)\{[^}]*\}[^}]*\}[^]*?wl\(/.test(after.slice(0, 600)), `${p}: launches via wl()`);
    assert.ok(after.includes('if(!l.value&&!yt.view.open)return!1;di();return!0};'), `${p}: leave via di()`);
    // the round team's plaza launcher stays untouched
    assert.ok(s.includes('window.__aimLaunchScene=function(o){'), `${p}: __aimLaunchScene still there`);
  }
});
