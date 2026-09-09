/**
 * Fireball shaders for the Death Star destruction.
 *
 * Three pieces:
 *   createFireballMaterial   — one displaced, black-body-coloured fire shell
 *   createFireballLayers     — N nested shells (fake volume) with a shared driver
 *   createVolumeCore         — a cheap in-shader ray-march (24 steps) through an
 *                              animated FBM density field, used for the internal
 *                              core ignition and the lingering core afterwards.
 *
 * Everything works in *unit object space*: the meshes are unit spheres and the
 * caller scales them, so the noise fields never see huge world coordinates
 * (the station is 50 km across and the fireball reaches 325 km).
 */
import * as THREE from 'three';
import { GLSL_COLOR, GLSL_HASH, GLSL_NOISE, GLSL_ROT } from './lib';

const P = GLSL_HASH + GLSL_NOISE + GLSL_COLOR + GLSL_ROT;

/* ------------------------------------------------------------------ */
/*  shared scratch                                                     */
/* ------------------------------------------------------------------ */
const _wp = new THREE.Vector3();
const _cp = new THREE.Vector3();

/** camera position expressed in a mesh's *unit* object space (no allocation) */
function camObj(mesh: THREE.Object3D, camera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
  mesh.getWorldPosition(_wp);
  camera.getWorldPosition(_cp);
  const s = mesh.scale.x || 1;
  out.set((_cp.x - _wp.x) / s, (_cp.y - _wp.y) / s, (_cp.z - _wp.z) / s);
  return out;
}

/* ================================================================== */
/*  1. FIRE SHELL                                                      */
/* ================================================================== */

export interface FireballMaterialOptions {
  seed?: number;
  /** spatial frequency of the fire structure */
  noiseScale?: number;
  /** how fast the fire boils / rolls */
  scroll?: number;
  /** vertex displacement amplitude, in unit-sphere radii */
  displace?: number;
  /** overall alpha multiplier */
  opacity?: number;
  /** HDR emission of the sparse white-hot filaments (these bloom) */
  emissive?: number;
  /** flat emission of the bulk fire — keep near 1 or the frame blows out */
  base?: number;
  /** how much dark soot is carved out (0 core .. 1 outer) */
  soot?: number;
  /** shifts the black-body temperature up (core) or down (skin) */
  tempBias?: number;
  depthTest?: boolean;
  side?: THREE.Side;
}

const FIRE_VERT = /* glsl */ `
${P}
uniform float uTime, uProgress, uDisplace, uNoiseScale, uScroll, uSeed;
varying vec3 vPos;
varying vec3 vDir;
varying float vDisp;

void main(){
  vec3 dir = normalize(position);
  vec3 q = dir * uNoiseScale + vec3(uSeed*3.71, uSeed*1.33, uSeed*7.19);
  vec3 flow = vec3(0.0, -uTime*uScroll, uTime*uScroll*0.55);

  float big  = fbm3(q*0.55 + flow*0.35, 4, 2.03, 0.55) - 0.5;      // slow lobes
  float mid  = ridged3(q*1.35 + flow, 4, 2.11, 0.50) - 0.42;       // plumes
  float fine = fbm3(q*3.10 + flow*1.7, 3, 2.20, 0.50) - 0.5;

  float d = big*2.30 + mid*1.25 + fine*0.55;
  vDisp = d;

  // early on the ball is tight; as it decelerates the lobes throw further out
  float amp = uDisplace * mix(0.55, 1.35, clamp(uProgress, 0.0, 1.0));
  vec3 p = dir * (1.0 + d * amp);

  vPos = p;
  vDir = dir;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FIRE_FRAG = /* glsl */ `
${P}
precision highp float;
vec3 bbn(float t){ return blackbody(t) * 0.28; }
uniform vec3  uCamObj;
uniform float uTime, uProgress, uOpacity, uEmissive, uBase, uSoot, uNoiseScale, uScroll, uSeed, uTempBias;
varying vec3 vPos;
varying vec3 vDir;
varying float vDisp;

void main(){
  vec3 N = normalize(vDir);
  vec3 V = normalize(vPos - uCamObj);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float limb = pow(1.0 - ndv, 1.7);            // edge-on = more fire depth

  vec3 q = N * uNoiseScale + vec3(uSeed*5.13, uSeed*2.07, uSeed*9.41);
  vec3 flow = vec3(0.0, -uTime*uScroll, uTime*uScroll*0.55);

  float cells = fbm3(warp3(q*1.70 + flow, 0.42, 1.30), 5, 2.07, 0.53);
  float fil   = ridged3(q*4.20 + flow*1.4, 4, 2.20, 0.50);
  float soot  = smoothstep(0.38, 0.78, fbm3(q*8.5 + flow*2.4, 4, 2.30, 0.50));
  float sootF = smoothstep(0.52, 0.90, ridged3(q*15.0 - flow*3.1, 3, 2.4, 0.5));
  soot = max(soot, sootF*0.9);

  // density: subtract a floor so most of the shell is actually empty
  float dens = cells*0.85 + fil*0.45 + vDisp*0.22;
  dens = clamp((dens - 0.46) * 1.7, 0.0, 1.0);  // real voids between the lobes
  dens *= 1.0 - soot * uSoot * 0.95;            // soot filaments carve holes

  float cool = 1.0 - clamp(uProgress, 0.0, 1.0);
  float temp = (dens*1.05 + limb*0.26 + uTempBias) * mix(0.34, 1.18, cool);
  temp -= soot * uSoot * (0.30 + 0.55*uProgress);
  temp = clamp(temp, 0.0, 1.05);

  // sparse white-hot filaments carry the HDR; the bulk stays near 1.0
  float hot = pow(clamp(dens*1.10, 0.0, 1.0), 8.0) * smoothstep(0.45, 0.82, temp);
  vec3 col = bbn(temp) * (uBase * (0.25 + dens) + uEmissive * hot);

  float a = uOpacity * pow(dens, 1.5) * (0.26 + 0.90*limb);
  a = clamp(a, 0.0, 1.0);
  if(a < 0.0035) discard;

  gl_FragColor = vec4(col * a, 1.0);
}
`;

export function createFireballMaterial(opts: FireballMaterialOptions = {}): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uDisplace: { value: opts.displace ?? 0.16 },
      uNoiseScale: { value: opts.noiseScale ?? 3.2 },
      uScroll: { value: opts.scroll ?? 0.18 },
      uSeed: { value: opts.seed ?? 0 },
      uOpacity: { value: opts.opacity ?? 1 },
      uEmissive: { value: opts.emissive ?? 26 },
      uBase: { value: opts.base ?? 0.9 },
      uSoot: { value: opts.soot ?? 0.3 },
      uTempBias: { value: opts.tempBias ?? 0.35 },
      uCamObj: { value: new THREE.Vector3(0, 0, 6) },
    },
    vertexShader: FIRE_VERT,
    fragmentShader: FIRE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: opts.depthTest ?? true,
    side: opts.side ?? THREE.DoubleSide,
    toneMapped: false,
  });
  return m;
}

/* ------------------------------------------------------------------ */

export interface FireballLayersOptions {
  seed?: number;
  /** three's PolyhedronGeometry detail: 20*(d+1)^2 triangles. 31 -> 20480. */
  coreDetail?: number;
  /** 15 -> 5120 triangles */
  shellDetail?: number;
  /** HDR emission of the innermost layer */
  emissive?: number;
  depthTest?: boolean;
}

export interface FireballLayers {
  mesh: THREE.Object3D;
  setRadius(r: number): void;
  setProgress(t: number): void;
  /** master opacity fade (1 = full) */
  setOpacity(o: number): void;
  /** depth-test against the station shell (on while the core is still inside it) */
  setDepthTest(on: boolean): void;
  update(dt: number, time: number, camera: THREE.Camera): void;
  dispose(): void;
  readonly triangles: number;
  readonly drawCalls: number;
}

/**
 * `count` nested fire shells. Each has its own noise scale / scroll / seed and a
 * lower opacity + more soot than the one inside it, which fakes volume without a
 * ray-march.
 */
export function createFireballLayers(count = 5, opts: FireballLayersOptions = {}): FireballLayers {
  const group = new THREE.Group();
  group.name = 'fireballLayers';
  const coreDetail = opts.coreDetail ?? 31;
  const shellDetail = opts.shellDetail ?? 15;
  const seed0 = opts.seed ?? 7;
  const em0 = opts.emissive ?? 34;

  const coreGeo = new THREE.IcosahedronGeometry(1, coreDetail);
  const shellGeo = new THREE.IcosahedronGeometry(1, shellDetail);

  const meshes: THREE.Mesh[] = [];
  const mats: THREE.ShaderMaterial[] = [];
  const rel: number[] = [];
  const baseOpacity: number[] = [];
  let tris = 0;

  for (let i = 0; i < count; i++) {
    const f = count > 1 ? i / (count - 1) : 0;
    const geo = i === 0 ? coreGeo : shellGeo;
    const mat = createFireballMaterial({
      seed: seed0 + i * 13.7,
      noiseScale: 3.0 * (1 + i * 0.52),
      scroll: 0.15 * (1 + i * 0.34),
      displace: 0.115 + i * 0.055,
      opacity: 0.115 * Math.pow(0.66, i),
      emissive: em0 * Math.pow(0.58, i),
      base: 0.42 * Math.pow(0.66, i),
      soot: 0.10 + f * 1.15,
      tempBias: 0.44 - i * 0.10,
      depthTest: opts.depthTest ?? true,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 24 + (count - i);   // inner shells drawn last
    group.add(m);
    meshes.push(m);
    mats.push(mat);
    rel.push(1 + i * 0.115 + i * i * 0.012);
    baseOpacity.push(mat.uniforms.uOpacity.value as number);
    tris += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
  }

  let radius = 1;
  let master = 1;
  const _c = new THREE.Vector3();

  return {
    mesh: group,
    triangles: tris,
    drawCalls: count,
    setRadius(r: number) {
      radius = r;
      for (let i = 0; i < meshes.length; i++) meshes[i].scale.setScalar(r * rel[i]);
    },
    setProgress(t: number) {
      for (let i = 0; i < mats.length; i++) mats[i].uniforms.uProgress.value = t;
    },
    setOpacity(o: number) { master = o; },
    setDepthTest(on: boolean) { for (const m of mats) if (m.depthTest !== on) m.depthTest = on; },
    update(_dt: number, time: number, camera: THREE.Camera) {
      camera.getWorldPosition(_cp);
      group.getWorldPosition(_wp);
      const dist = _cp.distanceTo(_wp);
      for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i];
        const mat = mats[i];
        mat.uniforms.uTime.value = time;
        camObj(m, camera, _c);
        (mat.uniforms.uCamObj.value as THREE.Vector3).copy(_c);
        // once the camera is swallowed we must not cull the shell we are inside,
        // and we must dim it hard or every pixel is full-strength fire
        const rr = radius * rel[i];
        const inside = dist < rr * 1.25;
        const want = inside ? THREE.BackSide : THREE.FrontSide;
        if (mat.side !== want) mat.side = want;
        const dim = dist < rr ? 0.16 : (dist < rr * 1.7 ? 0.16 + 0.84 * ((dist - rr) / (rr * 0.7)) : 1);
        mat.uniforms.uOpacity.value = baseOpacity[i] * master * dim;
      }
    },
    dispose() {
      coreGeo.dispose(); shellGeo.dispose();
      for (const m of mats) m.dispose();
      group.clear();
    },
  };
}

/* ================================================================== */
/*  2. VOLUME CORE — cheap ray-march                                   */
/* ================================================================== */

export interface VolumeCoreOptions {
  seed?: number;
  steps?: number;
  detail?: number;
  emissive?: number;
  base?: number;
  absorb?: number;
  noiseScale?: number;
  scroll?: number;
}

const VOL_VERT = /* glsl */ `
varying vec3 vPos;
void main(){
  vPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const VOL_FRAG = /* glsl */ `
${P}
precision highp float;
vec3 bbn(float t){ return blackbody(t) * 0.28; }
uniform vec3  uCamObj;
uniform float uTime, uProgress, uEmissive, uBase, uAbsorb, uNoiseScale, uScroll, uSeed, uOpacity, uCoreHeat;
varying vec3 vPos;

float density(vec3 p, out float temp){
  float r = length(p);
  vec3 flow = vec3(0.0, -uTime*uScroll, uTime*uScroll*0.6);
  vec3 q = warp3(p*uNoiseScale + vec3(uSeed*4.3) + flow, 0.45, 1.6);
  float f  = fbm3(q, 5, 2.05, 0.54);
  float rg = ridged3(q*2.15 + 4.7, 4, 2.17, 0.50);
  float d = f*0.95 + rg*0.60 - 0.62;
  d = max(d, 0.0) * 1.7;
  // soft radial clip so it never shows the mesh silhouette
  d *= smoothstep(1.0, 0.45, r);
  // a knotted, noisy core rather than a uniform pit
  d += 0.45 * smoothstep(0.34, 0.02, r) * (0.35 + 0.9*rg);
  temp = clamp(uCoreHeat * (0.30 + 0.85*d) * (1.30 - 0.60*r), 0.0, 1.05);
  return d;
}

void main(){
  vec3 ro = uCamObj;
  vec3 rd = normalize(vPos - uCamObj);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - 1.0;
  float h = b*b - c;
  if(h <= 0.0) discard;
  h = sqrt(h);
  float t0 = max(-b - h, 0.0);
  float t1 = -b + h;
  if(t1 <= t0) discard;

  const int STEPS = 24;
  float dt = (t1 - t0) / float(STEPS);
  float jit = hash13(vec3(gl_FragCoord.xy, uTime*13.0)) * dt;

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for(int i=0;i<STEPS;i++){
    float t = t0 + float(i)*dt + jit;
    if(t > t1) break;
    vec3 p = ro + rd*t;
    float temp;
    float d = density(p, temp);
    if(d > 0.001){
      float dm = d * dt * 3.4;
      float hotv = smoothstep(0.88, 1.04, temp);
      acc += (bbn(temp) * uBase + vec3(1.30, 1.06, 0.70) * (uEmissive * hotv)) * (dm * trans);
      trans *= exp(-dm * uAbsorb);
      if(trans < 0.02) break;
    }
  }
  if(max(acc.r, max(acc.g, acc.b)) < 0.002) discard;
  gl_FragColor = vec4(acc * uOpacity, 1.0);
}
`;

export interface VolumeCore {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  setRadius(r: number): void;
  setProgress(t: number): void;
  setHeat(h: number): void;
  setOpacity(o: number): void;
  setDepthTest(on: boolean): void;
  update(dt: number, time: number, camera: THREE.Camera): void;
  dispose(): void;
  readonly triangles: number;
}

export function createVolumeCore(opts: VolumeCoreOptions = {}): VolumeCore {
  const geo = new THREE.IcosahedronGeometry(1, opts.detail ?? 8);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uEmissive: { value: opts.emissive ?? 5 },
      uBase: { value: opts.base ?? 0.85 },
      uAbsorb: { value: opts.absorb ?? 2.6 },
      uNoiseScale: { value: opts.noiseScale ?? 2.6 },
      uScroll: { value: opts.scroll ?? 0.22 },
      uSeed: { value: opts.seed ?? 3 },
      uOpacity: { value: 1 },
      uCoreHeat: { value: 0.8 },
      uCamObj: { value: new THREE.Vector3(0, 0, 4) },
    },
    vertexShader: VOL_VERT,
    fragmentShader: VOL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 22;

  const _c = new THREE.Vector3();

  return {
    mesh,
    material: mat,
    triangles: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
    setRadius(r: number) { mesh.scale.setScalar(r); },
    setProgress(t: number) { mat.uniforms.uProgress.value = t; },
    setHeat(h: number) { mat.uniforms.uCoreHeat.value = h; },
    setOpacity(o: number) { mat.uniforms.uOpacity.value = o; },
    setDepthTest(on: boolean) { if (mat.depthTest !== on) mat.depthTest = on; },
    update(_dt: number, time: number, camera: THREE.Camera) {
      mat.uniforms.uTime.value = time;
      camObj(mesh, camera, _c);
      (mat.uniforms.uCamObj.value as THREE.Vector3).copy(_c);
      // FrontSide gives correct occlusion by the (opaque) station shell while the
      // core is still inside it; flip to BackSide once we are swallowed.
      const inside = _c.lengthSq() < 1.0;
      const want = inside ? THREE.BackSide : THREE.FrontSide;
      if (mat.side !== want) mat.side = want;
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
