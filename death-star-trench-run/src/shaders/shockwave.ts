/**
 * Shockwave shaders — the Praxis-style ring, the spherical wave that goes with
 * it, and a fake "background distortion" shell.
 *
 * There is no refraction render target in this pipeline, so the distortion is
 * faked with a *multiply* blend: the shell writes `dst *= tint`, where tint is a
 * per-channel gain derived from a fake refraction offset. Because the three
 * channels are scaled differently the background picks up real chromatic
 * fringing, and a darker band behind the front reads as the compressed shell.
 * Combined with the additive rim it reads clearly as a distortion wave.
 *
 * All meshes are unit-sized; the caller drives `setRadius()`. Everything is
 * DoubleSide so it stays correct once the wave overtakes the camera.
 */
import * as THREE from 'three';
import { GLSL_COLOR, GLSL_HASH, GLSL_NOISE, GLSL_ROT } from './lib';

const P = GLSL_HASH + GLSL_NOISE + GLSL_COLOR + GLSL_ROT;

const _wp = new THREE.Vector3();
const _cp = new THREE.Vector3();

function camObjInto(mesh: THREE.Object3D, camera: THREE.Camera, out: THREE.Vector3) {
  mesh.getWorldPosition(_wp);
  camera.getWorldPosition(_cp);
  const s = mesh.scale.x || 1;
  out.set((_cp.x - _wp.x) / s, (_cp.y - _wp.y) / s, (_cp.z - _wp.z) / s);
  return out;
}

/* ================================================================== */
/*  RING                                                               */
/* ================================================================== */

export interface ShockRingOptions {
  seed?: number;
  segments?: number;
  rings?: number;
  inner?: number;
  /** out-of-plane billow, in unit radii */
  thickness?: number;
  emissive?: number;
}

const RING_VERT = /* glsl */ `
${P}
uniform float uTime, uProgress, uThick, uSeed, uInner, uWarp;
varying float vR;      // 0 at inner edge .. 1 at leading edge
varying float vA;      // angle
varying float vZ;

void main(){
  float r = length(position.xy);
  float ang = atan(position.y, position.x);
  float rn = clamp((r - uInner) / (1.0 - uInner), 0.0, 1.0);

  // the leading edge is not a perfect circle
  float lump = fbm2(vec2(ang*1.7 + uSeed, uSeed*3.3), 4, 2.10, 0.55) - 0.5;
  float lump2 = fbm2(vec2(ang*5.3 + uSeed*2.0, 7.7), 3, 2.05, 0.5) - 0.5;
  float rr = r * (1.0 + (lump*0.11 + lump2*0.045) * uWarp * smoothstep(0.10, 1.0, rn));

  vec3 p = vec3(cos(ang)*rr, sin(ang)*rr, 0.0);

  // out-of-plane billow so it is a shaped membrane, not a flat washer
  float bl = fbm2(vec2(ang*3.1 + uSeed*5.0, rn*2.6 - uTime*0.06), 4, 2.05, 0.55) - 0.5;
  float prof = smoothstep(0.02, 0.55, rn) * (1.0 - smoothstep(0.80, 1.0, rn));
  p.z += bl * uThick * prof * 2.0;
  vZ = bl * prof;

  vR = rn;
  vA = ang;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
${P}
precision highp float;
vec3 bbn(float t){ return blackbody(t) * 0.28; }
uniform float uTime, uProgress, uRimGain, uEdgeGain, uOpacity, uBody, uSeed, uEdgeSharp;
varying float vR;
varying float vA;
varying float vZ;

void main(){
  float rn = vR;
  float ang = vA;

  // ---- radial filaments / spokes ----
  float fil  = fbm2(vec2(ang*26.0 + uSeed, rn*3.5 - uTime*0.55), 4, 2.10, 0.55);
  float fil2 = ridged3(vec3(cos(ang), sin(ang), rn*1.2)*9.0 + vec3(uTime*0.22), 4, 2.13, 0.50);
  float spoke = mix(fil, fil2, 0.55);

  // ---- the leading edge, a thin bright rim, and the membrane behind ----
  float front = smoothstep(0.70, 0.985, rn);
  float rim   = exp(-pow((rn - 0.972) / (0.0095 * uEdgeSharp), 2.0)) * (0.10 + 1.55*spoke*spoke);
  float memb  = smoothstep(0.0, 0.62, rn) * (1.0 - smoothstep(0.90, 1.0, rn));

  float body = memb * (0.05 + 0.75*spoke*spoke*spoke) * uBody;
  float edge = front * front * (0.10 + 1.05*spoke) * uEdgeGain;
  float amt  = body + edge + rim*rim*uRimGain;

  // hard clip so the geometry edge never shows
  amt *= 1.0 - smoothstep(0.985, 1.0, rn);
  if(amt < 0.002) discard;

  float temp = clamp(0.24 + rim*0.78 + front*0.26 + spoke*0.28 + abs(vZ)*0.22, 0.0, 1.05);
  vec3 col = bbn(temp);
  col += vec3(0.22, 0.48, 1.05) * rim*rim * 1.3;             // hot blue-white rim
  col += vec3(0.34, 0.13, 0.30) * memb * spoke * 0.22;       // cool magenta membrane

  gl_FragColor = vec4(col * amt * uOpacity, 1.0);
}
`;

export interface ShockwavePart {
  mesh: THREE.Object3D;
  setRadius(r: number): void;
  setProgress(t: number): void;
  setIntensity(i: number): void;
  update(dt: number, time: number, camera: THREE.Camera): void;
  dispose(): void;
  readonly triangles: number;
  readonly drawCalls: number;
}

/**
 * The classic expanding disc: a bright, warped leading edge with a translucent
 * membrane and radial filaments trailing behind it, plus a wide low-opacity haze
 * disc so it has some depth.
 */
export function createShockwaveRing(opts: ShockRingOptions = {}): ShockwavePart {
  const seg = opts.segments ?? 240;
  const rings = opts.rings ?? 12;
  const inner = opts.inner ?? 0.26;
  const seed = opts.seed ?? 5;

  const group = new THREE.Group();
  group.name = 'shockRing';
  // the station's equator is the XZ plane -> ring normal is +Y
  group.rotation.x = -Math.PI / 2;

  const mk = (
    innerR: number, segs: number, rgs: number,
    u: { rim: number; edgeGain: number; body: number; thick: number; edge: number; opacity: number; seed: number; warp: number },
    order: number,
  ) => {
    const geo = new THREE.RingGeometry(innerR, 1, segs, rgs);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uThick: { value: u.thick },
        uSeed: { value: u.seed },
        uInner: { value: innerR },
        uWarp: { value: u.warp },
        uRimGain: { value: u.rim },
        uEdgeGain: { value: u.edgeGain },
        uOpacity: { value: u.opacity },
        uBody: { value: u.body },
        uEdgeSharp: { value: u.edge },
      },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = order;
    group.add(m);
    return { m, mat, geo };
  };

  const em = opts.emissive ?? 4.2;
  const main = mk(inner, seg, rings, {
    rim: em, edgeGain: 0.55, body: 0.30, thick: opts.thickness ?? 0.055,
    edge: 1.0, opacity: 1.0, seed, warp: 1.0,
  }, 32);
  const haze = mk(0.34, Math.floor(seg * 0.4), 6, {
    rim: em * 0.05, edgeGain: 0.12, body: 0.15, thick: (opts.thickness ?? 0.055) * 2.4,
    edge: 3.0, opacity: 0.5, seed: seed + 17.3, warp: 0.55,
  }, 31);

  const parts = [main, haze];
  const relScale = [1.0, 1.035];
  let tris = 0;
  for (const p of parts) tris += p.geo.index ? p.geo.index.count / 3 : p.geo.attributes.position.count / 3;

  return {
    mesh: group,
    triangles: tris,
    drawCalls: parts.length,
    setRadius(r: number) { for (let i = 0; i < parts.length; i++) parts[i].m.scale.set(r * relScale[i], r * relScale[i], r * relScale[i]); },
    setProgress(t: number) { for (const p of parts) p.mat.uniforms.uProgress.value = t; },
    setIntensity(i: number) {
      main.mat.uniforms.uOpacity.value = i;
      haze.mat.uniforms.uOpacity.value = i * 0.5;
    },
    update(_dt: number, time: number, _camera: THREE.Camera) {
      for (const p of parts) p.mat.uniforms.uTime.value = time;
    },
    dispose() { for (const p of parts) { p.geo.dispose(); p.mat.dispose(); } group.clear(); },
  };
}

/* ================================================================== */
/*  SPHERICAL WAVE                                                     */
/* ================================================================== */

export interface ShockSphereOptions {
  seed?: number;
  detail?: number;
  wobble?: number;
  emissive?: number;
}

const SPH_VERT = /* glsl */ `
${P}
uniform float uTime, uProgress, uWobble, uSeed;
varying vec3 vPos;
varying vec3 vDir;
void main(){
  vec3 dir = normalize(position);
  float lump = fbm3(dir*2.3 + vec3(uSeed), 4, 2.05, 0.55) - 0.5;
  float lump2 = ridged3(dir*5.1 + vec3(uSeed*2.0), 3, 2.1, 0.5) - 0.45;
  vec3 p = dir * (1.0 + (lump*1.4 + lump2*0.7) * uWobble);
  vPos = p; vDir = dir;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const SPH_FRAG = /* glsl */ `
${P}
precision highp float;
vec3 bbn(float t){ return blackbody(t) * 0.28; }
uniform vec3  uCamObj;
uniform float uTime, uProgress, uIntensity, uOpacity, uSeed;
varying vec3 vPos;
varying vec3 vDir;

void main(){
  vec3 N = normalize(vDir);
  vec3 V = normalize(vPos - uCamObj);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
  float limb = pow(1.0 - ndv, 3.4);

  vec3 q = N*5.5 + vec3(uSeed);
  float cell = ridged3(q + vec3(uTime*0.14), 4, 2.11, 0.50);
  float fine = fbm3(N*17.0 - vec3(uTime*0.42), 4, 2.22, 0.50);
  float veins = smoothstep(0.38, 0.92, cell*fine*2.2);
  veins = max(veins, smoothstep(0.72, 0.98, ridged3(N*11.0 + vec3(uTime*0.25), 4, 2.15, 0.5)) * 0.7);

  float shell = limb*limb*2.2 + 0.012;
  float amt = shell * (0.10 + 1.55*veins) * uIntensity;
  if(amt < 0.002) discard;

  float temp = clamp(0.26 + cell*0.40 + limb*0.44 + veins*0.22, 0.0, 1.05);
  vec3 col = bbn(temp);
  col = mix(col, vec3(0.38, 0.62, 1.20), limb*0.55);

  gl_FragColor = vec4(col * amt * uOpacity, 1.0);
}
`;

export function createShockwaveSphere(opts: ShockSphereOptions = {}): ShockwavePart {
  const geo = new THREE.IcosahedronGeometry(1, opts.detail ?? 31);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uWobble: { value: opts.wobble ?? 0.035 },
      uSeed: { value: opts.seed ?? 9 },
      uIntensity: { value: opts.emissive ?? 2.6 },
      uOpacity: { value: 1 },
      uCamObj: { value: new THREE.Vector3(0, 0, 3) },
    },
    vertexShader: SPH_VERT,
    fragmentShader: SPH_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;
  const _c = new THREE.Vector3();

  return {
    mesh,
    triangles: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
    drawCalls: 1,
    setRadius(r: number) { mesh.scale.setScalar(r); },
    setProgress(t: number) { mat.uniforms.uProgress.value = t; },
    setIntensity(i: number) { mat.uniforms.uOpacity.value = i; },
    update(_dt: number, time: number, camera: THREE.Camera) {
      mat.uniforms.uTime.value = time;
      camObjInto(mesh, camera, _c);
      (mat.uniforms.uCamObj.value as THREE.Vector3).copy(_c);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

/* ================================================================== */
/*  DISTORTION SHELL (fake refraction via multiply blend)              */
/* ================================================================== */

export interface ShockDistortOptions {
  seed?: number;
  detail?: number;
  amount?: number;
}

const DIS_VERT = SPH_VERT;

const DIS_FRAG = /* glsl */ `
${P}
precision highp float;
uniform vec3  uCamObj;
uniform float uTime, uProgress, uAmount, uSeed;
varying vec3 vPos;
varying vec3 vDir;

void main(){
  vec3 N = normalize(vDir);
  vec3 V = normalize(vPos - uCamObj);
  float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);

  // How much shell the view ray travels through: grazing = a lot.
  float path = pow(1.0 - ndv, 1.35);

  vec3 q = N*4.4 + vec3(uSeed*1.7);
  float w  = fbm3(q + vec3(uTime*0.18), 4, 2.10, 0.55);
  float w2 = ridged3(q*2.6 - vec3(uTime*0.30), 3, 2.2, 0.5);
  float warp = w*0.65 + w2*0.55;

  float amt = clamp(uAmount * path * (0.45 + 1.35*warp), 0.0, 1.0);

  // Thin lens band right at the silhouette: bright, blue-shifted.
  float band = exp(-pow((ndv - 0.06)/0.10, 2.0)) * path;

  // Per-channel gain: red is bent away (dims), blue piles up (brightens).
  // Multiplying the framebuffer by this gives genuine chromatic fringing of
  // whatever is behind the wave.
  vec3 tint = vec3(1.0)
            + vec3(-0.82, -0.24, 0.72) * amt
            + vec3( 0.45,  0.80, 1.85) * band * 0.80;
  tint *= 1.0 - amt*0.42;                 // compressed void behind the front
  tint = clamp(tint, vec3(0.0), vec3(3.0));

  gl_FragColor = vec4(tint, 1.0);
}
`;

export function createShockwaveDistortion(opts: ShockDistortOptions = {}): ShockwavePart {
  const geo = new THREE.IcosahedronGeometry(1, opts.detail ?? 15);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uWobble: { value: 0.030 },
      uSeed: { value: opts.seed ?? 21 },
      uAmount: { value: opts.amount ?? 1.0 },
      uCamObj: { value: new THREE.Vector3(0, 0, 3) },
    },
    vertexShader: DIS_VERT,
    fragmentShader: DIS_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 29;   // before the additive rim so the rim survives
  const _c = new THREE.Vector3();
  const base = (opts.amount ?? 1.0);

  return {
    mesh,
    triangles: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
    drawCalls: 1,
    setRadius(r: number) { mesh.scale.setScalar(r); },
    setProgress(t: number) { mat.uniforms.uProgress.value = t; },
    setIntensity(i: number) { mat.uniforms.uAmount.value = base * i; },
    update(_dt: number, time: number, camera: THREE.Camera) {
      mat.uniforms.uTime.value = time;
      camObjInto(mesh, camera, _c);
      (mat.uniforms.uCamObj.value as THREE.Vector3).copy(_c);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
