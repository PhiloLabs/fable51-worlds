import * as THREE from 'three';

/* =========================================================================
   WORLD SCALE — 1 unit = 1 metre.  Every module must use these.
   ========================================================================= */

export const XWING_LEN = 12.5;      // metres, nose to engine bell
export const XWING_SPAN = 11.0;     // s-foils open
export const TIE_SIZE = 8.5;

/** Death Star: 100 km across. Centre is the world origin, poles on +Y/-Y. */
export const DS_RADIUS = 50000;
export const DS_CENTER = new THREE.Vector3(0, 0, 0);

/** Superlaser dish direction (unit vector from centre). */
export const DS_DISH_DIR = new THREE.Vector3(0.46, 0.55, -0.70).normalize();

/* ---------------- Meridian trench (the run) -------------------------------
   Parameterised by arc-length `s` (metres) from the north pole.
   The trench great circle lies in the world XY plane; +Z is lateral.
     radial(s) = ( sin(s/R), cos(s/R), 0 )
     forward(s) = ( cos(s/R), -sin(s/R), 0 )
     right(s)   = ( 0, 0, 1 )
   `up` is the height above the un-cut sphere surface (negative = inside).
--------------------------------------------------------------------------- */
export const TRENCH_HALF_WIDTH = 62;    // 124 m across
export const TRENCH_DEPTH = 105;        // floor at up = -105
export const TRENCH_START_S = -3000;    // geometry exists a bit before the entry
export const TRENCH_END_S = 26200;      // geometry runs past the port
export const TRENCH_ENTRY_S = 0;        // player drops in around here
export const PORT_S = 24000;            // exhaust port centre, arc-length
export const PORT_RADIUS = 11;          // 2 m in the film; 11 m reads better at speed
export const PORT_LATERAL = 0;          // centred in the trench floor

/** Player cruise / boost speeds during the trench run (m/s). */
export const TRENCH_SPEED = 430;
export const TRENCH_BOOST = 640;

export function trenchRadial(s: number, out = new THREE.Vector3()): THREE.Vector3 {
  const t = s / DS_RADIUS;
  return out.set(Math.sin(t), Math.cos(t), 0);
}
export function trenchForward(s: number, out = new THREE.Vector3()): THREE.Vector3 {
  const t = s / DS_RADIUS;
  return out.set(Math.cos(t), -Math.sin(t), 0);
}
export function trenchRight(_s: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(0, 0, 1);
}
/** trench-local (s, lateral, up) -> world position */
export function trenchToWorld(s: number, lateral: number, up: number, out = new THREE.Vector3()): THREE.Vector3 {
  const t = s / DS_RADIUS;
  const r = DS_RADIUS + up;
  out.set(Math.sin(t) * r, Math.cos(t) * r, lateral);
  return out;
}
/** Orientation whose -Z looks along the trench, +Y along the radial, +X = world +Z. */
const _m = new THREE.Matrix4();
const _f = new THREE.Vector3(), _u = new THREE.Vector3();
const _xAxis = new THREE.Vector3(0, 0, 1);
export function trenchQuat(s: number, out = new THREE.Quaternion()): THREE.Quaternion {
  trenchForward(s, _f).negate();   // local +Z
  trenchRadial(s, _u);             // local +Y
  _m.makeBasis(_xAxis, _u, _f);
  return out.setFromRotationMatrix(_m);
}
/** Approximate inverse: world position -> trench-local (s, lateral, up) */
export function worldToTrench(p: THREE.Vector3, out = { s: 0, lateral: 0, up: 0 }) {
  const t = Math.atan2(p.x, p.y);
  out.s = t * DS_RADIUS;
  out.lateral = p.z;
  out.up = Math.hypot(p.x, p.y) - DS_RADIUS;
  return out;
}

/** World position of the exhaust port mouth (on the trench floor). */
export function portPosition(out = new THREE.Vector3()) {
  return trenchToWorld(PORT_S, PORT_LATERAL, -TRENCH_DEPTH + 1, out);
}

/* ---------------- Rendering ---------------- */
export const CAM_NEAR = 1.0;
export const CAM_FAR = 700000;
export const FOV_DEFAULT = 55;

/* ---------------- Layers ---------------- */
export const LAYER_DEFAULT = 0;
export const LAYER_NOBLOOM = 1;   // reserved

/* ---------------- Colours ---------------- */
export const COL_REBEL_LASER = new THREE.Color(1.0, 0.13, 0.06);
export const COL_IMP_LASER = new THREE.Color(0.30, 1.0, 0.35);
export const COL_TURBO = new THREE.Color(0.35, 1.0, 0.45);
export const COL_TORPEDO = new THREE.Color(0.42, 0.82, 1.0);
export const COL_ENGINE = new THREE.Color(1.0, 0.34, 0.16);
export const COL_TIE_ENGINE = new THREE.Color(0.55, 0.85, 1.0);

/* ---------------- Ownership corridors ------------------------------------
   The trench module owns a lateral strip either side of the meridian trench;
   the Death Star shell must leave a hole there. Likewise the equatorial
   trench band and the superlaser dish crater are cut out of the shell and
   filled with their own geometry.
--------------------------------------------------------------------------- */
export const MERIDIAN_CORRIDOR_HALF = 1250;    // |z| owned by the trench module
export const MERIDIAN_CORRIDOR_S0 = -3400;
export const MERIDIAN_CORRIDOR_S1 = 26600;
export const EQUATOR_TRENCH_HALF = 950;        // |y| band (equatorial trench)
export const DISH_RADIUS = 8200;               // superlaser crater radius (m)

/** Is this point on the sphere inside the strip the trench module fills in? */
export function inMeridianCorridor(p: THREE.Vector3): boolean {
  if (Math.abs(p.z) > MERIDIAN_CORRIDOR_HALF) return false;
  const s = Math.atan2(p.x, p.y) * DS_RADIUS;
  return s > MERIDIAN_CORRIDOR_S0 && s < MERIDIAN_CORRIDOR_S1;
}
export function inEquatorTrench(p: THREE.Vector3): boolean {
  return Math.abs(p.y) < EQUATOR_TRENCH_HALF;
}
const _dishTmp = new THREE.Vector3();
export function inDishCrater(p: THREE.Vector3): boolean {
  _dishTmp.copy(p).normalize();
  const cosA = _dishTmp.dot(DS_DISH_DIR);
  if (cosA <= 0) return false;
  const arc = Math.acos(Math.min(1, cosA)) * DS_RADIUS;
  return arc < DISH_RADIUS;
}
