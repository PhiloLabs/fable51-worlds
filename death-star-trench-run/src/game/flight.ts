import * as THREE from 'three';
import { clamp, damp, dampQ, lerp, smoothstep } from '../core/mathx';
import { Input } from '../core/input';
import {
  TRENCH_BOOST, TRENCH_DEPTH, TRENCH_HALF_WIDTH, TRENCH_SPEED,
  trenchQuat, trenchToWorld, PORT_S,
} from '../core/constants';
import { hash1 } from '../core/rng';

export type FlightMode = 'path' | 'trench' | 'free';

/** Only the part of the Trench module the flight code needs. */
export interface TrenchCollider {
  collide(s: number, lateral: number, up: number, radius: number):
    { lateral: number; up: number; hit: boolean; normal: THREE.Vector3 };
}

/** The trench drifts its centreline, width and floor height along `s`; the
 *  flight model has to fly the real profile, not a nominal box. */
export interface TrenchProfile {
  centre(s: number): number;
  floor(s: number): number;
  halfWidth(s: number): number;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _prev = new THREE.Vector3();

/** Smooth pseudo-random steering curve used by the autopilot. */
function wander(x: number, scale: number, seed: number) {
  const p = x / scale;
  const i = Math.floor(p), f = p - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i + seed * 7919) * 2 - 1;
  const b = hash1(i + 1 + seed * 7919) * 2 - 1;
  return a + (b - a) * u;
}

export class PlayerShip {
  mode: FlightMode = 'path';
  autopilot = true;

  position = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  velocity = new THREE.Vector3();
  radius = 7;

  /** trench-local state */
  s = 0;
  lateral = 0;
  up = -TRENCH_DEPTH * 0.5;
  private latVel = 0;
  private upVel = 0;

  speed = 0;
  throttle = 1;
  boosting = false;
  boostFuel = 1;

  /** visual attitude offsets, radians */
  bank = 0;
  pitchA = 0;
  yawA = 0;
  rollInput = 0;

  /** combat state */
  shield = 1;
  torpedoes = 2;
  laserHeat = 0;
  laserCooldown = 0;
  hitFlash = 0;
  hullHitTimer = 0;

  /** path-following state (space phases) */
  private path: THREE.CatmullRomCurve3 | null = null;
  private pathDuration = 1;
  private pathTime = 0;
  private pathBank = 0;
  private pathUp = new THREE.Vector3(0, 1, 0);
  pathDone = false;

  /** free flight */
  freeDir = new THREE.Vector3(0, 0, -1);
  freeSpeed = 300;

  /** set true while an external system (director/sequence) owns the transform */
  frozen = false;

  /** injected by the integrator from the trench module */
  profile: TrenchProfile | null = null;
  private pc(s: number) { return this.profile ? this.profile.centre(s) : 0; }
  private pf(s: number) { return this.profile ? this.profile.floor(s) : -TRENCH_DEPTH; }
  private ph(s: number) { return this.profile ? this.profile.halfWidth(s) : TRENCH_HALF_WIDTH; }

  // ---------------------------------------------------------------- paths
  setPath(points: THREE.Vector3[], duration: number, up?: THREE.Vector3) {
    this.path = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.25);
    this.pathDuration = duration;
    this.pathTime = 0;
    this.pathDone = false;
    if (up) this.pathUp.copy(up);
    this.mode = 'path';
  }
  clearPath() { this.path = null; }

  // ---------------------------------------------------------------- trench
  enterTrench(s: number, lateral?: number, up?: number) {
    this.mode = 'trench';
    this.s = s;
    this.lateral = lateral ?? this.pc(s);
    this.up = up ?? this.pf(s) + 48;
    this.latVel = 0; this.upVel = 0;
    this.speed = TRENCH_SPEED;
  }
  /** the point the entry path should aim at, in world space */
  trenchEntryPoint(s: number, out: THREE.Vector3) {
    return trenchToWorld(s, this.pc(s), this.pf(s) + 48, out);
  }

  // ---------------------------------------------------------------- update
  update(dt: number, time: number, input: Input | null, trench: TrenchCollider | null) {
    if (dt <= 0) return;
    _prev.copy(this.position);

    if (this.frozen) { /* transform owned elsewhere */ }
    else if (this.mode === 'path') this.updatePath(dt, time);
    else if (this.mode === 'trench') this.updateTrench(dt, time, input, trench);
    else this.updateFree(dt, time, input);

    this.velocity.subVectors(this.position, _prev).divideScalar(Math.max(dt, 1e-5));
    // NB: never feed the measured velocity back into `speed` in trench mode —
    // wall clamping would then inflate the commanded speed frame over frame.
    if (this.mode === 'free') this.speed = this.velocity.length() || this.speed;

    this.laserCooldown = Math.max(0, this.laserCooldown - dt);
    this.laserHeat = clamp(this.laserHeat - dt * 0.42, 0, 1);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.4);
    this.hullHitTimer = Math.max(0, this.hullHitTimer - dt);
    this.shield = clamp(this.shield + dt * 0.05, 0, 1);
    if (!this.boosting) this.boostFuel = clamp(this.boostFuel + dt * 0.22, 0, 1);
  }

  private updatePath(dt: number, _time: number) {
    if (!this.path) return;
    this.pathTime = Math.min(this.pathTime + dt, this.pathDuration);
    const u = this.pathTime / this.pathDuration;
    if (u >= 1) this.pathDone = true;
    this.path.getPointAt(clamp(u, 0, 1), this.position);
    this.path.getTangentAt(clamp(u, 0, 1), _v).normalize();
    // banking from the curvature of the path
    this.path.getTangentAt(clamp(u + 0.012, 0, 1), _v2).normalize();
    const cross = _v2.clone().cross(_v);
    const curl = cross.dot(_v.clone().cross(this.pathUp).normalize());
    this.pathBank = damp(this.pathBank, clamp(-curl * 26, -0.9, 0.9), 3.0, dt);

    _v2.copy(this.position).add(_v);
    const m = new THREE.Matrix4().lookAt(this.position, _v2, this.pathUp);
    _q.setFromRotationMatrix(m);
    _e.set(0, 0, this.pathBank, 'YXZ');
    _q2.setFromEuler(_e);
    _q.multiply(_q2);
    dampQ(this.quaternion, _q, 7, dt);
    this.speed = this.path.getLength() / this.pathDuration;
  }

  private updateFree(dt: number, _time: number, input: Input | null) {
    let yaw = 0, pitch = 0, roll = 0;
    if (input && !this.autopilot) {
      yaw = -input.axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
      pitch = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
      roll = input.axis(['KeyE'], ['KeyQ']);
    }
    _e.set(pitch * 1.1 * dt, yaw * 1.1 * dt, roll * 2.0 * dt, 'YXZ');
    _q.setFromEuler(_e);
    this.quaternion.multiply(_q).normalize();
    // steer toward freeDir when on autopilot
    if (this.autopilot) {
      _v.copy(this.position).addScaledVector(this.freeDir, 100);
      const m = new THREE.Matrix4().lookAt(this.position, _v, _v2.set(0, 1, 0));
      _q.setFromRotationMatrix(m);
      dampQ(this.quaternion, _q, 1.6, dt);
    }
    _v.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.speed = damp(this.speed, this.freeSpeed, 1.2, dt);
    this.position.addScaledVector(_v, this.speed * dt);
  }

  private updateTrench(dt: number, time: number, input: Input | null, trench: TrenchCollider | null) {
    const maxLat = 92;      // m/s lateral
    const maxUp = 74;       // m/s vertical
    let ix = 0, iy = 0, ir = 0;
    let wantBoost = false;

    if (input && !this.autopilot) {
      ix = input.axis(['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']);
      iy = input.axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
      ir = input.axis(['KeyE'], ['KeyQ']);
      wantBoost = input.isDown('ShiftLeft', 'ShiftRight');
    } else {
      // ---- autopilot: weave a believable line down the trench ----
      const cen = this.pc(this.s), flo = this.pf(this.s), hw = this.ph(this.s);
      const w1 = wander(this.s, 620, 3);
      const w2 = wander(this.s, 240, 11);
      let tgtLat = cen + (w1 * 0.58 + w2 * 0.18) * (hw - 44);
      let tgtUp = flo + 54 + wander(this.s, 480, 5) * 14;
      // approach the port dead-centre and low
      const toPort = PORT_S - this.s;
      if (toPort < 2600) {
        const k = smoothstep(2600, 700, toPort);
        tgtLat = lerp(tgtLat, this.pc(PORT_S), k);
        tgtUp = lerp(tgtUp, this.pf(PORT_S) + 40, k);
      }
      // look ahead and steer around whatever the trench says is solid
      if (trench) {
        // probe twice: just ahead (react to what we are about to touch) and
        // further out (commit to a line through the next obstacle)
        let safe = this.findClear(trench, this.s + 160, tgtLat, tgtUp);
        safe = this.findClear(trench, this.s + Math.max(340, this.speed * 0.9), safe.lateral, safe.up);
        tgtLat = safe.lateral; tgtUp = safe.up;
      }
      ix = clamp((tgtLat - this.lateral) * 0.05, -1, 1);
      iy = clamp((tgtUp - this.up) * 0.055, -1, 1);
      wantBoost = false;
    }

    this.boosting = wantBoost && this.boostFuel > 0.02;
    if (this.boosting) this.boostFuel = clamp(this.boostFuel - dt * 0.34, 0, 1);
    const target = this.boosting ? TRENCH_BOOST : TRENCH_SPEED;
    this.speed = damp(this.speed, target * this.throttle, this.boosting ? 1.6 : 1.1, dt);

    this.latVel = damp(this.latVel, ix * maxLat, 7.5, dt);
    this.upVel = damp(this.upVel, iy * maxUp, 7.0, dt);

    this.s += this.speed * dt;
    this.lateral += this.latVel * dt;
    this.up += this.upVel * dt;

    // walls / floor
    if (trench) {
      const c = trench.collide(this.s, this.lateral, this.up, this.radius);
      if (c.hit) {
        // clamp gently: a hard relocation would read as a teleport at 430 m/s
        const maxStep = 26 * dt * 60;
        const nl = clamp(c.lateral, this.lateral - maxStep, this.lateral + maxStep);
        const nu = clamp(c.up, this.up - maxStep, this.up + maxStep);
        if (nl !== this.lateral) this.latVel = Math.min(0, this.latVel * Math.sign(nl - this.lateral)) * 0;
        if (nu !== this.up) this.upVel = 0;
        this.lateral = nl; this.up = nu;
        if (this.hullHitTimer <= 0) {
          this.hullHitTimer = 0.35;
          this.shield = clamp(this.shield - 0.018, 0, 1);
          this.hitFlash = 0.6;
        }
      }
    } else {
      this.lateral = clamp(this.lateral, -TRENCH_HALF_WIDTH + this.radius, TRENCH_HALF_WIDTH - this.radius);
    }
    // never let the player climb out of the trench during the run — the whole
    // attack depends on staying below the lip
    const ceiling = -this.radius * 0.9;
    if (this.up > ceiling) { this.up = ceiling; if (this.upVel > 0) this.upVel = 0; }

    trenchToWorld(this.s, this.lateral, this.up, this.position);

    // attitude
    const latN = clamp(this.latVel / maxLat, -1, 1);
    const upN = clamp(this.upVel / maxUp, -1, 1);
    this.rollInput = damp(this.rollInput, ir, 6, dt);
    this.bank = damp(this.bank, -latN * 0.78 + this.rollInput * 0.95, 6.5, dt);
    this.pitchA = damp(this.pitchA, upN * 0.20, 6, dt);
    this.yawA = damp(this.yawA, latN * 0.11, 6, dt);
    // gentle idle roll so it never looks locked
    const idle = Math.sin(time * 0.63) * 0.018 + Math.sin(time * 1.31) * 0.009;

    trenchQuat(this.s, _q);
    _e.set(this.pitchA, this.yawA, this.bank + idle, 'YXZ');
    _q2.setFromEuler(_e);
    this.quaternion.copy(_q).multiply(_q2);
  }

  /** Search a small grid around the preferred point for somewhere the trench says is clear. */
  private _clear = { lateral: 0, up: 0 };
  private findClear(trench: TrenchCollider, s: number, lat: number, up: number) {
    const r = this.radius * 1.7;
    let c = trench.collide(s, lat, up, r);
    if (!c.hit) { this._clear.lateral = lat; this._clear.up = up; return this._clear; }
    this._clear.lateral = c.lateral; this._clear.up = c.up;
    const cen = this.pc(s), flo = this.pf(s), hw = this.ph(s);
    const dLat = [0, 0, 26, -26, 50, -50, 0, 34, -34, 70, -70];
    const dUp = [18, 34, 0, 0, 0, 0, -16, 24, 24, 10, 10];
    for (let i = 0; i < dLat.length; i++) {
      const L = clamp(lat + dLat[i], cen - hw + 18, cen + hw - 18);
      const U = clamp(up + dUp[i], flo + 16, -12);
      c = trench.collide(s, L, U, r);
      if (!c.hit) { this._clear.lateral = L; this._clear.up = U; return this._clear; }
    }
    // nothing clear — fall back to the corrected position the trench handed back
    this._clear.lateral = c.lateral; this._clear.up = c.up;
    return this._clear;
  }

  // ---------------------------------------------------------------- weapons
  canFireLaser() { return this.laserCooldown <= 0 && this.laserHeat < 0.98; }
  didFireLaser() { this.laserCooldown = 0.11; this.laserHeat = clamp(this.laserHeat + 0.075, 0, 1); }
  takeDamage(a: number) {
    this.shield = clamp(this.shield - a, 0, 1);
    this.hitFlash = Math.min(1, this.hitFlash + a * 3);
  }
  /** forward direction in world space */
  getForward(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.quaternion); }
  getUp(out = new THREE.Vector3()) { return out.set(0, 1, 0).applyQuaternion(this.quaternion); }
  getRight(out = new THREE.Vector3()) { return out.set(1, 0, 0).applyQuaternion(this.quaternion); }
}
