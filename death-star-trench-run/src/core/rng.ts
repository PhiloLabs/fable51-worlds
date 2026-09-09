/** Deterministic, seedable PRNG utilities shared by every procedural generator. */
export class RNG {
  private s: number;
  constructor(seed = 1337) { this.s = (seed >>> 0) || 1; }
  /** [0,1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1 - 1e-9)); }
  bool(p = 0.5) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  /** Gaussian-ish via sum of uniforms */
  gauss(mean = 0, sd = 1) { return mean + sd * ((this.next() + this.next() + this.next() + this.next() - 2) * 0.8660254); }
  fork(salt = 1) { return new RNG(Math.floor(this.next() * 0xffffffff) ^ (salt * 0x9e3779b9)); }
}

/** Stateless hash — same input always gives the same output. */
export function hash1(x: number): number {
  let h = Math.imul(x ^ 0x2545f491, 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 15), 0x297a2d39);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
export function hash2(x: number, y: number): number { return hash1(x * 374761393 + y * 668265263); }
export function hash3(x: number, y: number, z: number): number { return hash1(x * 374761393 + y * 668265263 + z * 2147483647); }
