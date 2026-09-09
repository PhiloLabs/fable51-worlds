import * as THREE from 'three';
import { RNG } from '../core/rng';
import { clamp } from '../core/mathx';
import { COL_IMP_LASER, COL_REBEL_LASER, COL_TURBO } from '../core/constants';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR } from '../shaders/lib';
import { createBoltGeometry, createLaserMaterial } from '../shaders/laser';
import { GPUParticles, DebrisField } from './particles';

/* =========================================================================
   FX — the pooled combat effects facade.

   Everything lives under one Group. Nothing allocates during update():
   all pools are pre-sized and every scratch vector is module-scope.

     lasers    512 instanced bolts        (1 draw call)
     flashes    96 billboard flashes      (1 draw call, GPU-animated from spawn time)
     rings      64 oriented shock rings   (1 draw call, GPU-animated)
     sparks   4000 GPU particles          (1 draw call)
     embers   2000 GPU particles          (1 draw call)
     smoke     600 GPU particles          (1 draw call)
     debris    512 instanced chunks       (8 shapes -> 8 draw calls)
     blasts     10 explosion rigs x 3 FBM-displaced shells
     lights      4 pooled PointLights (brightest wins)
   ========================================================================= */

export interface LaserOpts {
  color?: THREE.Color;
  speed?: number;      // m/s, default 2200
  length?: number;     // bolt length m, default 26
  radius?: number;     // default 0.45
  life?: number;       // seconds, default 2.4
  team?: 'rebel' | 'imperial' | 'turbo';
  muzzleFlash?: boolean;
}

export interface ExplosionOpts {
  life?: number; color?: THREE.Color; debris?: number;
  light?: boolean; shock?: boolean; smoke?: boolean; seed?: number;
}

export interface HitResult { point: THREE.Vector3; normal: THREE.Vector3; kind?: string; }

/* ------------------------------------------------------------- capacities */
const CAP_LASERS = 512;
const CAP_FLASH = 96;
const CAP_RING = 64;
const CAP_SPARK = 4000;
const CAP_EMBER = 2000;
const CAP_SMOKE = 600;
const CAP_DEBRIS = 512;
const CAP_BLAST = 10;
const CAP_LIGHT = 4;

/* ------------------------------------------------------------ scratch ----
   One dedicated set per entry point so nested calls can never clobber each
   other's vectors.                                                          */
const _prevPos = new THREE.Vector3();
const _tail = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _mtx = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _AXIS_Z = new THREE.Vector3(0, 0, 1);

const _rgNrm = new THREE.Vector3();     // spawnRing
const _rgScl = new THREE.Vector3();

const _mzDir = new THREE.Vector3();     // muzzleFlash
const _mzPos = new THREE.Vector3();
const _mzVel = new THREE.Vector3();

const _imNrm = new THREE.Vector3();     // impact
const _imPos = new THREE.Vector3();
const _imVel = new THREE.Vector3();

const _spNrm = new THREE.Vector3();     // sparks
const _spVel = new THREE.Vector3();

const _dbPos = new THREE.Vector3();     // debrisBurst
const _dbVel = new THREE.Vector3();

const _smPos = new THREE.Vector3();     // smokePuff
const _smVel = new THREE.Vector3();
const _smOff = new THREE.Vector3();

const _exDir = new THREE.Vector3();     // explosion
const _exTmp = new THREE.Vector3();
const _exVel = new THREE.Vector3();
const _exPos = new THREE.Vector3();

const _trA = new THREE.Vector3();       // ember trails
const _trB = new THREE.Vector3();
const _trC = new THREE.Vector3();
const _trD = new THREE.Vector3();

const _c0 = new THREE.Color();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();

/* =========================================================================
   Billboard flash — instant white pop + halo + star spikes + shell ring.
   The CPU writes one record per flash; the GPU animates it from uTime.
   ========================================================================= */

const FLASH_VERT = /* glsl */ `
precision highp float;
attribute vec4 aData;    // spawnTime, life, size, seed
attribute vec3 aColor;
uniform float uTime;
varying vec2  vUv;
varying float vA;
varying vec3  vColor;
varying float vSeed;
void main() {
  float a01 = (uTime - aData.x) / max(aData.y, 1e-4);
  vUv = uv; vA = a01; vColor = aColor; vSeed = aData.w;
  if (a01 < 0.0 || a01 >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // pops to near full size instantly, then swells
  float s = aData.z * (0.55 + 0.75 * pow(a01, 0.42));
  vec3 originVS = (modelViewMatrix * (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0))).xyz;
  vec3 p = originVS + vec3(position.x, position.y, 0.0) * s;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const FLASH_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_COLOR}
uniform float uIntensity;
varying vec2  vUv;
varying float vA;
varying vec3  vColor;
varying float vSeed;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float inv = max(1.0 - r, 0.0);

  float core = pow(inv, 7.0) * 3.2;
  float halo = pow(inv, 2.0) * 0.85;
  float wide = pow(inv, 1.05) * 0.26;

  float ang = atan(p.y, p.x);
  float spikes = pow(abs(cos(ang * 2.0 + vSeed * 6.2831)), 26.0) * pow(inv, 1.25) * 0.8;
  float streak = exp(-abs(p.y) * 20.0) * exp(-abs(p.x) * 1.35) * 0.5;

  // thin expanding shell
  float rr = pow(vA, 0.44);
  float th = max(0.10 * (1.0 - vA * 0.7), 0.02);
  float shell = exp(-pow((r - rr) / th, 2.0)) * (1.0 - vA) * 0.9;

  float decay = pow(max(1.0 - vA, 0.0), 1.7);
  float I = (core + halo + wide + spikes + streak + shell) * decay;

  // white at ignition, settling into the tint as it dies
  vec3 c = mix(vec3(1.0, 0.99, 0.96), vColor, smoothstep(0.04, 0.5, vA));
  vec3 col = c * I + vec3(1.0) * core * decay * 0.7;
  gl_FragColor = vec4(col * uIntensity, clamp(I, 0.0, 1.0));
}
`;

/* =========================================================================
   Oriented shock ring — a quad whose annulus radius is driven by age.
   ========================================================================= */

const RING_VERT = /* glsl */ `
precision highp float;
attribute vec4 aData;   // spawnTime, life, seed, thickness
attribute vec3 aColor;
uniform float uTime;
varying vec2  vUv;
varying float vA;
varying vec3  vColor;
varying float vSeed;
varying float vTh;
void main() {
  float a01 = (uTime - aData.x) / max(aData.y, 1e-4);
  vUv = uv; vA = a01; vColor = aColor; vSeed = aData.z; vTh = aData.w;
  if (a01 < 0.0 || a01 >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  gl_Position = projectionMatrix * modelViewMatrix * (instanceMatrix * vec4(position, 1.0));
}
`;

const RING_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}
uniform float uIntensity;
varying vec2  vUv;
varying float vA;
varying vec3  vColor;
varying float vSeed;
varying float vTh;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;

  float ang = atan(p.y, p.x);
  // ragged, turbulent front instead of a perfect circle
  float rag = 0.965 + 0.07 * (fbm2(vec2(ang * 6.5, vSeed * 33.0), 3, 2.2, 0.55) - 0.5) * 2.0;
  float rr = pow(vA, 0.40) * rag;
  float th = max(mix(0.075, 0.010, pow(vA, 0.6)) * vTh, 0.006);

  float d = (r - rr) / th;
  float ring = exp(-d * d);
  float wash = smoothstep(rr, rr - th * 7.0, r) * 0.07 * (1.0 - vA);

  float decay = pow(max(1.0 - vA, 0.0), 1.5);
  float I = (ring * 1.35 + wash) * decay;
  if (I < 0.002) discard;

  vec3 hot = mix(vec3(1.0, 0.94, 0.78), vColor * vec3(1.1, 0.75, 0.45), smoothstep(0.0, 0.30, vA));
  vec3 col = hot * I + vec3(1.0, 0.97, 0.9) * pow(ring, 5.0) * pow(decay, 2.5) * 0.55;
  gl_FragColor = vec4(col * uIntensity, clamp(I, 0.0, 1.0));
}
`;

/* =========================================================================
   Explosion shell — FBM-displaced icosphere, black-body ramp.
   Three nested shells with different density thresholds; the gaps in the
   outer ones let the inner ones show through, which is what keeps a big
   blast from reading as one smooth glowing ball.
   ========================================================================= */

const SHELL_VERT = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}
uniform float uTime, uSeed, uDisp, uNoiseScale, uAge01, uChurn;
varying vec3  vDir;
varying float vDisp;
varying vec3  vNormalW;
varying vec3  vViewW;
void main() {
  vec3 n = normalize(position);
  vec3 q = n * uNoiseScale + vec3(uSeed * 17.3, uSeed * 31.7, uSeed * 7.1);
  // Keep the displacement band-limited: the top octave must stay coarser than
  // the vertex spacing or the icosphere grows spikes instead of billows.
  q = warp3(q + vec3(0.0, uTime * uChurn, uTime * uChurn * 0.4), 0.30, 0.85);
  float f = fbm3(q, 3, 2.0, 0.5);
  float rg = ridged3(q * 1.35, 2, 2.1, 0.5);
  float d = (f - 0.5) * 2.0 * uDisp + (rg - 0.45) * uDisp * 0.8;
  // smooth at ignition, lumpy as it billows out
  d *= mix(0.30, 1.0, smoothstep(0.0, 0.30, uAge01));
  vDisp = d;
  vDir = n;
  vec3 pos = n * (1.0 + d);
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * n);
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
uniform float uTime, uSeed, uAge01, uHeat, uBright, uOpacity, uThresh, uDetail, uChurn;
uniform float uDispHeat, uFresHeat, uContrast;
uniform vec3  uTint;
varying vec3  vDir;
varying float vDisp;
varying vec3  vNormalW;
varying vec3  vViewW;
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewW);
  float fres = pow(1.0 - abs(dot(N, V)), 1.8);

  vec3 q = vDir * uDetail + vec3(uSeed * 11.7);
  float n1  = fbm3(q + vec3(0.0, uTime * uChurn * 1.6, 0.0), 4, 2.2, 0.52);
  float rid = ridged3(q * 2.05 - vec3(uTime * uChurn), 3, 2.3, 0.5);

  // hard-edged billows: the gaps are what let the inner shells read through
  float raw = n1 * 1.55 + vDisp * 1.25 + fres * 0.80;
  float dens = smoothstep(uThresh, uThresh + uContrast, raw);
  if (dens < 0.004) discard;

  // hot filaments live in the ridges; everything cools with age
  float temp = uHeat * (0.35 + 0.85 * rid) * (0.50 + 0.75 * n1)
             + vDisp * uDispHeat + fres * uFresHeat;
  temp = clamp(temp, 0.0, 1.0);

  vec3 col = blackbody(temp) * uTint;
  // sooty edges once it has cooled
  col = mix(col, col * vec3(0.50, 0.36, 0.32), smoothstep(0.35, 1.0, uAge01) * (1.0 - temp));

  float a = clamp(dens * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col * uBright, a);
}
`;

/* ------------------------------------------------------------------------ */

interface Bolt {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  color: THREE.Color;
  speed: number; len: number; rad: number; life: number; age: number;
  team: string; seed: number;
}

interface ShellCfg {
  s0: number; s1: number;      // radius multipliers at t=0 and t=1
  bright: number; opacity: number; thresh: number; contrast: number;
  disp: number; noiseScale: number; detail: number; churn: number;
  heat: number; heatPow: number; dispHeat: number; fresHeat: number;
  fadeOut: number;
}

const SHELL_CFG: ShellCfg[] = [
  // inner core — small, dense, white hot, dies fast
  { s0: 0.13, s1: 0.72, bright: 1.7, opacity: 0.95, thresh: 0.42, contrast: 0.55, disp: 0.20, noiseScale: 2.0, detail: 3.4, churn: 0.95, heat: 1.30, heatPow: 1.05, dispHeat: 0.55, fresHeat: 0.22, fadeOut: 0.40 },
  // fireball — the main event
  { s0: 0.28, s1: 2.00, bright: 0.60, opacity: 0.92, thresh: 0.72, contrast: 0.42, disp: 0.36, noiseScale: 2.2, detail: 4.4, churn: 0.55, heat: 0.95, heatPow: 1.75, dispHeat: 0.45, fresHeat: 0.15, fadeOut: 0.92 },
  // outer billow — cools to sooty smoke
  { s0: 0.42, s1: 3.10, bright: 0.36, opacity: 0.72, thresh: 0.92, contrast: 0.55, disp: 0.52, noiseScale: 1.7, detail: 4.6, churn: 0.32, heat: 0.48, heatPow: 2.30, dispHeat: 0.18, fresHeat: 0.05, fadeOut: 1.00 },
];

interface Blast {
  group: THREE.Group;
  shells: THREE.Mesh[];
  mats: THREE.ShaderMaterial[];
  active: boolean;
  age: number; life: number; radius: number;
  smokeAcc: number;
  wantSmoke: boolean;
  tint: THREE.Color;
  spinAxis: THREE.Vector3;
  spinRate: number;
}

interface LightSlot {
  light: THREE.PointLight;
  age: number; life: number; base: number; active: boolean;
}

interface Trail {
  obj: THREE.Object3D;
  last: THREE.Vector3;
  started: boolean;
  acc: number;
  timeAcc: number;
}

export class FX {
  group: THREE.Group;
  hitTest: ((from: THREE.Vector3, to: THREE.Vector3, team: string) => HitResult | null) | null = null;

  /** global emissive multiplier — dial the whole VFX layer up or down */
  intensity = 1;

  private scene: THREE.Scene;
  private rng = new RNG(0xBEEF);
  private time = 0;
  private frame = 0;
  private pixelScale = 900;      // screen px per world unit at 1 m

  /* lasers */
  private boltGeo: THREE.BufferGeometry;
  private boltMat: THREE.ShaderMaterial;
  private boltMesh: THREE.InstancedMesh;
  private boltColor: THREE.InstancedBufferAttribute;
  private boltData: THREE.InstancedBufferAttribute;
  private bolts: Bolt[] = [];
  private nBolts = 0;

  /* flashes */
  private flashMesh: THREE.InstancedMesh;
  private flashData: THREE.InstancedBufferAttribute;
  private flashColor: THREE.InstancedBufferAttribute;
  private flashMat: THREE.ShaderMaterial;
  private flashGeo: THREE.BufferGeometry;
  private flashCursor = 0;

  /* rings */
  private ringMesh: THREE.InstancedMesh;
  private ringData: THREE.InstancedBufferAttribute;
  private ringColor: THREE.InstancedBufferAttribute;
  private ringMat: THREE.ShaderMaterial;
  private ringGeo: THREE.BufferGeometry;
  private ringCursor = 0;

  /* particles */
  private sparkSys: GPUParticles;
  private emberSys: GPUParticles;
  private smokeSys: GPUParticles;

  /* debris */
  private debrisField: DebrisField;

  /* explosions */
  private blasts: Blast[] = [];
  private shellGeo: THREE.BufferGeometry;
  private nBlasts = 0;

  /* lights */
  private lightSlots: LightSlot[] = [];

  /* ember trails */
  private trails: Trail[] = [];

  private particleCount = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'fx';
    scene.add(this.group);

    /* ---------------- lasers ---------------- */
    this.boltGeo = createBoltGeometry();
    this.boltMat = createLaserMaterial();
    this.boltColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_LASERS * 3), 3);
    this.boltData = new THREE.InstancedBufferAttribute(new Float32Array(CAP_LASERS * 4), 4);
    this.boltColor.setUsage(THREE.DynamicDrawUsage);
    this.boltData.setUsage(THREE.DynamicDrawUsage);
    this.boltGeo.setAttribute('aColor', this.boltColor);
    this.boltGeo.setAttribute('aData', this.boltData);
    this.boltMesh = new THREE.InstancedMesh(this.boltGeo, this.boltMat, CAP_LASERS);
    this.boltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boltMesh.frustumCulled = false;
    this.boltMesh.count = 0;
    this.boltMesh.renderOrder = 14;
    this.boltMesh.name = 'fx-lasers';
    this.group.add(this.boltMesh);
    for (let i = 0; i < CAP_LASERS; i++) {
      this.bolts.push({
        pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1),
        color: new THREE.Color(1, 0.2, 0.1),
        speed: 2200, len: 26, rad: 0.45, life: 2.4, age: 0, team: 'rebel', seed: 0,
      });
    }

    /* ---------------- flashes ---------------- */
    this.flashGeo = new THREE.PlaneGeometry(2, 2);
    this.flashData = new THREE.InstancedBufferAttribute(new Float32Array(CAP_FLASH * 4), 4);
    this.flashColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_FLASH * 3), 3);
    this.flashData.setUsage(THREE.DynamicDrawUsage);
    this.flashColor.setUsage(THREE.DynamicDrawUsage);
    this.flashGeo.setAttribute('aData', this.flashData);
    this.flashGeo.setAttribute('aColor', this.flashColor);
    this.flashMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 3.0 } },
      vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, toneMapped: true,
    });
    this.flashMesh = new THREE.InstancedMesh(this.flashGeo, this.flashMat, CAP_FLASH);
    this.flashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flashMesh.frustumCulled = false;
    this.flashMesh.count = CAP_FLASH;
    this.flashMesh.renderOrder = 16;
    this.flashMesh.name = 'fx-flash';
    this.group.add(this.flashMesh);
    for (let i = 0; i < CAP_FLASH; i++) {
      (this.flashData.array as Float32Array)[i * 4] = -1e9;
      (this.flashData.array as Float32Array)[i * 4 + 1] = 1;
    }

    /* ---------------- rings ---------------- */
    this.ringGeo = new THREE.PlaneGeometry(2, 2);
    this.ringData = new THREE.InstancedBufferAttribute(new Float32Array(CAP_RING * 4), 4);
    this.ringColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP_RING * 3), 3);
    this.ringData.setUsage(THREE.DynamicDrawUsage);
    this.ringColor.setUsage(THREE.DynamicDrawUsage);
    this.ringGeo.setAttribute('aData', this.ringData);
    this.ringGeo.setAttribute('aColor', this.ringColor);
    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.95 } },
      vertexShader: RING_VERT, fragmentShader: RING_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, toneMapped: true,
    });
    this.ringMesh = new THREE.InstancedMesh(this.ringGeo, this.ringMat, CAP_RING);
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.count = CAP_RING;
    this.ringMesh.renderOrder = 15;
    this.ringMesh.name = 'fx-rings';
    this.group.add(this.ringMesh);
    for (let i = 0; i < CAP_RING; i++) {
      (this.ringData.array as Float32Array)[i * 4] = -1e9;
      (this.ringData.array as Float32Array)[i * 4 + 1] = 1;
    }

    /* ---------------- particles ---------------- */
    this.sparkSys = new GPUParticles({
      capacity: CAP_SPARK, kind: 'spark', drag: 2.6, wander: 0.35,
      intensity: 2.0, renderOrder: 12, maxPixels: 180,
    });
    this.emberSys = new GPUParticles({
      capacity: CAP_EMBER, kind: 'ember', drag: 0.9, wander: 0.9,
      intensity: 1.5, renderOrder: 12, maxPixels: 140,
    });
    this.smokeSys = new GPUParticles({
      capacity: CAP_SMOKE, kind: 'smoke', drag: 1.35, wander: 1.6,
      intensity: 1.0, opacity: 0.44, renderOrder: 8, maxPixels: 1400,
    });
    this.sparkSys.points.name = 'fx-sparks';
    this.emberSys.points.name = 'fx-embers';
    this.smokeSys.points.name = 'fx-smoke';
    this.group.add(this.sparkSys.points, this.emberSys.points, this.smokeSys.points);

    /* ---------------- debris ---------------- */
    this.debrisField = new DebrisField(CAP_DEBRIS, 4711);
    this.group.add(this.debrisField.group);

    /* ---------------- explosions ---------------- */
    // PolyhedronGeometry: (detail+1)^2 tris per icosa face -> 20*169 = 3380 tris.
    // Needs to be this dense or the FBM displacement shows flat plates.
    this.shellGeo = new THREE.IcosahedronGeometry(1, 12);
    for (let i = 0; i < CAP_BLAST; i++) {
      const g = new THREE.Group();
      g.name = 'fx-blast';
      g.visible = false;
      const shells: THREE.Mesh[] = [];
      const mats: THREE.ShaderMaterial[] = [];
      for (let s = 0; s < SHELL_CFG.length; s++) {
        const cfg = SHELL_CFG[s];
        const m = new THREE.ShaderMaterial({
          uniforms: {
            uTime: { value: 0 }, uSeed: { value: 0 }, uAge01: { value: 0 },
            uHeat: { value: 1 }, uBright: { value: cfg.bright }, uOpacity: { value: cfg.opacity },
            uThresh: { value: cfg.thresh }, uDisp: { value: cfg.disp },
            uNoiseScale: { value: cfg.noiseScale }, uDetail: { value: cfg.detail },
            uChurn: { value: cfg.churn }, uTint: { value: new THREE.Color(1, 1, 1) },
            uDispHeat: { value: cfg.dispHeat }, uFresHeat: { value: cfg.fresHeat },
            uContrast: { value: cfg.contrast },
          },
          vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
          transparent: true, depthWrite: false, depthTest: true,
          side: THREE.FrontSide, blending: THREE.AdditiveBlending, toneMapped: true,
        });
        const mesh = new THREE.Mesh(this.shellGeo, m);
        mesh.frustumCulled = false;
        mesh.renderOrder = 9 + (SHELL_CFG.length - 1 - s);
        g.add(mesh);
        shells.push(mesh);
        mats.push(m);
      }
      this.group.add(g);
      this.blasts.push({
        group: g, shells, mats, active: false,
        age: 0, life: 1, radius: 1, smokeAcc: 0,
        wantSmoke: true, tint: new THREE.Color(1, 1, 1),
        spinAxis: new THREE.Vector3(0, 1, 0), spinRate: 0,
      });
    }

    /* ---------------- lights ---------------- */
    for (let i = 0; i < CAP_LIGHT; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 100, 2);
      l.visible = false;
      this.group.add(l);
      this.lightSlots.push({ light: l, age: 0, life: 1, base: 0, active: false });
    }
  }

  /** Match the debris shading to the integrator's key light. */
  setKeyLight(dir: THREE.Vector3, color?: THREE.Color, ambient?: THREE.Color): void {
    const u = this.debrisField.material.uniforms;
    (u.uLightDir.value as THREE.Vector3).copy(dir).normalize();
    if (color) (u.uLightColor.value as THREE.Color).copy(color);
    if (ambient) (u.uAmbient.value as THREE.Color).copy(ambient);
  }

  /* ====================================================================== */
  /*  LASERS                                                                 */
  /* ====================================================================== */

  laser(origin: THREE.Vector3, dir: THREE.Vector3, opts?: LaserOpts): void {
    const team = opts?.team ?? 'rebel';
    if (this.nBolts >= CAP_LASERS) {
      let oldest = 0, a = -1;
      for (let i = 0; i < this.nBolts; i++) if (this.bolts[i].age > a) { a = this.bolts[i].age; oldest = i; }
      this.swapRemoveBolt(oldest);
    }
    const b = this.bolts[this.nBolts++];
    b.pos.copy(origin);
    b.dir.copy(dir);
    if (b.dir.lengthSq() < 1e-9) b.dir.set(0, 0, 1); else b.dir.normalize();
    const turbo = team === 'turbo';
    b.speed = opts?.speed ?? (turbo ? 3200 : 2200);
    b.len = opts?.length ?? (turbo ? 90 : 26);
    b.rad = opts?.radius ?? (turbo ? 1.5 : 0.45);
    b.life = opts?.life ?? 2.4;
    b.age = 0;
    b.team = team;
    b.seed = this.rng.next();
    if (opts?.color) b.color.copy(opts.color);
    else b.color.copy(team === 'rebel' ? COL_REBEL_LASER : turbo ? COL_TURBO : COL_IMP_LASER);

    if (opts?.muzzleFlash !== false) this.muzzleFlash(origin, b.dir, b.color, turbo ? 3.2 : 1.0);
  }

  private swapRemoveBolt(i: number): void {
    const last = --this.nBolts;
    if (i !== last) {
      const t = this.bolts[i];
      this.bolts[i] = this.bolts[last];
      this.bolts[last] = t;
    }
  }

  /* ====================================================================== */
  /*  FLASHES / RINGS                                                        */
  /* ====================================================================== */

  private spawnFlash(pos: THREE.Vector3, size: number, life: number, color: THREE.Color): void {
    const i = this.flashCursor;
    this.flashCursor = (this.flashCursor + 1) % CAP_FLASH;
    _mtx.makeTranslation(pos.x, pos.y, pos.z);
    this.flashMesh.setMatrixAt(i, _mtx);
    const d = this.flashData.array as Float32Array;
    d[i * 4] = this.time; d[i * 4 + 1] = life; d[i * 4 + 2] = size; d[i * 4 + 3] = this.rng.next();
    const c = this.flashColor.array as Float32Array;
    c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b;
    this.flashMesh.instanceMatrix.needsUpdate = true;
    this.flashData.needsUpdate = true;
    this.flashColor.needsUpdate = true;
  }

  private spawnRing(
    pos: THREE.Vector3, normal: THREE.Vector3, radius: number, life: number,
    color: THREE.Color, thickness = 1,
  ): void {
    const i = this.ringCursor;
    this.ringCursor = (this.ringCursor + 1) % CAP_RING;
    _rgNrm.copy(normal);
    if (_rgNrm.lengthSq() < 1e-9) _rgNrm.set(0, 1, 0); else _rgNrm.normalize();
    _q.setFromUnitVectors(_AXIS_Z, _rgNrm);
    _rgScl.setScalar(radius);
    _mtx.compose(pos, _q, _rgScl);
    this.ringMesh.setMatrixAt(i, _mtx);
    const d = this.ringData.array as Float32Array;
    d[i * 4] = this.time; d[i * 4 + 1] = life; d[i * 4 + 2] = this.rng.next(); d[i * 4 + 3] = thickness;
    const c = this.ringColor.array as Float32Array;
    c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    this.ringData.needsUpdate = true;
    this.ringColor.needsUpdate = true;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, scale = 1): void {
    _mzDir.copy(dir);
    if (_mzDir.lengthSq() < 1e-9) _mzDir.set(0, 0, 1); else _mzDir.normalize();
    _mzPos.copy(pos).addScaledVector(_mzDir, 0.6 * scale);
    this.spawnFlash(_mzPos, 2.0 * scale, 0.085 + 0.03 * scale, color);

    const n = 4 + Math.round(scale * 3);
    for (let i = 0; i < n; i++) {
      _mzVel.copy(_mzDir).multiplyScalar(this.rng.range(14, 46) * scale);
      _mzVel.x += this.rng.gauss(0, 5 * scale);
      _mzVel.y += this.rng.gauss(0, 5 * scale);
      _mzVel.z += this.rng.gauss(0, 5 * scale);
      this.sparkSys.emit(
        this.time, _mzPos.x, _mzPos.y, _mzPos.z, _mzVel.x, _mzVel.y, _mzVel.z,
        0.10 * scale, this.rng.range(0.05, 0.16), color.r, color.g, color.b,
        this.rng.range(0.75, 1.0), this.rng.next(),
      );
    }
    this.requestLight(_mzPos, color, 70 * scale * scale, 40 * scale, 0.075);
  }

  /* ====================================================================== */
  /*  IMPACTS / SPARKS                                                       */
  /* ====================================================================== */

  impact(pos: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, scale = 1): void {
    _imNrm.copy(normal);
    if (_imNrm.lengthSq() < 1e-9) _imNrm.set(0, 1, 0); else _imNrm.normalize();
    // lift off the surface so the flash is not clipped into the hull
    _imPos.copy(pos).addScaledVector(_imNrm, 0.35 * scale);

    _c0.copy(color);
    this.spawnFlash(_imPos, 5.2 * scale, 0.17 + 0.05 * scale, _c0);
    this.spawnRing(_imPos, _imNrm, 7.0 * scale, 0.28 + 0.08 * scale, _c0, 0.85);
    this.sparks(_imPos, _imNrm, Math.round(16 + 12 * scale), _c0, 30 * Math.sqrt(scale));

    const ne = Math.round(3 + 4 * scale);
    for (let i = 0; i < ne; i++) {
      this.randomCone(_imNrm, 1.15, _imVel).multiplyScalar(this.rng.range(2, 12) * Math.sqrt(scale));
      this.emberSys.emit(
        this.time, _imPos.x, _imPos.y, _imPos.z, _imVel.x, _imVel.y, _imVel.z,
        0.22 * scale, this.rng.range(0.55, 1.6), _c0.r, _c0.g, _c0.b,
        this.rng.range(0.55, 0.95), this.rng.next(),
      );
    }

    if (scale > 1.4) {
      this.smokePuff(_imPos, 1.4 * scale, 0.9 + 0.25 * scale);
      this.debrisBurst(_imPos, Math.round(2 + scale), {
        speed: 9 * Math.sqrt(scale), scale: 0.20 * scale, life: 1.6, glow: 0.8,
      });
    }

    this.requestLight(_imPos, _c0, 140 * scale * scale, 55 * scale, 0.16);
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3, count: number, color: THREE.Color, speed = 26): void {
    _spNrm.copy(normal);
    if (_spNrm.lengthSq() < 1e-9) _spNrm.set(0, 1, 0); else _spNrm.normalize();
    const n = Math.max(0, Math.min(count, 500));
    const px = pos.x, py = pos.y, pz = pos.z;
    const cr = color.r, cg = color.g, cb = color.b;
    for (let i = 0; i < n; i++) {
      this.randomCone(_spNrm, 1.35, _spVel);
      _spVel.multiplyScalar(speed * this.rng.range(0.25, 1.35));
      const life = this.rng.range(0.12, 0.5) * (1 + speed * 0.006);
      this.sparkSys.emit(
        this.time, px, py, pz, _spVel.x, _spVel.y, _spVel.z,
        this.rng.range(0.05, 0.16) * (1 + speed * 0.004), life,
        cr, cg, cb, this.rng.range(0.7, 1.0), this.rng.next(),
      );
    }
  }

  /** unit vector biased toward `axis`; larger `spread` = wider cone */
  private randomCone(axis: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(this.rng.gauss(), this.rng.gauss(), this.rng.gauss());
    if (out.lengthSq() < 1e-9) out.set(0, 1, 0);
    out.normalize();
    const w = clamp(1 - spread / Math.PI, 0, 1);
    out.lerp(axis, w * 0.85 + 0.12);
    if (out.lengthSq() < 1e-9) out.copy(axis);
    return out.normalize();
  }

  private randomSphere(out: THREE.Vector3): THREE.Vector3 {
    const z = this.rng.range(-1, 1);
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return out.set(r * Math.cos(a), r * Math.sin(a), z);
  }

  /* ====================================================================== */
  /*  EXPLOSION                                                              */
  /* ====================================================================== */

  explosion(pos: THREE.Vector3, radius: number, opts?: ExplosionOpts): void {
    const r = Math.max(0.5, radius);
    const life = opts?.life ?? clamp(0.55 + Math.sqrt(r) * 0.34, 0.5, 9);
    const tint = opts?.color ?? null;

    // deterministic when a seed is supplied
    const savedRng = this.rng;
    if (opts?.seed !== undefined) this.rng = new RNG(opts.seed);
    const rng = this.rng;
    _exPos.copy(pos);

    /* --- (a) instant core flash --------------------------------------- */
    if (tint) _c1.copy(tint); else _c1.setRGB(1, 0.88, 0.66);
    this.spawnFlash(_exPos, r * 0.85, clamp(0.07 + r * 0.0016, 0.06, 0.38), _c1);

    /* --- (b) FBM shells ------------------------------------------------ */
    const blast = this.acquireBlast();
    if (blast) {
      blast.active = true;
      blast.age = 0;
      blast.life = life;
      blast.radius = r;
      blast.smokeAcc = 0;
      blast.wantSmoke = opts?.smoke !== false;
      if (tint) blast.tint.copy(tint).lerp(_c3.setRGB(1, 1, 1), 0.4);
      else blast.tint.setRGB(1, 1, 1);
      blast.spinAxis.set(rng.gauss(), rng.gauss(), rng.gauss());
      if (blast.spinAxis.lengthSq() < 1e-9) blast.spinAxis.set(0, 1, 0);
      blast.spinAxis.normalize();
      blast.spinRate = rng.range(0.08, 0.35) * rng.sign();
      blast.group.position.copy(_exPos);
      blast.group.quaternion.set(rng.gauss(), rng.gauss(), rng.gauss(), rng.gauss()).normalize();
      blast.group.visible = true;
      const seed = rng.next();
      for (let s = 0; s < blast.mats.length; s++) {
        const u = blast.mats[s].uniforms;
        u.uSeed.value = seed * (1 + s * 0.37) + s * 3.1;
        (u.uTint.value as THREE.Color).copy(blast.tint);
      }
      this.nBlasts++;
    }

    /* --- (c) shock rings ----------------------------------------------- */
    if (opts?.shock !== false) {
      if (tint) _c1.copy(tint); else _c1.setRGB(1, 0.82, 0.55);
      this.randomSphere(_exDir);
      this.spawnRing(_exPos, _exDir, r * 3.0, clamp(0.16 + Math.sqrt(r) * 0.055, 0.14, 0.9), _c1, 1.0);
      if (r > 55) {
        this.randomSphere(_exDir);
        this.spawnRing(_exPos, _exDir, r * 2.0, clamp(0.20 + Math.sqrt(r) * 0.05, 0.18, 0.8), _c1, 1.8);
      }
    }

    /* --- (d) debris, sparks, embers, smoke ------------------------------ */
    const nDeb = opts?.debris ?? Math.round(clamp(6 + r * 0.9, 6, 64));
    this.debrisBurst(_exPos, nDeb, {
      speed: clamp(r * 1.5, 6, 220),
      scale: clamp(r * 0.075, 0.12, 9),
      life: clamp(life * 1.35, 0.8, 9),
      glow: 1,
    });

    if (tint) _c2.copy(tint).lerp(_c3.setRGB(1, 0.7, 0.35), 0.5); else _c2.setRGB(1, 0.62, 0.28);
    const nSpark = Math.round(clamp(30 + r * 3.2, 30, 320));
    const sz = clamp(r * 0.02, 0.05, 1.4);
    const sSpeed = clamp(r * 2.6, 14, 420);
    const sLife = clamp(0.25 + Math.sqrt(r) * 0.22, 0.2, 2.6);
    for (let i = 0; i < nSpark; i++) {
      this.randomSphere(_exVel);
      _exVel.multiplyScalar(sSpeed * (0.35 + 0.75 * Math.pow(rng.next(), 0.4)));
      this.sparkSys.emit(
        this.time, _exPos.x, _exPos.y, _exPos.z, _exVel.x, _exVel.y, _exVel.z,
        sz * rng.range(0.5, 1.7), sLife * rng.range(0.35, 1.3),
        _c2.r, _c2.g, _c2.b, rng.range(0.7, 1.0), rng.next(),
      );
    }

    const nEmber = Math.round(clamp(12 + r * 1.1, 12, 160));
    const eSpeed = clamp(r * 0.85, 3, 130);
    for (let i = 0; i < nEmber; i++) {
      this.randomSphere(_exVel).multiplyScalar(eSpeed * rng.range(0.2, 1.0));
      this.emberSys.emit(
        this.time, _exPos.x, _exPos.y, _exPos.z, _exVel.x, _exVel.y, _exVel.z,
        clamp(r * 0.03, 0.08, 2.2), life * rng.range(0.7, 1.9),
        _c2.r, _c2.g, _c2.b, rng.range(0.55, 1.0), rng.next(),
      );
    }

    if (opts?.smoke !== false) {
      const nPuff = Math.round(clamp(2 + r * 0.05, 2, 8));
      for (let i = 0; i < nPuff; i++) {
        this.randomSphere(_exTmp).multiplyScalar(r * rng.range(0.15, 0.7));
        _exVel.copy(_exTmp).multiplyScalar(rng.range(0.6, 1.6));
        _exTmp.add(_exPos);
        this.smokePuff(_exTmp, r * rng.range(0.35, 0.8), life * rng.range(1.2, 2.4), _exVel);
      }
    }

    /* --- (e) light ----------------------------------------------------- */
    if (opts?.light !== false) {
      if (tint) _c1.copy(tint); else _c1.setRGB(1, 0.72, 0.42);
      this.requestLight(_exPos, _c1, 5.5 * r * r, r * 14, clamp(life * 0.5, 0.12, 2.2));
    }

    this.rng = savedRng;
  }

  private acquireBlast(): Blast | null {
    for (let i = 0; i < this.blasts.length; i++) if (!this.blasts[i].active) return this.blasts[i];
    let best: Blast | null = null, bestA = -1;
    for (let i = 0; i < this.blasts.length; i++) {
      const a = this.blasts[i].age / this.blasts[i].life;
      if (a > bestA) { bestA = a; best = this.blasts[i]; }
    }
    if (best) this.nBlasts--;
    return best;
  }

  /* ====================================================================== */
  /*  DEBRIS / SMOKE                                                         */
  /* ====================================================================== */

  debrisBurst(
    pos: THREE.Vector3, count: number,
    opts?: { speed?: number; scale?: number; life?: number; velocity?: THREE.Vector3; glow?: number },
  ): void {
    const speed = opts?.speed ?? 22;
    const scl = opts?.scale ?? 0.35;
    const life = opts?.life ?? 2.4;
    const glow = opts?.glow ?? 1;
    const n = Math.max(0, Math.min(count, CAP_DEBRIS));
    _c3.setRGB(0.21, 0.22, 0.25);
    const px = pos.x, py = pos.y, pz = pos.z;
    for (let i = 0; i < n; i++) {
      this.randomSphere(_dbVel).multiplyScalar(speed * this.rng.range(0.25, 1.25));
      if (opts?.velocity) _dbVel.add(opts.velocity);
      _dbPos.set(
        px + this.rng.gauss(0, scl * 1.4),
        py + this.rng.gauss(0, scl * 1.4),
        pz + this.rng.gauss(0, scl * 1.4),
      );
      this.debrisField.spawn(
        _dbPos, _dbVel, scl * this.rng.range(0.45, 1.6), life * this.rng.range(0.6, 1.35),
        clamp(glow * this.rng.range(0.5, 1.0), 0, 1), _c3, this.rng,
      );
    }
  }

  smokePuff(pos: THREE.Vector3, radius: number, life = 2.2, velocity?: THREE.Vector3): void {
    const n = Math.round(clamp(3 + radius * 0.32, 3, 26));
    _c3.setRGB(0.135, 0.118, 0.112);
    const px = pos.x, py = pos.y, pz = pos.z;
    for (let i = 0; i < n; i++) {
      this.randomSphere(_smVel).multiplyScalar(radius * this.rng.range(0.12, 0.55));
      if (velocity) _smVel.add(velocity);
      this.randomSphere(_smOff).multiplyScalar(radius * this.rng.range(0, 0.55));
      _smPos.set(px + _smOff.x, py + _smOff.y, pz + _smOff.z);
      this.smokeSys.emit(
        this.time, _smPos.x, _smPos.y, _smPos.z, _smVel.x, _smVel.y, _smVel.z,
        radius * this.rng.range(0.8, 1.8), life * this.rng.range(0.65, 1.4),
        _c3.r, _c3.g, _c3.b, this.rng.range(0.25, 0.85), this.rng.next(),
      );
    }
  }

  /* ====================================================================== */
  /*  EMBER TRAILS                                                           */
  /* ====================================================================== */

  emberTrail(obj: THREE.Object3D, on: boolean): void {
    const i = this.findTrail(obj);
    if (on) {
      if (i < 0) this.trails.push({ obj, last: new THREE.Vector3(), started: false, acc: 0, timeAcc: 0 });
    } else if (i >= 0) {
      this.trails.splice(i, 1);
    }
  }

  private findTrail(obj: THREE.Object3D): number {
    for (let i = 0; i < this.trails.length; i++) if (this.trails[i].obj === obj) return i;
    return -1;
  }

  private updateTrails(dt: number): void {
    const invDt = 1 / Math.max(dt, 1e-4);
    for (let i = 0; i < this.trails.length; i++) {
      const t = this.trails[i];
      t.obj.updateWorldMatrix(true, false);
      t.obj.getWorldPosition(_trA);
      if (!t.started) { t.last.copy(_trA); t.started = true; continue; }

      _trB.subVectors(_trA, t.last);          // frame displacement
      const dist = _trB.length();
      t.acc += dist;
      t.timeAcc += dt;

      const spacing = 1.6;
      let emits = Math.floor(t.acc / spacing);
      if (emits > 10) emits = 10;
      if (emits > 0) t.acc -= emits * spacing;
      if (t.timeAcc > 0.05) { t.timeAcc = 0; if (emits === 0) emits = 1; }

      _c3.setRGB(1.0, 0.5, 0.18);
      for (let k = 0; k < emits; k++) {
        const f = (k + 1) / (emits + 1);
        _trC.copy(t.last).addScaledVector(_trB, f);
        // shed with a fraction of the parent's velocity so they fall behind
        this.randomSphere(_trD).multiplyScalar(this.rng.range(0.5, 4.5));
        _trD.addScaledVector(_trB, invDt * this.rng.range(0.12, 0.45));
        this.emberSys.emit(
          this.time, _trC.x, _trC.y, _trC.z, _trD.x, _trD.y, _trD.z,
          this.rng.range(0.20, 0.60), this.rng.range(0.5, 1.7),
          _c3.r, _c3.g, _c3.b, this.rng.range(0.6, 1.0), this.rng.next(),
        );
        if (this.rng.bool(0.4)) {
          this.randomSphere(_trD).multiplyScalar(this.rng.range(2, 14));
          _trD.addScaledVector(_trB, invDt * this.rng.range(0.05, 0.3));
          this.sparkSys.emit(
            this.time, _trC.x, _trC.y, _trC.z, _trD.x, _trD.y, _trD.z,
            this.rng.range(0.12, 0.30), this.rng.range(0.12, 0.4),
            1.0, 0.6, 0.3, this.rng.range(0.8, 1.0), this.rng.next(),
          );
        }
        if (this.rng.bool(0.14)) {
          this.randomSphere(_trD).multiplyScalar(this.rng.range(0.5, 2.5));
          _trD.addScaledVector(_trB, invDt * this.rng.range(0.02, 0.15));
          this.smokeSys.emit(
            this.time, _trC.x, _trC.y, _trC.z, _trD.x, _trD.y, _trD.z,
            this.rng.range(1.2, 3.0), this.rng.range(1.2, 3.0),
            0.22, 0.20, 0.20, this.rng.range(0.1, 0.4), this.rng.next(),
          );
        }
      }
      t.last.copy(_trA);
    }
  }

  /* ====================================================================== */
  /*  LIGHT POOL — max 4 alive, brightest wins                               */
  /* ====================================================================== */

  private requestLight(
    pos: THREE.Vector3, color: THREE.Color, intensity: number, distance: number, life: number,
  ): void {
    let slot: LightSlot | null = null;
    for (let i = 0; i < this.lightSlots.length; i++) {
      if (!this.lightSlots[i].active) { slot = this.lightSlots[i]; break; }
    }
    if (!slot) {
      let dim: LightSlot | null = null, dimV = Infinity;
      for (let i = 0; i < this.lightSlots.length; i++) {
        const s = this.lightSlots[i];
        const cur = s.base * Math.max(0, 1 - s.age / s.life);
        if (cur < dimV) { dimV = cur; dim = s; }
      }
      if (!dim || intensity <= dimV) return;
      slot = dim;
    }
    slot.active = true;
    slot.age = 0;
    slot.life = Math.max(life, 1e-3);
    slot.base = intensity;
    slot.light.color.copy(color);
    slot.light.distance = distance;
    slot.light.decay = 2;
    slot.light.position.copy(pos);
    slot.light.intensity = intensity;
    slot.light.visible = true;
  }

  private updateLights(dt: number): void {
    for (let i = 0; i < this.lightSlots.length; i++) {
      const s = this.lightSlots[i];
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        s.light.intensity = 0;
        s.light.visible = false;
        continue;
      }
      const k = 1 - s.age / s.life;
      s.light.intensity = s.base * k * k;
    }
  }

  /* ====================================================================== */
  /*  UPDATE                                                                 */
  /* ====================================================================== */

  update(dt: number, time: number, camera: THREE.Camera): void {
    this.time = time;
    this.frame++;

    const pc = camera as THREE.PerspectiveCamera;
    if (pc && pc.isPerspectiveCamera) {
      const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
      const h = (typeof window !== 'undefined' ? window.innerHeight : 1080) * dpr;
      this.pixelScale = h / (2 * Math.tan((pc.fov * Math.PI) / 360));
    }

    /* ---- lasers: advance, hit-test, retire ---- */
    for (let i = this.nBolts - 1; i >= 0; i--) {
      const b = this.bolts[i];
      _prevPos.copy(b.pos);
      b.pos.addScaledVector(b.dir, b.speed * dt);
      b.age += dt;

      let dead = b.age >= b.life;
      if (!dead && this.hitTest) {
        const h = this.hitTest(_prevPos, b.pos, b.team);
        if (h) {
          const s = b.team === 'turbo' ? 3.4 : 1.0;
          this.impact(h.point, h.normal, b.color, s);
          this.sparks(h.point, h.normal, b.team === 'turbo' ? 40 : 16, b.color, 34 * s);
          dead = true;
        }
      }
      if (dead) this.swapRemoveBolt(i);
    }

    const bc = this.boltColor.array as Float32Array;
    const bd = this.boltData.array as Float32Array;
    const n = this.nBolts;
    for (let i = 0; i < n; i++) {
      const b = this.bolts[i];
      // grow out of the muzzle rather than spawning through the firing ship
      const grown = Math.min(1, (b.age * b.speed) / b.len + 0.30);
      const effLen = b.len * grown;
      _tail.copy(b.pos).addScaledVector(b.dir, -effLen);
      _q.setFromUnitVectors(_AXIS_Z, b.dir);
      _mtx.compose(_tail, _q, _one);
      this.boltMesh.setMatrixAt(i, _mtx);
      bc[i * 3] = b.color.r; bc[i * 3 + 1] = b.color.g; bc[i * 3 + 2] = b.color.b;
      bd[i * 4] = b.age / b.life;
      bd[i * 4 + 1] = effLen;
      bd[i * 4 + 2] = b.rad;
      bd[i * 4 + 3] = b.seed;
    }
    this.boltMesh.count = n;
    this.boltMesh.visible = n > 0;
    if (n > 0) {
      this.boltMesh.instanceMatrix.needsUpdate = true;
      this.boltColor.needsUpdate = true;
      this.boltData.needsUpdate = true;
    }
    this.boltMat.uniforms.uTime.value = time;
    this.boltMat.uniforms.uPixelScale.value = 1 / this.pixelScale;
    this.boltMat.uniforms.uIntensity.value = 4.2 * this.intensity;

    /* ---- ember trails (spawn before the particle upload) ---- */
    this.updateTrails(dt);

    /* ---- explosions ---- */
    let live = 0;
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i];
      if (!b.active) continue;
      b.age += dt;
      if (b.age >= b.life) {
        b.active = false;
        b.group.visible = false;
        continue;
      }
      live++;
      const t = b.age / b.life;
      _q.setFromAxisAngle(b.spinAxis, b.spinRate * dt);
      b.group.quaternion.multiply(_q);

      for (let s = 0; s < b.mats.length; s++) {
        const cfg = SHELL_CFG[s];
        const u = b.mats[s].uniforms;
        const grow = 1 - Math.pow(1 - t, 2.3);
        b.shells[s].scale.setScalar(b.radius * (cfg.s0 + (cfg.s1 - cfg.s0) * grow));
        u.uTime.value = time;
        u.uAge01.value = t;
        u.uHeat.value = cfg.heat * Math.pow(Math.max(0, 1 - t), cfg.heatPow);
        const fo = clamp(1 - t / cfg.fadeOut, 0, 1);
        u.uOpacity.value = cfg.opacity * Math.pow(fo, 0.8);
        u.uBright.value = cfg.bright * this.intensity * Math.pow(fo, 0.5);
        b.shells[s].visible = fo > 0.004;
      }

      // rolling secondary smoke while the fireball is still growing
      if (b.wantSmoke && t < 0.55) {
        b.smokeAcc += dt;
        const period = clamp(0.30 - b.radius * 0.0004, 0.06, 0.30);
        let guard = 0;
        while (b.smokeAcc > period && guard++ < 4) {
          b.smokeAcc -= period;
          this.randomSphere(_exTmp).multiplyScalar(b.radius * this.rng.range(0.5, 1.4));
          _exVel.copy(_exTmp).multiplyScalar(this.rng.range(0.2, 0.7));
          _exTmp.add(b.group.position);
          this.smokePuff(_exTmp, b.radius * this.rng.range(0.25, 0.6), b.life * this.rng.range(1.1, 2.2), _exVel);
        }
      }
    }
    this.nBlasts = live;

    /* ---- debris ---- */
    this.debrisField.update(dt);

    /* ---- particles ---- */
    this.sparkSys.update(time, this.pixelScale);
    this.emberSys.update(time, this.pixelScale);
    this.smokeSys.update(time, this.pixelScale);
    this.sparkSys.material.uniforms.uIntensity.value = 2.0 * this.intensity;
    this.emberSys.material.uniforms.uIntensity.value = 1.5 * this.intensity;

    /* ---- flashes / rings ---- */
    this.flashMat.uniforms.uTime.value = time;
    this.flashMat.uniforms.uIntensity.value = 3.0 * this.intensity;
    this.ringMat.uniforms.uTime.value = time;
    this.ringMat.uniforms.uIntensity.value = 0.95 * this.intensity;

    /* ---- lights ---- */
    this.updateLights(dt);

    /* ---- HUD counters (O(n), low rate) ---- */
    if ((this.frame & 7) === 0) {
      this.particleCount =
        this.sparkSys.recount(time) + this.emberSys.recount(time) + this.smokeSys.recount(time);
    }
  }

  stats(): { lasers: number; explosions: number; debris: number; particles: number } {
    return {
      lasers: this.nBolts,
      explosions: this.nBlasts,
      debris: this.debrisField.aliveCount,
      particles: this.particleCount,
    };
  }

  clear(): void {
    this.nBolts = 0;
    this.boltMesh.count = 0;
    this.sparkSys.clear();
    this.emberSys.clear();
    this.smokeSys.clear();
    this.debrisField.clear();
    for (let i = 0; i < this.blasts.length; i++) {
      this.blasts[i].active = false;
      this.blasts[i].group.visible = false;
    }
    this.nBlasts = 0;
    const fd = this.flashData.array as Float32Array;
    for (let i = 0; i < CAP_FLASH; i++) { fd[i * 4] = -1e9; fd[i * 4 + 1] = 1; }
    this.flashData.needsUpdate = true;
    const rd = this.ringData.array as Float32Array;
    for (let i = 0; i < CAP_RING; i++) { rd[i * 4] = -1e9; rd[i * 4 + 1] = 1; }
    this.ringData.needsUpdate = true;
    for (let i = 0; i < this.lightSlots.length; i++) {
      this.lightSlots[i].active = false;
      this.lightSlots[i].light.intensity = 0;
      this.lightSlots[i].light.visible = false;
    }
    this.trails.length = 0;
    this.particleCount = 0;
  }

  dispose(): void {
    this.clear();
    this.boltGeo.dispose();
    this.boltMat.dispose();
    this.boltMesh.dispose();
    this.flashGeo.dispose();
    this.flashMat.dispose();
    this.flashMesh.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.ringMesh.dispose();
    this.sparkSys.dispose();
    this.emberSys.dispose();
    this.smokeSys.dispose();
    this.debrisField.dispose();
    this.shellGeo.dispose();
    for (let i = 0; i < this.blasts.length; i++) {
      for (let s = 0; s < this.blasts[i].mats.length; s++) this.blasts[i].mats[s].dispose();
    }
    this.scene.remove(this.group);
  }
}
