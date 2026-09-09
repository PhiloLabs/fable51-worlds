import * as THREE from 'three';
import { clamp, damp, easeInOutCubic, easeInOutSine, lerp, smoothstep } from '../core/mathx';

export interface CamState {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fov: number;
  roll: number;      // extra roll applied after aiming, radians
}
export function makeCamState(): CamState {
  return { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 55, roll: 0 };
}

export interface ShotCtx {
  time: number;          // global sequence time
  dt: number;
  camera: THREE.PerspectiveCamera;
  /** everything the shots need — filled by the sequence */
  world: any;
}

export interface Shot {
  name: string;
  /** sequence time when this shot takes over (timeline mode) */
  at: number;
  /** explicit-mode length used for the `u` parameter; falls back to the gap to the next shot */
  duration?: number;
  blend?: number;             // cross-blend seconds from the previous shot (0 = hard cut)
  fov?: number;
  letterbox?: number;         // 0..1
  shake?: number;             // constant baseline shake
  /** called once when the shot becomes active */
  init?(ctx: ShotCtx): void;
  /** t = seconds since this shot started; u = t / duration (0..1) */
  update(t: number, u: number, ctx: ShotCtx, out: CamState): void;
}

/* ------------------------------------------------------------------ helpers */
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();

const _dir = new THREE.Vector3();
const _altUp = new THREE.Vector3();
const _perp = new THREE.Vector3();

/**
 * Pick an up vector that is not parallel to `view`. Blends `preferred` toward
 * `fallback` as it approaches the view axis, so a shot never hits the degenerate
 * lookAt case where the roll becomes arbitrary.
 */
export function safeUp(view: THREE.Vector3, preferred: THREE.Vector3, fallback: THREE.Vector3, out = new THREE.Vector3()) {
  _dir.copy(view).normalize();
  const d = Math.abs(_dir.dot(preferred));
  if (d < 0.82) return out.copy(preferred).normalize();
  const k = Math.min(1, (d - 0.82) / 0.16);
  out.copy(preferred).lerp(fallback, k);
  if (out.lengthSq() < 1e-6) out.copy(fallback);
  return out.normalize();
}

/** Aim `out.quat` from `pos` toward `target`, with an optional world up hint. */
export function look(out: CamState, pos: THREE.Vector3, target: THREE.Vector3, up?: THREE.Vector3) {
  out.pos.copy(pos);
  const u = up ?? _up;
  _dir.copy(target).sub(pos);
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, -1);
  _dir.normalize();
  // guard against an up vector parallel to the view axis
  if (Math.abs(_dir.dot(u)) > 0.995) {
    _perp.set(1, 0, 0);
    if (Math.abs(_dir.x) > 0.9) _perp.set(0, 1, 0);
    _altUp.crossVectors(_dir, _perp).cross(_dir).normalize();
    _m.lookAt(pos, target, _altUp);
  } else {
    _m.lookAt(pos, target, u);
  }
  out.quat.setFromRotationMatrix(_m);
  return out;
}

/** Smooth 1-D value noise for shake / handheld drift. */
function noise1(t: number, seed: number) {
  return (
    Math.sin(t * 1.913 + seed * 12.9898) * 0.5 +
    Math.sin(t * 3.771 + seed * 78.233) * 0.29 +
    Math.sin(t * 7.331 + seed * 43.114) * 0.14 +
    Math.sin(t * 13.17 + seed * 3.717) * 0.07
  );
}

export class CameraShake {
  trauma = 0;
  private t = 0;
  add(v: number) { this.trauma = clamp(this.trauma + v, 0, 1); }
  update(dt: number, decay = 1.35) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * decay);
  }
  /** apply to a camera state; `base` is a constant amount added to the trauma */
  apply(out: CamState, base = 0, scale = 1) {
    const a = clamp(this.trauma + base, 0, 1);
    if (a <= 0.0005) return;
    const amp = a * a * scale;
    const t = this.t;
    _v.set(noise1(t * 11, 1), noise1(t * 11, 2), noise1(t * 11, 3)).multiplyScalar(amp * 1.35);
    out.pos.add(_v.applyQuaternion(out.quat));
    const e = new THREE.Euler(
      noise1(t * 9.3, 4) * amp * 0.045,
      noise1(t * 9.3, 5) * amp * 0.045,
      noise1(t * 7.1, 6) * amp * 0.075, 'XYZ');
    out.quat.multiply(new THREE.Quaternion().setFromEuler(e));
  }
}

/* ------------------------------------------------------------------ director */
export class Director {
  shots: Shot[] = [];
  shake = new CameraShake();
  letterbox = 0;
  /** extra FOV added by speed / boost, damped */
  fovKick = 0;
  speedBlur = 0;

  private cur = -1;
  private prev = -1;
  private curStart = 0;
  private a = makeCamState();
  private b = makeCamState();
  private outState = makeCamState();
  private started = new Set<number>();
  private fovSmooth = 55;
  private posSmooth = new THREE.Vector3();
  private quatSmooth = new THREE.Quaternion();
  private inited = false;
  /** when true the director does not move the camera (external override) */
  manual = false;
  /** explicit mode: shots are activated by `play()` instead of by their `at` time */
  explicit = false;
  private byName = new Map<string, number>();
  private playToken = 0;

  constructor(public camera: THREE.PerspectiveCamera) {}

  setShots(shots: Shot[]) {
    this.shots = shots.slice().sort((x, y) => x.at - y.at);
    this.byName.clear();
    this.shots.forEach((s, i) => this.byName.set(s.name, i));
    this.cur = -1; this.prev = -1; this.started.clear(); this.inited = false;
  }

  /** Explicit mode: hand the camera to a named shot right now. */
  play(name: string, atTime: number, blendOverride?: number) {
    const i = this.byName.get(name);
    if (i === undefined) { console.warn('[director] unknown shot', name); return; }
    if (i === this.cur) return;
    this.explicit = true;
    this.prevShotTime = atTime - this.curStart;
    this.prev = this.cur;
    this.cur = i;
    this.curStart = atTime;
    this.started.delete(i);
    if (blendOverride !== undefined) this.blendOverride = blendOverride;
    else this.blendOverride = undefined;
    this.playToken++;
  }
  private blendOverride: number | undefined;
  get currentShotName() { return this.cur >= 0 ? this.shots[this.cur].name : ''; }
  get shotTime() { return this._shotTime; }
  private _shotTime = 0;

  activeShot(): Shot | null { return this.cur >= 0 ? this.shots[this.cur] : null; }

  private indexAt(time: number) {
    let i = -1;
    for (let k = 0; k < this.shots.length; k++) if (this.shots[k].at <= time) i = k; else break;
    return i;
  }
  private prevShotTime = 0;
  private durationOf(i: number) {
    const next = this.shots[i + 1];
    return next ? next.at - this.shots[i].at : 30;
  }

  update(time: number, dt: number, world: any) {
    if (!this.shots.length || this.manual) return;
    if (!this.explicit) {
      const idx = this.indexAt(time);
      if (idx < 0) return;
      if (idx !== this.cur) {
        this.prev = this.cur;
        this.cur = idx;
        this.curStart = this.shots[idx].at;
      }
    }
    if (this.cur < 0) return;
    const ctx: ShotCtx = { time, dt, camera: this.camera, world };
    const shot = this.shots[this.cur];
    if (!this.started.has(this.cur)) { this.started.add(this.cur); shot.init?.(ctx); }

    const t = time - this.curStart;
    this._shotTime = t;
    const dur = shot.duration ?? this.durationOf(this.cur);
    this.a.fov = shot.fov ?? 55;
    this.a.roll = 0;
    shot.update(t, clamp(t / dur, 0, 1), ctx, this.a);

    let s = this.a;
    const blend = this.blendOverride ?? shot.blend ?? 0;
    if (blend > 0 && t < blend && this.prev >= 0) {
      const pShot = this.shots[this.prev];
      const pt = this.prevShotTime + t;
      const pdur = pShot.duration ?? this.durationOf(this.prev);
      this.b.fov = pShot.fov ?? 55;
      this.b.roll = 0;
      pShot.update(pt, clamp(pt / pdur, 0, 1), ctx, this.b);
      const k = easeInOutCubic(clamp(t / blend, 0, 1));
      this.b.pos.lerp(this.a.pos, k);
      this.b.quat.slerp(this.a.quat, k);
      this.b.fov = lerp(this.b.fov, this.a.fov, k);
      this.b.roll = lerp(this.b.roll, this.a.roll, k);
      s = this.b;
    }

    // letterbox target
    const lbTarget = shot.letterbox ?? 0;
    this.letterbox = damp(this.letterbox, lbTarget, 3.2, dt);

    // apply roll
    if (Math.abs(s.roll) > 1e-5) {
      s.quat.multiply(_rollQ.setFromAxisAngle(_zAxis, s.roll));
    }

    // shake
    this.shake.update(dt);
    this.shake.apply(s, shot.shake ?? 0, 1.0);

    if (!this.inited) {
      this.posSmooth.copy(s.pos); this.quatSmooth.copy(s.quat); this.fovSmooth = s.fov;
      this.inited = true;
    }
    // a touch of global smoothing so nothing ever snaps
    this.posSmooth.copy(s.pos);
    this.quatSmooth.copy(s.quat);
    this.fovSmooth = damp(this.fovSmooth, s.fov + this.fovKick, 5.5, dt);

    this.camera.position.copy(this.posSmooth);
    this.camera.quaternion.copy(this.quatSmooth);
    if (Math.abs(this.camera.fov - this.fovSmooth) > 0.002) {
      this.camera.fov = this.fovSmooth;
      this.camera.updateProjectionMatrix();
    }
    this.outState = s;
  }

  get state() { return this.outState; }
}
const _rollQ = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

/* ------------------------------------------------------------------ shot kit
   Reusable camera behaviours. Each returns a `Shot['update']` function.
--------------------------------------------------------------------------- */

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _o = new THREE.Vector3();

/**
 * Chase camera locked behind an object, with spring lag.
 *
 * The smoothed position is advected by the subject's own velocity before the
 * lerp — otherwise an exponential filter in world space sits a *constant*
 * distance behind a fast-moving ship (≈70 m at 430 m/s), which silently pushes
 * the subject to a speck in the middle of frame.
 */
export function chase(
  getObj: (w: any) => THREE.Object3D | null,
  offset: THREE.Vector3,
  opts: { lag?: number; lookAhead?: number; rollFactor?: number; up?: THREE.Vector3 } = {}
) {
  const smooth = new THREE.Vector3();
  const smoothTgt = new THREE.Vector3();
  let inited = false;
  const lag = opts.lag ?? 5.5;
  const la = opts.lookAhead ?? 60;
  return (_t0: number, _u: number, ctx: ShotCtx, out: CamState) => {
    const o = getObj(ctx.world);
    if (!o) return;
    _o.copy(offset).applyQuaternion(o.quaternion).add(o.position);
    _t.set(0, 0, -la).applyQuaternion(o.quaternion).add(o.position);
    const vel = ctx.world?.ship?.velocity as THREE.Vector3 | undefined;
    if (!inited) { smooth.copy(_o); smoothTgt.copy(_t); inited = true; }
    else if (vel) { smooth.addScaledVector(vel, ctx.dt); smoothTgt.addScaledVector(vel, ctx.dt); }
    const k = 1 - Math.exp(-lag * ctx.dt);
    smooth.lerp(_o, k);
    smoothTgt.lerp(_t, Math.min(1, k * 1.6));
    _p.set(0, 1, 0).applyQuaternion(o.quaternion);
    look(out, smooth, smoothTgt, _p);
  };
}

/** Fixed world point looking at a moving object. */
export function stare(pos: THREE.Vector3, getTarget: (w: any) => THREE.Vector3 | THREE.Object3D | null, up?: THREE.Vector3) {
  return (_t0: number, _u: number, ctx: ShotCtx, out: CamState) => {
    const tg = getTarget(ctx.world);
    if (!tg) return;
    _t.copy((tg as any).isObject3D ? (tg as THREE.Object3D).position : (tg as THREE.Vector3));
    look(out, pos, _t, up);
  };
}

/** Dolly along a straight line while looking at a target. */
export function dolly(
  from: THREE.Vector3, to: THREE.Vector3,
  getTarget: (w: any) => THREE.Vector3 | THREE.Object3D | null,
  ease: (x: number) => number = easeInOutSine,
  up?: THREE.Vector3
) {
  return (_t0: number, u: number, ctx: ShotCtx, out: CamState) => {
    const tg = getTarget(ctx.world);
    _p.lerpVectors(from, to, ease(clamp(u, 0, 1)));
    if (!tg) { look(out, _p, _t.copy(_p).add(new THREE.Vector3(0, 0, -1)), up); return; }
    _t.copy((tg as any).isObject3D ? (tg as THREE.Object3D).position : (tg as THREE.Vector3));
    look(out, _p, _t, up);
  };
}

/** Camera bolted to a moving object with a local offset and local aim point. */
export function rig(
  getObj: (w: any) => THREE.Object3D | null,
  offset: THREE.Vector3,
  aim: THREE.Vector3,
  opts: { lag?: number; aimLag?: number } = {}
) {
  const sp = new THREE.Vector3(); const sq = new THREE.Quaternion();
  let inited = false;
  return (_t0: number, _u: number, ctx: ShotCtx, out: CamState) => {
    const o = getObj(ctx.world);
    if (!o) return;
    _o.copy(offset).applyQuaternion(o.quaternion).add(o.position);
    _t.copy(aim).applyQuaternion(o.quaternion).add(o.position);
    const vel = ctx.world?.ship?.velocity as THREE.Vector3 | undefined;
    if (!inited) { sp.copy(_o); inited = true; }
    else if (vel) sp.addScaledVector(vel, ctx.dt);
    sp.lerp(_o, 1 - Math.exp(-(opts.lag ?? 18) * ctx.dt));
    _p.set(0, 1, 0).applyQuaternion(o.quaternion);
    look(out, sp, _t, _p);
    sq.copy(out.quat);
  };
}

/** Orbit a point (or object) at a radius. */
export function orbit(
  getCenter: (w: any) => THREE.Vector3 | THREE.Object3D | null,
  radius: number, startAngle: number, angularSpeed: number, height = 0,
  axis: THREE.Vector3 = new THREE.Vector3(0, 1, 0)
) {
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  return (t: number, _u: number, ctx: ShotCtx, out: CamState) => {
    const c = getCenter(ctx.world);
    if (!c) return;
    _t.copy((c as any).isObject3D ? (c as THREE.Object3D).position : (c as THREE.Vector3));
    // build a stable basis around `axis`
    right.set(1, 0, 0);
    if (Math.abs(axis.dot(right)) > 0.9) right.set(0, 0, 1);
    fwd.crossVectors(axis, right).normalize();
    right.crossVectors(fwd, axis).normalize();
    const a = startAngle + t * angularSpeed;
    _p.copy(_t)
      .addScaledVector(right, Math.cos(a) * radius)
      .addScaledVector(fwd, Math.sin(a) * radius)
      .addScaledVector(axis, height);
    look(out, _p, _t, axis);
  };
}

/** Fly the camera along a spline while aiming at a (possibly moving) target. */
export function spline(
  points: THREE.Vector3[],
  getTarget: (w: any) => THREE.Vector3 | THREE.Object3D | null,
  ease: (x: number) => number = (x) => x,
  up?: THREE.Vector3
) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.3);
  return (_t0: number, u: number, ctx: ShotCtx, out: CamState) => {
    curve.getPointAt(clamp(ease(clamp(u, 0, 1)), 0, 1), _p);
    const tg = getTarget(ctx.world);
    if (tg) _t.copy((tg as any).isObject3D ? (tg as THREE.Object3D).position : (tg as THREE.Vector3));
    else curve.getPointAt(clamp(ease(clamp(u, 0, 1)) + 0.02, 0, 1), _t);
    look(out, _p, _t, up);
  };
}

/** Blend two shot functions over the shot's own duration. */
export function morph(
  a: Shot['update'], b: Shot['update'], ease: (x: number) => number = easeInOutCubic,
  range: [number, number] = [0, 1]
): Shot['update'] {
  const sa = makeCamState(), sb = makeCamState();
  return (t, u, ctx, out) => {
    sa.fov = out.fov; sb.fov = out.fov;
    a(t, u, ctx, sa); b(t, u, ctx, sb);
    const k = ease(clamp(smoothstep(range[0], range[1], u), 0, 1));
    out.pos.lerpVectors(sa.pos, sb.pos, k);
    out.quat.copy(sa.quat).slerp(sb.quat, k);
    out.fov = lerp(sa.fov, sb.fov, k);
  };
}

/** Add a slow handheld drift on top of any shot. */
export function handheld(inner: Shot['update'], amount = 1, seed = 0): Shot['update'] {
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  return (t, u, ctx, out) => {
    inner(t, u, ctx, out);
    const g = ctx.time * 0.55 + seed;
    e.set(noise1(g, 1 + seed) * 0.0035 * amount, noise1(g, 2 + seed) * 0.0045 * amount, noise1(g * 0.7, 3 + seed) * 0.006 * amount, 'XYZ');
    out.quat.multiply(q.setFromEuler(e));
    out.pos.addScaledVector(_v.set(noise1(g * 0.8, 4 + seed), noise1(g * 0.8, 5 + seed), 0).applyQuaternion(out.quat), amount * 0.35);
  };
}
