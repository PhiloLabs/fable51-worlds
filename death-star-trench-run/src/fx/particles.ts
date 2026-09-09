import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROT } from '../shaders/lib';
import { RNG } from '../core/rng';

/* =========================================================================
   GPU PARTICLES

   One `THREE.Points` per kind.  The CPU only ever writes a particle's spawn
   record (position / velocity / life / size / colour / seed); the vertex
   shader integrates the trajectory analytically from `uTime - spawnTime`, so
   `update()` costs four uniform writes regardless of how many particles are
   alive.  Storage is a ring buffer — the oldest particle is overwritten once
   capacity is reached.
   ========================================================================= */

export type ParticleKind = 'spark' | 'ember' | 'smoke';

export interface ParticlesOpts {
  capacity: number;
  kind: ParticleKind;
  /** constant acceleration (m/s^2) — gravity, buoyancy, outward drift */
  accel?: THREE.Vector3;
  /** exponential drag coefficient; v(t) = v0 * exp(-drag*t) */
  drag?: number;
  /** amplitude of the per-particle turbulent wander (m/s) */
  wander?: number;
  /** overall emissive multiplier (HDR) */
  intensity?: number;
  opacity?: number;
  renderOrder?: number;
  minPixels?: number;
  maxPixels?: number;
}

const COMMON_VERT_HEAD = /* glsl */ `
precision highp float;

attribute vec3  aVel;
attribute vec3  aColor;
attribute vec4  aData;   // spawnTime, life, size, extra(heat)
attribute float aSeed;

uniform float uTime;
uniform float uDrag;
uniform float uWander;
uniform float uPixelScale;   // 2*tan(fov/2)/screenHeightPx
uniform float uMinPixels;
uniform float uMaxPixels;
uniform vec3  uAccel;

varying float vAge01;
varying vec3  vColor;
varying float vSeed;
varying float vExtra;
varying float vFade;
`;

const COMMON_VERT_BODY = /* glsl */ `
  float age  = uTime - aData.x;
  float life = max(aData.y, 1e-4);
  float a01  = age / life;
  vAge01 = a01;
  vColor = aColor;
  vSeed  = aSeed;
  vExtra = aData.w;

  if (a01 < 0.0 || a01 >= 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  // exponential drag: x(t) = x0 + v0*(1-e^(-kt))/k
  float k = uDrag;
  float ie = (k > 1e-3) ? (1.0 - exp(-k * age)) / k : age;
  vec3 p = position + aVel * ie + 0.5 * uAccel * age * age;

  if (uWander > 0.0) {
    float sd = aSeed * 61.7;
    p += vec3(sin(age * 1.7 + sd), cos(age * 1.31 + sd * 1.7), sin(age * 2.1 + sd * 2.3))
         * uWander * age;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
`;

function sizeCurve(kind: ParticleKind): string {
  switch (kind) {
    case 'spark':
      // snap on, taper to nothing
      return `float sc = smoothstep(0.0, 0.05, a01) * pow(1.0 - a01, 0.75);`;
    case 'ember':
      return `float sc = smoothstep(0.0, 0.08, a01) * (0.55 + 0.45 * pow(1.0 - a01, 0.6));`;
    default:
      // smoke billows outward as it rises
      return `float sc = 0.28 + 1.55 * pow(a01, 0.5);`;
  }
}

function fadeCurve(kind: ParticleKind): string {
  switch (kind) {
    case 'spark':
      return `vFade = pow(1.0 - a01, 1.4);`;
    case 'ember':
      return `vFade = smoothstep(0.0, 0.06, a01) * pow(1.0 - a01, 1.8);`;
    default:
      return `vFade = smoothstep(0.0, 0.10, a01) * (1.0 - smoothstep(0.28, 1.0, a01));`;
  }
}

const SPARK_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_COLOR}

uniform float uTime;
uniform float uIntensity;
uniform float uOpacity;

varying float vAge01;
varying vec3  vColor;
varying float vSeed;
varying float vExtra;
varying float vFade;

void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float d = length(pc) * 2.0;
  if (d > 1.0) discard;

  // needle core + soft bloomy skirt (never a flat square dot)
  float core = pow(max(1.0 - d, 0.0), 4.0);
  float glow = pow(max(1.0 - d, 0.0), 1.3);

  // temperature falls over life -> white-hot, yellow, orange, red, out
  float heat = clamp(vExtra * pow(1.0 - vAge01, 1.25), 0.0, 1.0);
  float flick = 0.65 + 0.35 * sin(uTime * 47.0 + vSeed * 137.0)
                     * (0.4 + 0.6 * hash11(vSeed * 7.7));

  vec3 bb = blackbody(heat);
  vec3 col = mix(bb, bb * 0.45 + vColor * 1.15, 0.55);

  float I = (core * 3.0 + glow * 0.55) * vFade * flick;
  vec3 outc = col * I + vec3(1.0, 0.95, 0.88) * core * core * heat * 1.4 * vFade;
  gl_FragColor = vec4(outc * uIntensity, clamp(I, 0.0, 1.0) * uOpacity);
}
`;

const EMBER_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_COLOR}

uniform float uTime;
uniform float uIntensity;
uniform float uOpacity;

varying float vAge01;
varying vec3  vColor;
varying float vSeed;
varying float vExtra;
varying float vFade;

void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float d = length(pc) * 2.0;
  if (d > 1.0) discard;

  float core = pow(max(1.0 - d, 0.0), 3.0);
  float glow = pow(max(1.0 - d, 0.0), 1.1);

  // embers pulse slowly as they tumble
  float ph = vSeed * 121.0;
  float flick = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (5.0 + hash11(vSeed) * 9.0) + ph));
  float heat = clamp(vExtra * (0.35 + 0.65 * pow(1.0 - vAge01, 1.7)) * flick, 0.0, 1.0);

  vec3 bb = blackbody(heat * 0.86);
  vec3 col = mix(bb, vColor * (0.4 + heat), 0.4);

  float I = (core * 2.0 + glow * 0.4) * vFade;
  gl_FragColor = vec4(col * I * uIntensity, clamp(I, 0.0, 1.0) * uOpacity);
}
`;

const SMOKE_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${GLSL_ROT}

uniform float uTime;
uniform float uIntensity;
uniform float uOpacity;

varying float vAge01;
varying vec3  vColor;
varying float vSeed;
varying float vExtra;
varying float vFade;

void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float d = length(pc) * 2.0;
  if (d > 1.0) discard;

  // slow rotation + fbm gives billowing edges instead of a soft disc
  vec2 rp = rot2(vSeed * 6.2831 + vAge01 * 0.55) * pc;
  float n = fbm2(rp * 3.6 + vec2(vSeed * 37.0, vSeed * 11.0 + vAge01 * 0.6), 4, 2.1, 0.55);

  float edge = smoothstep(1.0, 0.08, d);
  float mask = edge * clamp(0.35 + 1.35 * n - 0.45 * d, 0.0, 1.0);
  if (mask <= 0.003) discard;

  // freshly-born smoke still carries firelight in its folds
  float heat = clamp(vExtra * pow(1.0 - vAge01, 3.0), 0.0, 1.0);
  vec3 col = vColor * (0.10 + 0.42 * n);
  col += blackbody(heat * (0.30 + 0.70 * n)) * heat * 0.75;

  float a = mask * vFade * uOpacity;
  gl_FragColor = vec4(col * uIntensity, clamp(a, 0.0, 1.0));
}
`;

export class GPUParticles {
  readonly points: THREE.Points;
  readonly capacity: number;
  readonly kind: ParticleKind;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private aPos: THREE.BufferAttribute;
  private aVel: THREE.BufferAttribute;
  private aCol: THREE.BufferAttribute;
  private aData: THREE.BufferAttribute;
  private aSeed: THREE.BufferAttribute;
  private attrs: THREE.BufferAttribute[] = [];
  private cursor = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -Infinity;
  /** absolute death time per slot, for the alive count */
  private death: Float32Array;
  private _alive = 0;

  constructor(opts: ParticlesOpts) {
    const cap = opts.capacity;
    this.capacity = cap;
    this.kind = opts.kind;
    this.death = new Float32Array(cap);

    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.aVel = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.aCol = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    this.aData = new THREE.BufferAttribute(new Float32Array(cap * 4), 4);
    this.aSeed = new THREE.BufferAttribute(new Float32Array(cap), 1);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aVel.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aData.setUsage(THREE.DynamicDrawUsage);
    this.aSeed.setUsage(THREE.DynamicDrawUsage);
    // everything starts dead (life 0, spawn -1)
    for (let i = 0; i < cap; i++) this.aData.array[i * 4 + 1] = 0;
    g.setAttribute('position', this.aPos);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aData', this.aData);
    g.setAttribute('aSeed', this.aSeed);
    this.attrs = [this.aPos, this.aVel, this.aCol, this.aData, this.aSeed];
    g.setDrawRange(0, cap);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geo = g;

    const frag = opts.kind === 'spark' ? SPARK_FRAG : opts.kind === 'ember' ? EMBER_FRAG : SMOKE_FRAG;
    const vert =
      COMMON_VERT_HEAD +
      'void main() {\n' +
      COMMON_VERT_BODY +
      '\n  ' + sizeCurve(opts.kind) +
      '\n  ' + fadeCurve(opts.kind) +
      '\n  float px = aData.z * sc * uPixelScale / max(-mv.z, 0.01);' +
      '\n  gl_PointSize = clamp(px, uMinPixels, uMaxPixels);' +
      '\n}\n';

    const smoke = opts.kind === 'smoke';
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDrag: { value: opts.drag ?? 0 },
        uWander: { value: opts.wander ?? 0 },
        uAccel: { value: (opts.accel ?? new THREE.Vector3()).clone() },
        uPixelScale: { value: 900 },
        uMinPixels: { value: opts.minPixels ?? (smoke ? 2 : 1.1) },
        uMaxPixels: { value: opts.maxPixels ?? (smoke ? 900 : 260) },
        uIntensity: { value: opts.intensity ?? (smoke ? 1.0 : 4.0) },
        uOpacity: { value: opts.opacity ?? (smoke ? 0.55 : 1.0) },
      },
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: smoke ? THREE.NormalBlending : THREE.AdditiveBlending,
      toneMapped: true,
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder ?? (smoke ? 8 : 12);
  }

  get material(): THREE.ShaderMaterial { return this.mat; }
  get aliveCount(): number { return this._alive; }

  /**
   * Spawn one particle. `heat` (0..1) drives the black-body ramp, `size` is in
   * metres (the on-screen size attenuates with distance).
   */
  emit(
    now: number,
    px: number, py: number, pz: number,
    vx: number, vy: number, vz: number,
    size: number, life: number,
    cr: number, cg: number, cb: number,
    heat: number, seed: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const p = this.aPos.array as Float32Array;
    const v = this.aVel.array as Float32Array;
    const c = this.aCol.array as Float32Array;
    const d = this.aData.array as Float32Array;
    const s = this.aSeed.array as Float32Array;

    p[i * 3] = px; p[i * 3 + 1] = py; p[i * 3 + 2] = pz;
    v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz;
    c[i * 3] = cr; c[i * 3 + 1] = cg; c[i * 3 + 2] = cb;
    d[i * 4] = now; d[i * 4 + 1] = life; d[i * 4 + 2] = size; d[i * 4 + 3] = heat;
    s[i] = seed;
    this.death[i] = now + life;

    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  /** Uniform + upload pass. `pixelScale` = screenHeightPx / (2*tan(fov/2)). */
  update(time: number, pixelScale: number): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uPixelScale.value = pixelScale;

    if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo, n = this.dirtyHi - this.dirtyLo + 1;
      for (let k = 0; k < this.attrs.length; k++) {
        const a = this.attrs[k];
        a.clearUpdateRanges();
        a.addUpdateRange(lo * a.itemSize, n * a.itemSize);
        a.needsUpdate = true;
      }
      this.dirtyLo = Infinity;
      this.dirtyHi = -Infinity;
    }
  }

  /** O(capacity) — call at a low rate, only for the HUD. */
  recount(time: number): number {
    let n = 0;
    const d = this.death;
    for (let i = 0; i < d.length; i++) if (d[i] > time) n++;
    this._alive = n;
    return n;
  }

  clear(): void {
    const d = this.aData.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) { d[i * 4] = -1e9; d[i * 4 + 1] = 0; }
    this.death.fill(-1e9);
    this._alive = 0;
    this.dirtyLo = 0;
    this.dirtyHi = this.capacity - 1;
    this.cursor = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* =========================================================================
   DEBRIS FIELD

   Eight distinct jagged plating fragments, one InstancedMesh each (they share
   one material).  Chunks tumble, cool from white-hot edges to dead metal, and
   shrink out instead of popping.
   ========================================================================= */

/** Build one irregular convex plating shard, normalised to ~unit radius. */
function makeChunk(rng: RNG): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const n = rng.int(7, 11);
  // squashed on one axis -> plate-like fragments, not pebbles
  const flat = rng.range(0.28, 0.60);
  for (let i = 0; i < n; i++) {
    pts.push(new THREE.Vector3(
      rng.gauss(0, 0.55),
      rng.gauss(0, 0.55) * flat,
      rng.gauss(0, 0.55),
    ));
  }
  // a couple of spikes so the silhouette has torn corners
  for (let i = 0; i < 2; i++) {
    pts.push(new THREE.Vector3(rng.gauss(0, 1.05), rng.gauss(0, 0.3) * flat, rng.gauss(0, 1.05)));
  }
  let g: THREE.BufferGeometry;
  try {
    g = new ConvexGeometry(pts);
  } catch {
    g = new THREE.TetrahedronGeometry(0.8, 0);
  }
  g = g.toNonIndexed ? (g.index ? g.toNonIndexed() : g) : g;

  // centre + normalise
  g.computeBoundingSphere();
  const bs = g.boundingSphere!;
  g.translate(-bs.center.x, -bs.center.y, -bs.center.z);
  const inv = 1 / Math.max(bs.radius, 1e-3);
  g.scale(inv, inv, inv);
  g.computeVertexNormals();

  // aEdge: 1 at the outermost verts (torn edges glow hottest)
  const pos = g.attributes.position;
  const cnt = pos.count;
  const edge = new Float32Array(cnt);
  let maxR = 1e-4;
  for (let i = 0; i < cnt; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
    edge[i] = r;
    if (r > maxR) maxR = r;
  }
  for (let i = 0; i < cnt; i++) edge[i] = Math.pow(edge[i] / maxR, 2.2);
  g.setAttribute('aEdge', new THREE.BufferAttribute(edge, 1));
  return g;
}

const DEBRIS_VERT = /* glsl */ `
precision highp float;
attribute float aEdge;
attribute vec4  aData;   // age01, seed, heat, spare
attribute vec3  aColor;

varying vec3  vNormalW;
varying vec3  vViewW;
varying float vEdge;
varying vec4  vData;
varying vec3  vColor;

void main() {
  vEdge = aEdge;
  vData = aData;
  vColor = aColor;

  mat3 im = mat3(instanceMatrix);
  vec4 wp = modelMatrix * (instanceMatrix * vec4(position, 1.0));
  vNormalW = normalize(mat3(modelMatrix) * normalize(im * normal));
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DEBRIS_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_COLOR}

uniform vec3  uLightDir;
uniform vec3  uLightColor;
uniform vec3  uAmbient;
uniform float uHotBoost;

varying vec3  vNormalW;
varying vec3  vViewW;
varying float vEdge;
varying vec4  vData;
varying vec3  vColor;

void main() {
  float age  = clamp(vData.x, 0.0, 1.0);
  float seed = vData.y;
  float heat0 = vData.z;

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewW);
  float ndl = max(dot(N, uLightDir), 0.0);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);

  vec3 albedo = vColor * (0.42 + 0.42 * hash11(seed * 13.0));
  vec3 lit = albedo * (uAmbient + uLightColor * (ndl * 1.15 + 0.05));
  lit += albedo * rim * 0.35;

  // hot torn edges cool through the black-body ramp
  float heat = clamp(heat0 * pow(1.0 - age, 2.1), 0.0, 1.0);
  float flick = 0.75 + 0.25 * sin(seed * 91.0 + age * 40.0);
  vec3 hot = blackbody(heat) * heat * (0.18 + 1.15 * vEdge) * uHotBoost * flick;

  float alpha = 1.0 - smoothstep(0.82, 1.0, age);
  gl_FragColor = vec4(lit + hot, alpha);
}
`;

interface Chunk {
  active: boolean;
  variant: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  spinAxis: THREE.Vector3;
  spinRate: number;
  scale: number;
  age: number;
  life: number;
  heat: number;
  seed: number;
  color: THREE.Color;
}

const VARIANTS = 8;
const _dq = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _mtx = new THREE.Matrix4();

export class DebrisField {
  readonly group: THREE.Group;
  readonly capacity: number;

  private meshes: THREE.InstancedMesh[] = [];
  private colAttr: THREE.InstancedBufferAttribute[] = [];
  private dataAttr: THREE.InstancedBufferAttribute[] = [];
  private mat: THREE.ShaderMaterial;
  private geos: THREE.BufferGeometry[] = [];
  private chunks: Chunk[] = [];
  private free: number[] = [];
  private perMesh: number;
  private counts: number[] = [];
  private _alive = 0;
  /** metres/s^2, applied to every chunk (usually zero in space) */
  gravity = new THREE.Vector3(0, 0, 0);
  drag = 0.35;

  constructor(capacity = 512, seed = 9021) {
    this.capacity = capacity;
    this.perMesh = Math.ceil(capacity / VARIANTS);
    this.group = new THREE.Group();
    this.group.name = 'fx-debris';

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uLightDir: { value: new THREE.Vector3(0.45, 0.75, 0.48).normalize() },
        uLightColor: { value: new THREE.Color(1.0, 0.96, 0.9) },
        uAmbient: { value: new THREE.Color(0.10, 0.13, 0.18) },
        uHotBoost: { value: 1.6 },
      },
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: true,
    });

    const rng = new RNG(seed);
    for (let v = 0; v < VARIANTS; v++) {
      const g = makeChunk(rng.fork(v + 1));
      const col = new THREE.InstancedBufferAttribute(new Float32Array(this.perMesh * 3), 3);
      const dat = new THREE.InstancedBufferAttribute(new Float32Array(this.perMesh * 4), 4);
      col.setUsage(THREE.DynamicDrawUsage);
      dat.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aColor', col);
      g.setAttribute('aData', dat);
      const m = new THREE.InstancedMesh(g, this.mat, this.perMesh);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = 4;
      this.group.add(m);
      this.meshes.push(m);
      this.colAttr.push(col);
      this.dataAttr.push(dat);
      this.geos.push(g);
      this.counts.push(0);
    }

    for (let i = 0; i < capacity; i++) {
      this.chunks.push({
        active: false, variant: i % VARIANTS,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(), spinAxis: new THREE.Vector3(0, 1, 0),
        spinRate: 0, scale: 1, age: 0, life: 1, heat: 1, seed: 0,
        color: new THREE.Color(0.42, 0.44, 0.48),
      });
      this.free.push(i);
    }
  }

  get material(): THREE.ShaderMaterial { return this.mat; }
  get aliveCount(): number { return this._alive; }

  spawn(
    pos: THREE.Vector3, vel: THREE.Vector3, scale: number, life: number,
    heat: number, color: THREE.Color, rng: RNG,
  ): void {
    let idx = this.free.pop();
    if (idx === undefined) {
      // steal the oldest-looking chunk (highest age fraction)
      let best = -1, bestA = -1;
      for (let i = 0; i < this.chunks.length; i++) {
        const c = this.chunks[i];
        const a = c.age / c.life;
        if (a > bestA) { bestA = a; best = i; }
      }
      if (best < 0) return;
      idx = best;
    }
    const c = this.chunks[idx];
    c.active = true;
    c.variant = rng.int(0, VARIANTS - 1);
    c.pos.copy(pos);
    c.vel.copy(vel);
    c.quat.set(rng.gauss(), rng.gauss(), rng.gauss(), rng.gauss()).normalize();
    c.spinAxis.set(rng.gauss(), rng.gauss(), rng.gauss()).normalize();
    c.spinRate = rng.range(1.5, 9.0) * rng.sign();
    c.scale = scale;
    c.age = 0;
    c.life = life;
    c.heat = heat;
    c.seed = rng.next();
    c.color.copy(color);
  }

  update(dt: number): void {
    for (let v = 0; v < VARIANTS; v++) this.counts[v] = 0;
    let alive = 0;

    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (!c.active) continue;
      c.age += dt;
      if (c.age >= c.life) {
        c.active = false;
        this.free.push(i);
        continue;
      }
      alive++;

      const damp = Math.exp(-this.drag * dt);
      c.pos.addScaledVector(c.vel, dt);
      c.vel.multiplyScalar(damp);
      c.vel.addScaledVector(this.gravity, dt);

      const ang = c.spinRate * dt;
      _dq.setFromAxisAngle(c.spinAxis, ang);
      c.quat.multiply(_dq);

      const a01 = c.age / c.life;
      // shrink out over the last stretch so nothing pops
      const s = c.scale * (1.0 - Math.pow(Math.max(0, (a01 - 0.72) / 0.28), 1.4));
      _sc.set(s, s, s);
      _mtx.compose(c.pos, c.quat, _sc);

      const v = c.variant;
      const slot = this.counts[v];
      if (slot >= this.perMesh) continue;
      this.counts[v] = slot + 1;

      this.meshes[v].setMatrixAt(slot, _mtx);
      const da = this.dataAttr[v].array as Float32Array;
      da[slot * 4] = a01;
      da[slot * 4 + 1] = c.seed;
      da[slot * 4 + 2] = c.heat;
      da[slot * 4 + 3] = 0;
      const ca = this.colAttr[v].array as Float32Array;
      ca[slot * 3] = c.color.r; ca[slot * 3 + 1] = c.color.g; ca[slot * 3 + 2] = c.color.b;
    }

    this._alive = alive;
    for (let v = 0; v < VARIANTS; v++) {
      const n = this.counts[v];
      const m = this.meshes[v];
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.needsUpdate = true;
        this.colAttr[v].needsUpdate = true;
        this.dataAttr[v].needsUpdate = true;
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i].active) { this.chunks[i].active = false; this.free.push(i); }
    }
    for (let v = 0; v < VARIANTS; v++) { this.meshes[v].count = 0; this.counts[v] = 0; }
    this._alive = 0;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.meshes) m.dispose();
    this.mat.dispose();
  }
}
