import * as THREE from 'three';
import {
  Shot, CamState, look, chase, rig, orbit, spline, dolly, stare, morph, handheld, safeUp,
} from './director';
import {
  DS_RADIUS, PORT_S, TRENCH_DEPTH, TRENCH_HALF_WIDTH,
  trenchToWorld, trenchRadial, trenchForward, portPosition, worldToTrench,
} from '../core/constants';
import { clamp, easeInOutCubic, easeOutCubic, easeInOutSine, easeOutQuint, lerp, smoothstep } from '../core/mathx';
import type { World } from '../game/world';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _rad = new THREE.Vector3(), _fwd = new THREE.Vector3(), _lat = new THREE.Vector3(0, 0, 1);
const _tc = { s: 0, lateral: 0, up: 0 };

const shipUp = (w: World, out: THREE.Vector3) => out.set(0, 1, 0).applyQuaternion(w.ship.quaternion);
const getShip = (w: any) => (w as World).shipObj;

const _af = new THREE.Vector3(), _ao = new THREE.Vector3();
/**
 * Where a combat shot should point. Biases toward the engaged TIE but clamps
 * the off-axis component so the player's own ship never leaves frame.
 */
function aimPoint(w: World, dist: number, out: THREE.Vector3) {
  w.ship.getForward(_af);
  out.copy(w.ship.position).addScaledVector(_af, dist);
  if (w.focus && w.focusDist < 3000) {
    _ao.copy(w.focus).sub(w.ship.position);
    _ao.addScaledVector(_af, -_ao.dot(_af));        // perpendicular offset only
    const maxOff = dist * 0.30;                      // ≈17°
    if (_ao.lengthSq() > maxOff * maxOff) _ao.setLength(maxOff);
    out.addScaledVector(_ao, 0.8);
  }
  return out;
}

/** Chase camera that keeps the current dogfight target in frame. */
function dogChase(offset: THREE.Vector3, lag: number): Shot['update'] {
  const sm = new THREE.Vector3();
  const st = new THREE.Vector3();
  let inited = false;
  const o = new THREE.Vector3(), tg = new THREE.Vector3();
  return (_t, _u, ctx, out) => {
    const w = ctx.world as World;
    o.copy(offset).applyQuaternion(w.ship.quaternion).add(w.ship.position);
    aimPoint(w, 420, tg);
    if (!inited) { sm.copy(o); st.copy(tg); inited = true; }
    else { sm.addScaledVector(w.ship.velocity, ctx.dt); st.addScaledVector(w.ship.velocity, ctx.dt); }
    const k = 1 - Math.exp(-lag * ctx.dt);
    sm.lerp(o, k);
    st.lerp(tg, Math.min(1, k * 1.3));
    shipUp(w, _c);
    look(out, sm, st, _c);
  };
}

export function buildShots(W: World): Shot[] {
  const shots: Shot[] = [];
  const S = (s: Shot) => { shots.push(s); return s; };

  /* ------------------------------------------------------ 1 · WIDE STATION */
  S({
    name: 'wide-station', at: 0, duration: 18, blend: 0, fov: 34, letterbox: 1,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      worldToTrench(w.ship.position, _tc);
      trenchRadial(_tc.s, _rad);
      trenchForward(_tc.s, _fwd);
      // the camera starts ahead of the squadron (they are off-screen behind it),
      // then lets them overtake it and fly into frame toward the station
      const D = lerp(-3600, 300, easeInOutSine(clamp(t / 10, 0, 1)));
      _a.copy(w.ship.position)
        .addScaledVector(_rad, D)
        .addScaledVector(_lat, 116 - t * 5.6)
        .addScaledVector(_fwd, -26);
      look(out, _a, _b.set(0, 0, 0), _fwd);
    },
  });

  /* ------------------------------------------------- 2 · ALONGSIDE / S-FOIL */
  S({
    name: 'alongside', at: 18, duration: 9, blend: 1.6, fov: 46, letterbox: 1,
    update: handheld((t, u, ctx, out) => {
      const w = ctx.world as World;
      const ang = -0.5 + t * 0.075;
      _a.set(Math.sin(ang) * 17, 3.2 + Math.sin(t * 0.4) * 1.1, Math.cos(ang) * 17 + 2)
        .applyQuaternion(w.ship.quaternion).add(w.ship.position);
      _b.set(0, 0.2, -2.2).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    }, 0.7, 3),
  });

  S({
    name: 'sfoil-detail', at: 27, duration: 7, blend: 1.1, fov: 33, letterbox: 1,
    update: handheld((t, u, ctx, out) => {
      const w = ctx.world as World;
      _a.set(6.4 - t * 0.16, 1.5, 5.6 - t * 0.1).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      _b.set(2.1, 0.35, 2.3).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    }, 0.9, 11),
  });

  /* ---------------------------------------------------------- 3 · DOGFIGHT */
  S({
    name: 'ties-approach', at: 34, duration: 8, blend: 1.4, fov: 50, letterbox: 0.35,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      _a.set(6.5, 2.6, 19).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      aimPoint(w, 900, _b);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    },
  });
  S({
    name: 'dogfight-chase', at: 42, duration: 8, blend: 1.2, fov: 48, shake: 0.07, letterbox: 0.2,
    update: dogChase(new THREE.Vector3(0, 3.0, 19), 4.2),
  });
  S({
    name: 'dogfight-side', at: 50, duration: 5, blend: 1.0, fov: 54, shake: 0.06, letterbox: 0.2,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      _a.set(30 * Math.cos(t * 0.45 + 0.4), 6 + Math.sin(t * 0.6) * 3, -6 + t * 1.5)
        .applyQuaternion(w.ship.quaternion).add(w.ship.position);
      // frame the ship, but drift toward whatever it is fighting
      _b.copy(w.ship.position);
      if (w.focus && w.focusDist < 2200) _b.lerp(w.focus, 0.42);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    },
  });
  S({
    name: 'dogfight-chase2', at: 55, duration: 4, blend: 0.9, fov: 52, shake: 0.09, letterbox: 0.2,
    update: dogChase(new THREE.Vector3(-3.5, -2.0, 15), 6.0),
  });

  /* -------------------------------------------------- 4 · DIVE TO SURFACE */
  S({
    name: 'dive', at: 58, duration: 9, blend: 1.5, fov: 64, letterbox: 0.55,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      out.fov = lerp(58, 76, easeInOutCubic(clamp(t / 8, 0, 1)));
      _a.set(2.5, 10 - t * 0.35, 34 + t * 0.9).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      w.ship.getForward(_b); _b.multiplyScalar(900).add(w.ship.position);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    },
  });
  S({
    name: 'surface-skim', at: 67, duration: 7, blend: 1.4, fov: 78, shake: 0.05, letterbox: 0.55,
    update: chase(getShip, new THREE.Vector3(0, 5.0, 27), { lag: 5.5, lookAhead: 520 }),
  });

  /* ------------------------------------------------------ 5 · TRENCH ENTRY */
  S({
    name: 'trench-entry', at: 74, duration: 6, blend: 1.2, fov: 70, letterbox: 0.35,
    init(ctx) {
      const w = ctx.world as World;
      trenchToWorld(w.ship.s + 1500, TRENCH_HALF_WIDTH + 260, 210, entryCam);
    },
    update: morph(
      (t, u, ctx, out) => {
        const w = ctx.world as World;
        _b.copy(w.ship.position);
        worldToTrench(w.ship.position, _tc);
        trenchRadial(_tc.s, _c);
        look(out, entryCam, _b, _c);
      },
      chase(getShip, new THREE.Vector3(0, 5.2, 25), { lag: 5.0, lookAhead: 420 }),
      easeInOutCubic, [0.35, 0.95]
    ),
  });

  /* -------------------------------------------------------- 6 · TRENCH RUN */
  S({
    name: 'trench-chase', at: 80, duration: 12, blend: 1.1, fov: 72, shake: 0.035,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      const boost = w.ship.boosting ? 1 : 0;
      out.fov = 70 + boost * 7 + clamp((w.ship.speed - 380) / 260, 0, 1) * 5;
      trenchChase(t, u, ctx, out);
    },
  });
  const trenchChase = chase(getShip, new THREE.Vector3(0, 4.4, 22.5), { lag: 6.5, lookAhead: 300 });

  S({
    name: 'trench-cockpit', at: 92, duration: 5, blend: 0.9, fov: 82, shake: 0.05,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      const eye = (w.xwing?.cockpitEye as THREE.Vector3) ?? _a.set(0, 1.55, -1.1);
      _a.copy(eye).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      w.ship.getForward(_b); _b.multiplyScalar(600).add(w.ship.position);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    },
  });
  S({
    name: 'trench-low', at: 97, duration: 5, blend: 0.9, fov: 84, shake: 0.06,
    update: chase(getShip, new THREE.Vector3(0.5, -2.8, 14), { lag: 8.5, lookAhead: 260 }),
  });
  const wallShot = (name: string, at: number, side: number, ahead: number) => S({
    name, at, duration: 3.2, blend: 0.85, fov: 62, shake: 0.05,
    init(ctx) {
      const w = ctx.world as World;
      trenchToWorld(w.ship.s + ahead, side * (TRENCH_HALF_WIDTH - 9), -TRENCH_DEPTH * 0.36, wallCam[name] ??= new THREE.Vector3());
    },
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      const p = wallCam[name] ?? _a;
      _b.copy(w.ship.position);
      worldToTrench(p, _tc);
      trenchRadial(_tc.s, _c);
      look(out, p, _b, _c);
    },
  });
  wallShot('trench-side', 102, 1, 620);
  wallShot('trench-side2', 106, -1, 760);

  /* --------------------------------------------------------- 7 · TARGETING */
  S({
    name: 'targeting', at: 110, duration: 6, blend: 1.0, fov: 44, letterbox: 0.7, shake: 0.03,
    update: handheld((t, u, ctx, out) => {
      const w = ctx.world as World;
      const a = lerp(-14, -10, easeInOutSine(clamp(t / 6, 0, 1)));
      _a.set(7.6, -1.1 + Math.sin(t * 0.5) * 0.4, a).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      _b.set(0, 0.4, -1.5).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    }, 0.6, 21),
  });
  S({
    name: 'targeting-port', at: 116, duration: 6, blend: 1.0, fov: 30, letterbox: 0.7, shake: 0.04,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      _a.set(0, 3.0, 15).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      portPosition(_b);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    },
  });

  /* ----------------------------------------------------------- 8 · TORPEDO */
  S({
    name: 'torpedo-launch', at: 122, duration: 2, blend: 0.7, fov: 52, letterbox: 0.7, shake: 0.06,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      _a.set(3.0, -3.0, -13).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      _b.set(0, -0.2, 0).applyQuaternion(w.ship.quaternion).add(w.ship.position);
      shipUp(w, _c);
      look(out, _a, _b, _c);
    },
  });
  S({
    name: 'torpedo-track', at: 124, duration: 5, blend: 0.8, fov: 58, letterbox: 0.7, shake: 0.05,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      const tp = w.torpedoes[0];
      const p = tp?.alive ? tp.pos : w.ship.position;
      const v = tp?.alive ? tp.vel : w.ship.velocity;
      _c.copy(v).normalize();
      if (_c.lengthSq() < 0.1) _c.set(0, 0, -1);
      _a.copy(p).addScaledVector(_c, -34).add(_b.set(0, 0, 0));
      worldToTrench(p, _tc);
      trenchRadial(_tc.s, _b);
      _a.addScaledVector(_b, 9).addScaledVector(_lat, 11);
      _b.copy(p).addScaledVector(_c, 34);
      trenchRadial(_tc.s, _rad);
      trenchForward(_tc.s, _fwd);
      look(out, _a, _b, safeUp(_c, _rad, _fwd, _upTmp));
    },
  });
  S({
    name: 'port-entry', at: 129, duration: 2.2, blend: 0.55, fov: 46, letterbox: 0.7, shake: 0.07,
    update(t, u, ctx, out) {
      portPosition(_b);
      trenchRadial(PORT_S, _rad);
      trenchForward(PORT_S, _fwd);
      _a.copy(_b).addScaledVector(_rad, 62 - t * 8).addScaledVector(_fwd, -46 + t * 5).addScaledVector(_lat, 22);
      look(out, _a, _b, _fwd);
    },
  });
  S({
    name: 'shaft', at: 131, duration: 1.7, blend: 0.35, fov: 76, shake: 0.18,
    update(t, u, ctx, out) {
      portPosition(_b);
      trenchRadial(PORT_S, _rad);
      trenchForward(PORT_S, _fwd);
      // plunge down the shaft ahead of the torpedoes
      _a.copy(_b).addScaledVector(_rad, -(40 + t * 300));
      _c.copy(_b).addScaledVector(_rad, -(40 + t * 300 + 260));
      look(out, _a, _c, _fwd);
    },
  });
  S({
    name: 'core-hit', at: 133, duration: 2.4, blend: 0.4, fov: 86, shake: 0.6,
    update(t, u, ctx, out) {
      portPosition(_b);
      trenchRadial(PORT_S, _rad);
      trenchForward(PORT_S, _fwd);
      _a.copy(_b).addScaledVector(_rad, -(900 + t * 260));
      _c.copy(_b).addScaledVector(_rad, -2600);
      look(out, _a, _c, _fwd);
      out.roll = t * 0.12;
    },
  });

  /* ------------------------------------------------------------ 9 · ESCAPE */
  S({
    name: 'escape-climb', at: 136, duration: 5, blend: 0.9, fov: 66, shake: 0.05, letterbox: 0.4,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      worldToTrench(w.ship.position, _tc);
      trenchRadial(_tc.s, _rad);
      w.ship.getForward(_fwd);
      // ride above the climbing ship and look down past it at the surface it is leaving
      _a.copy(w.ship.position)
        .addScaledVector(_rad, 62 + t * 16)
        .addScaledVector(_fwd, -34)
        .addScaledVector(_lat, 24);
      _b.copy(w.ship.position).addScaledVector(_rad, -260 - t * 260);
      look(out, _a, _b, safeUp(_c.copy(_b).sub(_a), _fwd, _rad, _upTmp));
    },
  });
  S({
    name: 'escape-wide', at: 141, duration: 7, blend: 1.6, fov: 48, letterbox: 0.4,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      worldToTrench(w.ship.position, _tc);
      trenchRadial(_tc.s, _rad);
      w.ship.getForward(_fwd);
      // sit outboard of the ship so the whole station falls away beneath it
      // hold the ship between the lens and the station so both stay in frame
      _a.copy(w.ship.position)
        .addScaledVector(_rad, 96 + t * 10)
        .addScaledVector(_lat, 21);
      _b.set(0, 0, 0);
      look(out, _a, _b, safeUp(_c.copy(_b).sub(_a), _fwd, _lat, _upTmp));
    },
  });

  /* ------------------------------------------------------- 10 · DESTRUCTION
     Distances are in metres from the station centre and are tuned against the
     measured fireball radius (≈23 km at core ignition, 228 km at +11 s, 325 km
     final) so the camera always stays just outside the fire and the blast keeps
     growing in frame instead of shrinking away from it.
  ------------------------------------------------------------------------- */
  S({
    name: 'destruction-wide', at: 148, duration: 5, blend: 1.2, fov: 46, letterbox: 0.8,
    init(ctx) {
      trenchRadial(PORT_S, _rad);
      destroDir.copy(_rad).multiplyScalar(0.80)
        .addScaledVector(_lat, 0.40).add(_a.set(0, 0.30, 0)).normalize();
      trenchForward(PORT_S, destroUp);
    },
    update(t, u, ctx, out) {
      _a.copy(destroDir).multiplyScalar(lerp(158000, 140000, clamp(t / 5, 0, 1)));
      look(out, _a, _b.set(0, 0, 0), destroUp);
    },
  });
  S({
    name: 'destruction-core', at: 153, duration: 3, blend: 1.3, fov: 40, letterbox: 0.8, shake: 0.1,
    update(t, u, ctx, out) {
      _a.copy(destroDir).multiplyScalar(lerp(104000, 122000, clamp(t / 3, 0, 1)));
      look(out, _a, _b.set(0, 0, 0), destroUp);
    },
  });
  S({
    name: 'destruction-primary', at: 156, duration: 5, blend: 0.9, fov: 62, letterbox: 0.8, shake: 0.34,
    update(t, u, ctx, out) {
      // run away from the fire just fast enough to stay ahead of the front
      _a.copy(destroDir).multiplyScalar(lerp(132000, 336000, clamp(t / 4.6, 0, 1)));
      look(out, _a, _b.set(0, 0, 0), destroUp);
      out.roll = Math.sin(t * 0.4) * 0.03;
    },
  });
  S({
    name: 'shockwave', at: 161, duration: 6, blend: 1.1, fov: 76, letterbox: 0.8, shake: 0.4,
    init(ctx) {
      trenchRadial(PORT_S, _rad);
      shockDir.copy(_rad).multiplyScalar(0.86).addScaledVector(_lat, 0.34).add(_a.set(0, 0.22, 0)).normalize();
      trenchForward(PORT_S, destroUp);
    },
    update(t, u, ctx, out) {
      _a.copy(shockDir).multiplyScalar(372000 + t * 7000);
      look(out, _a, _b.set(0, 0, 0), destroUp);
      out.roll = Math.sin(t * 0.9) * 0.05 * clamp(t / 3, 0, 1);
    },
  });

  /* ------------------------------------------------------------- 11 · OUTRO */
  S({
    name: 'escape-final', at: 167, duration: 8, blend: 0.9, fov: 54, letterbox: 0.9,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      w.ship.getForward(_fwd);
      _c.set(0, 1, 0).applyQuaternion(w.ship.quaternion);
      const a = 0.7 + t * 0.06;
      _a.copy(w.ship.position)
        .addScaledVector(_fwd, 86 + t * 4)
        .addScaledVector(_c, 15 + Math.sin(t * 0.3) * 3)
        .add(_b.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(34));
      _b.copy(w.ship.position);
      look(out, _a, _b, _c);
    },
  });
  S({
    name: 'outro-drift', at: 175, duration: 12, blend: 2.4, fov: 42, letterbox: 1,
    update(t, u, ctx, out) {
      const w = ctx.world as World;
      w.ship.getForward(_fwd);
      _c.set(0, 1, 0).applyQuaternion(w.ship.quaternion);
      _a.copy(w.ship.position).addScaledVector(_fwd, 132 + Math.min(t, 9) * 17).addScaledVector(_c, 22 + Math.min(t, 9) * 3);
      _b.copy(w.ship.position).addScaledVector(_fwd, -220);
      look(out, _a, _b, _c);
    },
  });

  return shots;
}

const entryCam = new THREE.Vector3();
const destroUp = new THREE.Vector3(0, 1, 0);
const _upTmp = new THREE.Vector3();
const destroDir = new THREE.Vector3();
const shockDir = new THREE.Vector3();
const wallCam: Record<string, THREE.Vector3> = {};
