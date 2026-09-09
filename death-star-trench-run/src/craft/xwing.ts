import * as THREE from 'three';
import { RNG } from '../core/rng';
import { clamp, damp, DEG } from '../core/mathx';
import { XWING_LEN } from '../core/constants';
import {
  buildXWingGeometry, createShipMaterial, createGlassMaterial, createPlumeMaterial,
  createGlowMaterial, makeShipUniforms, makePlumeUniforms, buildExhaustGeometry,
  buildGlowGeometry, mergeAll, triCount, COCKPIT_EYE, DOME_ORIGIN,
  WING_PIVOT, WING_SX, WING_SY,
} from './xwingParts';

/* =========================================================================
   T-65 X-WING
   Procedural hero starfighter. Nose along -Z, up +Y, right +X, origin at the
   centre of mass.

   The four s-foils and the astromech dome are animated entirely in the vertex
   shader (see xwingParts VS_BEGIN), which lets the whole ship — fuselage,
   wings, cannons, nacelles, hinges, 80+ greebles — collapse into three merged
   draw calls that still articulate.  Four bodiless Object3D pivots mirror the
   shader transform on the CPU so muzzle / bell / tube points stay exact.
   ========================================================================= */

export interface XWing {
  group: THREE.Group;
  sfoil: number;
  sfoilTarget: number;
  throttle: number;
  damage: number;
  length: number;
  cockpitEye: THREE.Vector3;
  materials: THREE.Material[];
  getCannonTip(i: number, out: THREE.Vector3): THREE.Vector3;
  getEngineTip(i: number, out: THREE.Vector3): THREE.Vector3;
  getTorpedoTube(i: number, out: THREE.Vector3): THREE.Vector3;
  setSFoil(t: number): void;
  update(dt: number, time: number, camera: THREE.Camera): void;
  dispose(): void;
}

export interface XWingOptions {
  seed?: number;
  detail?: 'hero' | 'lod';
  redFive?: boolean;
  markingColor?: THREE.ColorRepresentation;
}

/** s-foil travel: nearly coplanar when closed, a hard X when open. */
const SFOIL_CLOSED = 1.2 * DEG;
const SFOIL_OPEN = 15.0 * DEG;
const ACTUATOR_STROKE = 0.155;

/* ---- module-scoped scratch: update() and the accessors never allocate ----- */
const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();

export function createXWing(opts: XWingOptions = {}): XWing {
  const seed = opts.seed ?? 5150;
  const hero = (opts.detail ?? 'hero') !== 'lod';
  const redFive = opts.redFive ?? hero;
  const markCol = new THREE.Color(opts.markingColor ?? 0xc2231b);

  const build = buildXWingGeometry(seed, hero);
  const shipU = makeShipUniforms(seed, markCol, redFive);
  shipU.uDomeOrigin.value.copy(DOME_ORIGIN);
  const plumeU = makePlumeUniforms(shipU);

  const group = new THREE.Group();
  group.name = 'xwing';

  /* ---------------- meshes (grouped by material = draw calls) ------------- */
  const matHull = createShipMaterial('hull', shipU);
  const matMetal = createShipMaterial('metal', shipU);
  const matGrille = createShipMaterial('grille', shipU);
  const meshes: THREE.Mesh[] = [];
  const materials: THREE.Material[] = [matHull, matMetal, matGrille];
  let matGlass: THREE.MeshPhysicalMaterial | null = null;

  if (hero) {
    matGlass = createGlassMaterial(shipU);
    materials.push(matGlass);
    meshes.push(new THREE.Mesh(build.hull, matHull));
    meshes.push(new THREE.Mesh(build.metal, matMetal));
    meshes.push(new THREE.Mesh(build.grille, matGrille));
    const gm = new THREE.Mesh(build.glass, matGlass);
    gm.renderOrder = 2;
    meshes.push(gm);
  } else {
    // wingman build: the canopy joins the dark-grille pass, which reads much
    // closer to tinted glass at range than the light exposed-metal pass would
    const dark = mergeAll([build.grille, build.glass]);
    meshes.push(new THREE.Mesh(build.hull, matHull));
    meshes.push(new THREE.Mesh(build.metal, matMetal));
    meshes.push(new THREE.Mesh(dark, matGrille));
  }
  for (const m of meshes) { m.castShadow = false; m.receiveShadow = false; group.add(m); }

  /* ---------------- engine VFX ------------------------------------------- */
  const matPlume = createPlumeMaterial(plumeU);
  const plumeGeo = buildExhaustGeometry(build.engines, hero);
  const plume = new THREE.Mesh(plumeGeo, matPlume);
  plume.renderOrder = 12;
  plume.frustumCulled = false;
  group.add(plume);
  materials.push(matPlume);

  let glow: THREE.Mesh | null = null;
  let matGlow: THREE.ShaderMaterial | null = null;
  if (hero) {
    matGlow = createGlowMaterial(plumeU);
    glow = new THREE.Mesh(buildGlowGeometry(build.engines), matGlow);
    glow.renderOrder = 13;
    glow.frustumCulled = false;
    group.add(glow);
    materials.push(matGlow);
  }

  /* ---------------- CPU mirror of the shader s-foil transform ------------- */
  const angles = new Float32Array(4);

  function wingToShip(i: number, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const px = WING_PIVOT[i][0], py = WING_PIVOT[i][1];
    const a = angles[i];
    const c = Math.cos(a), s = Math.sin(a);
    const dx = p.x + WING_SX[i] * shipU.uWingExt.value[i] - px;
    const dy = p.y - py;
    return out.set(px + c * dx - s * dy, py + s * dx + c * dy, p.z);
  }

  /* ---------------- state ------------------------------------------------ */
  const rng = new RNG(seed ^ 0x51a7);
  const flickerPhase = [rng.range(0, 9), rng.range(0, 9), rng.range(0, 9), rng.range(0, 9)];
  let domeSpin = rng.range(0, Math.PI * 2);
  let domeTarget = domeSpin;
  let domeTimer = rng.range(0.5, 3);
  let wobble = 0;
  let lastVel = 0;
  let disposed = false;

  const api: XWing = {
    group,
    sfoil: 0,
    sfoilTarget: 0,
    throttle: 0.55,
    damage: 0,
    length: XWING_LEN,
    cockpitEye: COCKPIT_EYE.clone(),
    materials,

    setSFoil(t: number) {
      api.sfoil = clamp(t, 0, 1);
      api.sfoilTarget = api.sfoil;
      wobble = 0;
      applySFoil(0);
    },

    getCannonTip(i: number, out: THREE.Vector3): THREE.Vector3 {
      const k = clamp(i | 0, 0, 3);
      wingToShip(k, build.cannonLocal[k], out);
      return out.applyMatrix4(group.matrixWorld);
    },
    getEngineTip(i: number, out: THREE.Vector3): THREE.Vector3 {
      const k = clamp(i | 0, 0, 3);
      wingToShip(k, build.engineLocal[k], out);
      return out.applyMatrix4(group.matrixWorld);
    },
    getTorpedoTube(i: number, out: THREE.Vector3): THREE.Vector3 {
      out.copy(build.torpedoLocal[clamp(i | 0, 0, 1)]);
      return out.applyMatrix4(group.matrixWorld);
    },

    update(dt: number, time: number, camera: THREE.Camera) {
      if (disposed) return;
      const step = Math.min(dt, 0.1);

      // ---- s-foils: exponential ease + a hydraulic bounce at the stops
      const prev = api.sfoil;
      api.sfoilTarget = clamp(api.sfoilTarget, 0, 1);
      api.sfoil = damp(api.sfoil, api.sfoilTarget, 2.6, step);
      const vel = step > 1e-5 ? (api.sfoil - prev) / step : 0;
      if (Math.abs(lastVel) > 0.45 && Math.abs(vel) < 0.16) wobble = Math.min(1, Math.abs(lastVel) * 0.9);
      lastVel = vel;
      wobble *= Math.exp(-5.2 * step);
      applySFoil(time);

      // ---- astromech: idle dome sweeps with a glint on the lens
      domeTimer -= step;
      if (domeTimer <= 0) {
        domeTimer = 1.4 + Math.random() * 3.4;
        domeTarget = domeSpin + (Math.random() - 0.5) * 2.4;
      }
      domeSpin = damp(domeSpin, domeTarget, 2.2, step);
      shipU.uDomeSpin.value = domeSpin + Math.sin(time * 0.7) * 0.05;

      // ---- shared shader clocks
      shipU.uTime.value = time;
      shipU.uDamage.value = clamp(api.damage, 0, 1);
      plumeU.uTime.value = time;

      // ---- engines
      const thr = clamp(api.throttle, 0, 1);
      const dmg = clamp(api.damage, 0, 1);
      for (let i = 0; i < 4; i++) {
        const ph = flickerPhase[i];
        let f = 1 + 0.055 * Math.sin(time * 27.3 + ph * 5.1) + 0.035 * Math.sin(time * 61.7 + ph);
        if (dmg > 0.25) {
          // a damaged engine coughs
          const cough = Math.sin(time * (9 + i * 3.1) + ph * 3) * 0.5 + 0.5;
          f *= 1 - dmg * 0.75 * Math.pow(cough, 6) * (i === (Math.floor(time * 0.35) & 3) ? 1 : 0.35);
        }
        const p = Math.max(0.04, thr * f);
        plumeU.uPow.value[i] = p;
        plumeU.uLen.value[i] = 0.45 + 4.2 * p;
        plumeU.uRad.value[i] = 0.80 + 0.30 * p;
      }

      // a bell mouth filling the frame would blow the bloom out, so roll the
      // additive glow disc off when the camera gets inside a few metres
      camera.getWorldPosition(_camPos);
      group.getWorldPosition(_v);
      const near = _camPos.distanceTo(_v);
      plumeU.uNear.value = 0.25 + 0.75 * clamp((near - 2.2) / 4.5, 0, 1);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const m of meshes) { m.geometry.dispose(); group.remove(m); }
      plume.geometry.dispose(); group.remove(plume);
      if (glow) { glow.geometry.dispose(); group.remove(glow); }
      for (const m of materials) m.dispose();
      meshes.length = 0;
    },
  };

  /** Write the four wing angles + actuator extensions into the shared uniforms. */
  function applySFoil(time: number) {
    const t = clamp(api.sfoil, 0, 1);
    const base = SFOIL_CLOSED + (SFOIL_OPEN - SFOIL_CLOSED) * t;
    for (let i = 0; i < 4; i++) {
      const wob = wobble * 0.020 * Math.sin(time * 26.0 + i * 1.9) * (0.6 + 0.4 * Math.sin(time * 11.0 + i));
      angles[i] = WING_SX[i] * WING_SY[i] * (base + wob);
      shipU.uWingAngle.value[i] = angles[i];
      shipU.uWingExt.value[i] = ACTUATOR_STROKE * t + wobble * 0.012 * Math.sin(time * 26.0 + i * 1.9);
    }
  }

  applySFoil(0);
  api.setSFoil(0);

  (group.userData as any).xwing = {
    tris: build.tris + triCount(plumeGeo),
    hullTris: build.tris,
    drawCalls: meshes.length + 1 + (glow ? 1 : 0),
    greebles: build.greebleCount,
  };

  return api;
}
