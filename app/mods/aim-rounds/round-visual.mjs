// Round mode 3D bits in the game scene: translucent barrier walls (until the barriers drop) and
// the spike prop (plain three.js shapes, red light that blinks faster in the last 10 s; a flash
// when it goes off). Created by the play page (tools/round_patch.py) with the game's own three.js
// classes passed in, updated every frame from snapshot().round, disposed when the run ends.
export function createRoundVisual(THREE, scene, cfg) {
  const { Mesh, Group, PlaneGeometry, SphereGeometry, BoxGeometry, CylinderGeometry, MeshBasicMaterial, DoubleSide } = THREE;
  const owned = [];
  const mat = (o) => { const m = new MeshBasicMaterial({ fog: false, ...o }); owned.push(m); return m; };
  const geo = (g) => { owned.push(g); return g; };
  const root = new Group();
  root.name = 'aim-round';

  // Barrier walls.
  const walls = new Group();
  const wallMat = {
    attack: mat({ color: 0x20e0b4, transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false }),
    defense: mat({ color: 0xff4655, transparent: true, opacity: 0.22, side: DoubleSide, depthWrite: false }),
  };
  const edgeMat = {
    attack: mat({ color: 0x20e0b4, transparent: true, opacity: 0.7, side: DoubleSide, depthWrite: false }),
    defense: mat({ color: 0xff4655, transparent: true, opacity: 0.7, side: DoubleSide, depthWrite: false }),
  };
  for (const b of cfg?.barriers ?? []) {
    const dx = b.b.x - b.a.x, dz = b.b.z - b.a.z, len = Math.hypot(dx, dz);
    if (!(len > 0.05)) continue;
    const y0 = b.y?.[0] ?? 0, y1 = b.y?.[1] ?? y0 + 5, h = y1 - y0;
    const team = b.team === 'defense' ? 'defense' : 'attack';
    const wall = new Mesh(geo(new PlaneGeometry(len, h)), wallMat[team]);
    wall.position.set((b.a.x + b.b.x) / 2, y0 + h / 2, (b.a.z + b.b.z) / 2);
    wall.rotation.y = Math.atan2(-dz, dx);
    wall.renderOrder = 5;
    walls.add(wall);
    // Bright bands at floor height and 2.2 m, so the wall reads as a wall up close.
    for (const at of [0.6, 2.8]) {
      const band = new Mesh(geo(new PlaneGeometry(len, 0.08)), edgeMat[team]);
      band.position.set(wall.position.x, y0 + at, wall.position.z);
      band.rotation.y = wall.rotation.y;
      band.renderOrder = 6;
      walls.add(band);
    }
  }
  root.add(walls);

  // Spike prop: dark body, grey cap, red light + glow.
  const spike = new Group();
  const body = new Mesh(geo(new BoxGeometry(0.34, 0.14, 0.24)), mat({ color: 0x24272c }));
  body.position.y = 0.07;
  const plate = new Mesh(geo(new BoxGeometry(0.26, 0.02, 0.16)), mat({ color: 0x3c424a }));
  plate.position.y = 0.15;
  const cap = new Mesh(geo(new CylinderGeometry(0.05, 0.06, 0.1, 16)), mat({ color: 0x8a9099 }));
  cap.position.set(0.08, 0.2, 0);
  const lightMat = mat({ color: 0xff2a2a });
  const light = new Mesh(geo(new SphereGeometry(0.035, 12, 8)), lightMat);
  light.position.set(-0.08, 0.18, 0);
  const glowMat = mat({ color: 0xff3030, transparent: true, opacity: 0.35, depthWrite: false });
  const glow = new Mesh(geo(new SphereGeometry(0.16, 16, 12)), glowMat);
  glow.position.copy(light.position);
  spike.add(body, plate, cap, light, glow);
  spike.visible = false;
  root.add(spike);

  // Detonation flash: drawn over everything (no depth test, last in order) so walls between you and
  // the spike don't hide it. Starts at half opacity because round-hud.js also flashes the screen.
  const blastMat = mat({ color: 0xffa040, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false, side: DoubleSide });
  const blast = new Mesh(geo(new SphereGeometry(1, 32, 16)), blastMat);
  blast.renderOrder = 999;
  blast.visible = false;
  root.add(blast);
  let blastAt = null;

  scene.add(root);
  root.updateMatrixWorld(true);

  return {
    update(view, now) {
      if (!view) return;
      walls.visible = view.phase === 'barrier';
      const s = view.spike ?? {};
      const at = s.planted ?? s.dropped ?? null;
      spike.visible = !!at && !(view.reason === 'detonated' && blastAt !== null && now - blastAt > 0.2);
      if (at) spike.position.set(at.x, at.y, at.z);
      if (s.planted && view.phase === 'planted') {
        const period = view.timeLeft <= 10 ? 0.25 : 1;
        const on = (now % period) < period * 0.35;
        light.visible = glow.visible = on;
      } else if (s.planted && view.reason === 'defused') {
        light.visible = glow.visible = false;
      } else light.visible = glow.visible = !!s.planted;
      if (view.reason === 'detonated' && s.planted) {
        if (blastAt === null) blastAt = now;
        // Grows to the 35 m blast radius in 0.8 s (ease-out); fades over 1.4 s, most of it early.
        const t = now - blastAt;
        const g = Math.min(1, t / 0.8), k = Math.min(1, t / 1.4);
        blast.visible = k < 1;
        blast.position.set(s.planted.x, s.planted.y, s.planted.z);
        blast.scale.setScalar(1 + 34 * (1 - (1 - g) ** 3));
        blastMat.opacity = 0.5 * (1 - k) ** 2;
      } else { blast.visible = false; blastAt = null; }
      root.updateMatrixWorld(true);
    },
    dispose() {
      scene.remove(root);
      for (const o of owned) try { o.dispose(); } catch {}
    },
  };
}
