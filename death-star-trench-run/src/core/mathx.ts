import * as THREE from 'three';

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const saturate = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v: number, a: number, b: number, c: number, d: number) => lerp(c, d, saturate(invLerp(a, b, v)));
export const smoothstep = (a: number, b: number, x: number) => {
  const t = saturate(invLerp(a, b, x));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a: number, b: number, x: number) => {
  const t = saturate(invLerp(a, b, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Frame-rate independent exponential damping. `lambda` = higher is snappier. */
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const dampV = (a: THREE.Vector3, b: THREE.Vector3, lambda: number, dt: number) => {
  const t = 1 - Math.exp(-lambda * dt);
  a.x += (b.x - a.x) * t; a.y += (b.y - a.y) * t; a.z += (b.z - a.z) * t;
  return a;
};
export const dampQ = (a: THREE.Quaternion, b: THREE.Quaternion, lambda: number, dt: number) => {
  a.slerp(b, 1 - Math.exp(-lambda * dt));
  return a;
};

// ---- easings (cinematic) ----
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number) => t * t * t;
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeInOutQuint = (t: number) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2);
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeOutBack = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

/** Critically damped spring toward target. Returns new [value, velocity]. */
export function spring(value: number, velocity: number, target: number, omega: number, dt: number): [number, number] {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const detX = f * value + dt * velocity + hhoo * target;
  const detV = velocity + hoo * (target - value);
  return [detX * detInv, detV * detInv];
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
