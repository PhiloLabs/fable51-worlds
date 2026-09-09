import * as THREE from 'three';
import { Engine } from './core/engine';
import { Input } from './core/input';
import { audio } from './core/audio';
import { clamp, damp, lerp, smoothstep } from './core/mathx';
import { DS_RADIUS, PORT_S, portPosition, trenchRadial, trenchToWorld, worldToTrench, MERIDIAN_CORRIDOR_S0, MERIDIAN_CORRIDOR_S1, TRENCH_DEPTH } from './core/constants';

import { createSpaceEnv } from './world/space';
import { centreAt, floorAt, halfWidthAt } from './world/trench';
import { surfacePoint } from './world/deathstar';
import { FX } from './fx/fx';
import { createDestruction } from './fx/destruction';
import { createTorpedoVisual } from './shaders/torpedo';
import { createHUD } from './game/hud';
import { PlayerShip } from './game/flight';
import { Director } from './camera/director';
import { buildShots } from './camera/shots';
import { Sequence } from './game/sequence';
import type { World, Wingman, TorpedoRun } from './game/world';

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const bootbar = document.getElementById('bootbar') as HTMLElement;
const bootstatus = document.getElementById('bootstatus') as HTMLElement;
const bootEl = document.getElementById('boot') as HTMLElement;
const btnPlay = document.getElementById('btn-play') as HTMLButtonElement;
const btnCine = document.getElementById('btn-cine') as HTMLButtonElement;

async function progress(p: number, label: string) {
  bootbar.style.width = `${Math.round(p * 100)}%`;
  bootstatus.textContent = label;
  await raf();
}

const params = new URLSearchParams(location.search);

export interface Factories {
  createXWing: (opts?: any) => any;
  createDeathStar: (opts?: any) => any;
  createTrench: (opts?: any) => any;
  createTIESquadron: (scene: THREE.Scene, opts?: any) => any;
}

export async function boot(F: Factories) {
  const { createXWing, createDeathStar, createTrench, createTIESquadron } = F;
  const container = document.getElementById('app')!;
  const engine = new Engine(container);
  const scene = engine.scene;
  const camera = engine.camera;
  const input = new Input();

  await progress(0.05, 'GENERATING STARFIELD…');
  const space = createSpaceEnv({ seed: 7 });
  scene.add(space.group);
  scene.add(space.sun);
  scene.add(space.sun.target);
  scene.add(space.fill);
  const ambient = new THREE.AmbientLight(0x223448, 0.18);
  scene.add(ambient);
  space.sun.intensity = 3.1;
  space.fill.intensity = 0.26;

  await progress(0.16, 'BUILDING BATTLE STATION…');
  const deathStar = createDeathStar({ seed: 42 });
  scene.add(deathStar.group);

  /** Integration-level art direction: the station hull reads too light against
   *  black space, so knock the albedo back and add roughness contrast. */
  function gradeHull(mats: THREE.Material[], k = 0.68, emisK = 1) {
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.isMeshStandardMaterial && sm.color) {
        sm.color.multiplyScalar(k);
        sm.roughness = Math.min(1, sm.roughness * 1.08 + 0.04);
      }
      const u = (m as any).userData?.uniforms;
      if (u && emisK !== 1) {
        if (u.uWindow) u.uWindow.value *= emisK;
        if (u.uEmisStr) u.uEmisStr.value *= emisK;
      }
    }
  }
  gradeHull(deathStar.materials, 0.86, 0.45);

  await progress(0.46, 'CARVING THE TRENCH…');
  /**
   * The shell has a hole cut for the trench corridor, and the trench itself is
   * only streamed near the player — so from orbit you would see straight through
   * the station. This ribbon fills the corridor with a cheap trench-shaped
   * proxy, using the same shell material so it is seamless, and is swapped out
   * the moment the real trench streams in.
   */
  function buildCorridorCap(mat: THREE.Material) {
    const cols = [-1250, -900, -560, -300, -140, -63, -62.5, -34, 0, 34, 62.5, 63, 140, 300, 560, 900, 1250];
    const ups = cols.map((z) => (Math.abs(z) < 62.8 ? -TRENCH_DEPTH : 0));
    const N = 150;
    const s0 = MERIDIAN_CORRIDOR_S0 - 40, s1 = MERIDIAN_CORRIDOR_S1 + 40;
    const pos = new Float32Array((N + 1) * cols.length * 3);
    const dir = new THREE.Vector3(), sp = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i <= N; i++) {
      const sArc = s0 + (s1 - s0) * (i / N);
      for (let j = 0; j < cols.length; j++) {
        trenchToWorld(sArc, cols[j], 0, dir).normalize();
        surfacePoint(dir.x, dir.y, dir.z, sp);
        const r = sp.length() + ups[j];
        pos[k++] = dir.x * r; pos[k++] = dir.y * r; pos[k++] = dir.z * r;
      }
    }
    // pick the winding that faces outward — a flipped ribbon would be culled
    const W = cols.length;
    const va = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const vb = new THREE.Vector3(pos[3], pos[4], pos[5]);
    const vc = new THREE.Vector3(pos[W * 3], pos[W * 3 + 1], pos[W * 3 + 2]);
    const outward = vb.clone().sub(va).cross(vc.clone().sub(va)).dot(va) > 0;
    const idx: number[] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < W - 1; j++) {
        const a = i * W + j, b = a + 1, c = a + W, d = c + 1;
        if (outward) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const n = pos.length / 3;
    g.setAttribute('aEmis', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('aRegion', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    const m = new THREE.Mesh(g, mat);
    m.name = 'corridor-cap';
    m.frustumCulled = false;
    return m;
  }
  const corridorCap = buildCorridorCap(deathStar.materials[0]);
  deathStar.group.add(corridorCap);

  const trench = createTrench({ seed: 1977 });
  gradeHull(trench.materials, 0.92, 0.95);
  scene.add(trench.group);

  await progress(0.68, 'ASSEMBLING RED FIVE…');
  const xwing = createXWing({ seed: 5, detail: 'hero', redFive: true });
  scene.add(xwing.group);

  await progress(0.78, 'LAUNCHING SQUADRON…');
  const wingNames = ['Red Two', 'Red Three', 'Red Six'];
  const wingOffsets = [
    new THREE.Vector3(-26, -2.5, 22),
    new THREE.Vector3(28, 1.8, 26),
    new THREE.Vector3(-6, 5.5, 44),
  ];
  const wingmen: Wingman[] = [];
  for (let i = 0; i < 3; i++) {
    const craft = createXWing({ seed: 11 + i * 7, detail: 'lod', redFive: false, markingColor: [0xd0402a, 0xd8781e, 0xb43a58][i] });
    scene.add(craft.group);
    craft.setSFoil(0);
    wingmen.push({
      craft, obj: craft.group, offset: wingOffsets[i],
      pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
      alive: true, name: wingNames[i], dieAt: -1, inTrench: false, wobble: i * 3.1,
    });
  }

  await progress(0.86, 'SPOOLING WEAPONS…');
  const fx = new FX(scene);
  const destruction = createDestruction(scene);
  const ties = createTIESquadron(scene, { seed: 3, max: 20 });

  const torpedoes: TorpedoRun[] = [];
  for (let i = 0; i < 2; i++) {
    const visual = createTorpedoVisual({ scale: 1 });
    visual.object.visible = false;
    scene.add(visual.object);
    torpedoes.push({
      visual, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      curve: null, t: 0, duration: 5, alive: false, entered: false, delay: 0,
    });
  }

  await progress(0.94, 'CALIBRATING TARGETING COMPUTER…');
  const hud = createHUD(document.getElementById('hud')!);
  const ship = new PlayerShip();
  ship.profile = { centre: centreAt, floor: floorAt, halfWidth: halfWidthAt };
  const director = new Director(camera);

  const world: World = {
    engine, scene, camera, input, ship, director,
    hud, fx, destruction, space, deathStar, trench, ties, xwing, wingmen,
    shipObj: xwing.group,
    portPos: portPosition(new THREE.Vector3()),
    stationCenter: new THREE.Vector3(0, 0, 0),
    torpedoes,
    focus: null, focusDist: Infinity,
    phase: 'title', phaseTime: 0, seqTime: 0,
    cinematic: true, interactive: false,
    trenchProgress: 0, lockProgress: 0, locked: false, destroyed: false,
  };

  director.setShots(buildShots(world));
  const sequence = new Sequence(world);
  fx.hitTest = sequence.makeHitTest();

  // wingmen are picked off during the trench run
  wingmen[1].dieAt = -1;

  await progress(1.0, 'READY');

  // ---------------------------------------------------------------- runtime
  const _v = new THREE.Vector3();
  const _tc = { s: 0, lateral: 0, up: 0 };
  let statsOn = params.has('stats');
  hud.showStats(statsOn);
  hud.setVisible(false);

  let started = false;
  let hidden = false;

  function step(dt: number, time: number) {
    if (!started) {
      // idle: slow orbit of the station so the title screen is alive
      const a = time * 0.02;
      camera.position.set(Math.cos(a) * 210000, 62000, Math.sin(a) * 210000);
      camera.lookAt(0, 0, 0);
      space.update(dt, time, camera);
      deathStar.update(dt, time, camera);
      engine.post.u.uSpeedBlur.value = 0;
      return;
    }

    sequence.update(dt, time);

    // --- wingmen death scheduling based on trench progress ---
    if (world.phase === 'trench') {
      if (world.trenchProgress > 0.34 && wingmen[0].alive && wingmen[0].dieAt < 0) wingmen[0].dieAt = world.seqTime + 0.1;
      if (world.trenchProgress > 0.62 && wingmen[2].alive && wingmen[2].dieAt < 0) wingmen[2].dieAt = world.seqTime + 0.1;
    }

    // --- streaming systems ---
    worldToTrench(camera.position, _tc);
    const altitude = _tc.up;
    if (!world.destroyed || !destruction.stationHidden) {
      deathStar.update(dt, time, camera);
      const nearTrench = altitude < 26000 && _tc.s > -9000 && _tc.s < 34000;
      if (trench.group.visible !== nearTrench) {
        trench.group.visible = nearTrench;
        corridorCap.visible = !nearTrench;
      }
      if (nearTrench) trench.update(dt, time, world.phase === 'trench' || world.phase === 'targeting' || world.phase === 'torpedo' ? ship.s : _tc.s, camera);
    }
    space.update(dt, time, camera);
    fx.update(dt, time, camera);
    destruction.update(dt, time, camera);

    // --- destruction feedback into the world ---
    if (destruction.active) {
      deathStar.setDamage(destruction.hullDamage);
      trench.setDamage(destruction.hullDamage);
      if (destruction.stationHidden && !hidden) {
        hidden = true;
        deathStar.setVisible(false);
        trench.group.visible = false;
        for (const wm of wingmen) if (!wm.alive) wm.obj.visible = false;
      }
      director.shake.add(destruction.shake * dt * 2.2);
      // the fireball fills the frame — pull exposure and bloom back so it keeps
      // internal structure instead of clipping to a white card
      const de = destruction.elapsed as number;
      const peak = smoothstep(3.0, 5.4, de) * (1 - smoothstep(11.0, 21.0, de));
      engine.post.bloom.strength = lerp(0.58 + destruction.bloomBoost * 0.4, 0.3, peak);
      engine.post.u.uFlash.value = destruction.flash * 0.9;
      engine.renderer.toneMappingExposure = lerp(0.92, 0.28, Math.max(peak, clamp(destruction.flash * 1.1, 0, 1)));
    } else {
      engine.post.u.uFlash.value = damp(engine.post.u.uFlash.value, ship.hitFlash * 0.28, 6, dt);
      engine.post.bloom.strength = 0.58;
    }

    // --- camera ---
    director.update(world.seqTime, dt, world);

    // --- post: speed blur + grade ---
    // speed blur only where the camera itself is racing past nearby geometry
    const spd = ship.speed;
    const p = world.phase;
    const blurPhase = p === 'trench' || p === 'targeting' || p === 'torpedo';
    const wantBlur = blurPhase
      ? clamp((spd - 300) / 420, 0, 1) * 0.62 + (ship.boosting ? 0.3 : 0)
      : (p === 'entry' || p === 'dive') ? 0.11 : 0;
    engine.post.u.uSpeedBlur.value = damp(engine.post.u.uSpeedBlur.value, clamp(wantBlur, 0, 1.1), 4, dt);
    engine.post.u.uDesat.value = damp(engine.post.u.uDesat.value, world.phase === 'end' ? 0.15 : 0, 1, dt);

    hud.update(dt, time);
    if (statsOn) {
      const info = engine.renderer.info;
      hud.setStats(engine.fps, info.render.calls, info.render.triangles, dt * 1000);
    }
    input.endFrame();
  }

  engine.onUpdate = step;
  engine.start();

  // ---------------------------------------------------------------- controls
  function begin(interactive: boolean) {
    if (started) return;
    started = true;
    audio.init(); audio.resume();
    bootEl.classList.add('gone');
    setTimeout(() => (bootEl.style.display = 'none'), 950);
    hud.setVisible(true);
    sequence.start(interactive);
  }
  btnPlay.disabled = false; btnCine.disabled = false;
  btnPlay.onclick = () => begin(true);
  btnCine.onclick = () => begin(false);

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyP') engine.paused = !engine.paused;
    if (e.code === 'KeyC' && started) {
      world.interactive = !world.interactive;
      world.cinematic = !world.interactive;
      ship.autopilot = !world.interactive;
      hud.radio('BASE', world.interactive ? 'Manual control.' : 'Autopilot engaged.');
    }
    if (e.code === 'F3') { statsOn = !statsOn; hud.showStats(statsOn); }
    if (e.code === 'Enter' && !started) begin(true);
  });

  // ---------------------------------------------------------------- QA hooks
  (window as any).__demo = {
    ready: true,
    engine, world, sequence, director, ship, hud,
    start: (interactive = false) => begin(interactive),
    /** deterministically fast-forward the sequence to an absolute time */
    async seek(target: number, dtStep = 1 / 30) {
      if (!started) begin(false);
      engine.paused = true;
      let guard = 0;
      while (sequence.time < target && guard++ < 20000) {
        engine.renderer.info.reset();
        step(dtStep, sequence.time);
      }
      engine.post.update(dtStep, sequence.time);
      engine.post.render(dtStep);
      return sequence.time;
    },
    render() { engine.post.render(1 / 60); },
    /** free-camera inspection for geometry QA */
    inspect(px: number, py: number, pz: number, tx = 0, ty = 0, tz = 0, fov = 45) {
      director.manual = true;
      camera.position.set(px, py, pz);
      camera.lookAt(tx, ty, tz);
      camera.fov = fov; camera.updateProjectionMatrix();
      deathStar.update(1 / 60, sequence.time, camera);
      const tcx = worldToTrench(camera.position, { s: 0, lateral: 0, up: 0 });
      trench.group.visible = tcx.up < 26000 && tcx.s > -9000 && tcx.s < 34000;
      if (trench.group.visible) trench.update(1 / 60, sequence.time, tcx.s, camera);
      space.update(1 / 60, sequence.time, camera);
      engine.post.render(1 / 60);
      return { calls: engine.renderer.info.render.calls, tris: engine.renderer.info.render.triangles };
    },
    /** camera placed in trench coordinates, looking along the trench */
    inspectTrench(s: number, lateral: number, up: number, ds = 300, dlat = 0, dup = 0, fov = 60) {
      const p = trenchToWorld(s, lateral, up, new THREE.Vector3());
      const t = trenchToWorld(s + ds, lateral + dlat, up + dup, new THREE.Vector3());
      return (window as any).__demo.inspect(p.x, p.y, p.z, t.x, t.y, t.z, fov);
    },
    /** orbit the hero X-wing at a given radius */
    inspectShip(radius = 26, az = 0.7, el = 0.25, fov = 40) {
      const p = new THREE.Vector3(
        Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)
      ).multiplyScalar(radius).applyQuaternion(ship.quaternion).add(ship.position);
      return (window as any).__demo.inspect(p.x, p.y, p.z, ship.position.x, ship.position.y, ship.position.z, fov);
    },
    release() { director.manual = false; },
    resume() { engine.paused = false; },
    state: () => ({
      t: sequence.time, phase: world.phase, shot: director.currentShotName,
      s: ship.s, speed: ship.speed, calls: engine.renderer.info.render.calls,
      tris: engine.renderer.info.render.triangles, fps: engine.fps,
    }),
  };

  if (params.has('auto')) begin(params.get('auto') === 'play');
}

export function reportBootError(err: any) {
  console.error(err);
  bootstatus.textContent = 'ERROR: ' + (err?.message ?? err);
  bootstatus.style.color = '#ff6a4a';
}
