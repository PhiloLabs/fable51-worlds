import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROT } from './lib';

/* =========================================================================
   PROTON TORPEDO

   A dense blue-white plasma core (HDR ~30), a pulsing corona billboard, a
   48-segment ribbon that follows the real flight path, and a swirl of
   orbiting sparks computed analytically in the vertex shader.

   `object` is a Group: parent it anywhere and drive `object.position`.
   The ribbon is stored in WORLD space and re-expressed in the group's local
   frame each update, so it stays pinned to the path the torpedo actually flew.
   ========================================================================= */

export interface TorpedoVisual {
  object: THREE.Object3D;
  setIntensity(v: number): void;
  update(dt: number, time: number, camera: THREE.Camera, velocity: THREE.Vector3): void;
  dispose(): void;
}

const SEGMENTS = 48;
const NPTS = SEGMENTS + 1;
const SPARKS = 44;

/* ------------------------------------------------------------------ core */

const CORE_VERT = /* glsl */ `
precision highp float;
varying vec3 vDir;
varying vec3 vNormalW;
varying vec3 vViewW;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CORE_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}

uniform float uTime;
uniform float uIntensity;
uniform vec3  uColor;

varying vec3 vDir;
varying vec3 vNormalW;
varying vec3 vViewW;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewW);
  float fres = 1.0 - abs(dot(N, V));
  float centre = pow(1.0 - fres, 2.2);

  // churning plasma cells + filaments on the surface, visible from 2 m
  vec3 q = vDir * 3.4 + vec3(0.0, uTime * 0.85, uTime * 0.3);
  // warp the cells so the core reads as churning plasma, not a golf ball
  float cells = 1.0 - worley3(warp3(q * 1.5, 0.55, 1.7));
  float fil = ridged3(vDir * 5.5 + vec3(uTime * 1.4, 0.0, uTime * -0.7), 4, 2.15, 0.55);
  float n = fbm3(q, 4, 2.2, 0.55);

  float shell = pow(fres, 2.4) * (0.40 + 1.05 * fil);
  // strong noise weighting keeps visible plasma structure instead of a white ball
  float body = centre * (0.12 + 1.35 * n) * (0.55 + 0.85 * fil) + cells * 0.6 * (0.25 + fres);

  float pulse = 0.86 + 0.14 * sin(uTime * 26.0) + 0.06 * sin(uTime * 61.0);

  vec3 hot = mix(uColor, vec3(1.0, 1.0, 1.0), clamp(centre * 0.95, 0.0, 1.0));
  vec3 col = hot * (body * 2.2 + shell * 1.5) * pulse;
  // tight white-hot pinhole so bloom flares white without washing the body
  col += vec3(1.0) * pow(centre, 14.0) * (2.2 + 1.6 * n);

  float a = clamp(body * 1.5 + shell, 0.0, 1.0);
  gl_FragColor = vec4(col * uIntensity, a);
}
`;

/* --------------------------------------------------------------- corona */

const BILLBOARD_VERT = /* glsl */ `
precision highp float;
uniform float uSize;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 originVS = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 p = originVS + vec3(position.x, position.y, 0.0) * uSize;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const CORONA_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}
${GLSL_ROT}

uniform float uTime;
uniform float uIntensity;
uniform vec3  uColor;
varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;

  float ang = atan(p.y, p.x);
  float rays = 0.55 + 0.45 * fbm2(vec2(ang * 2.6, uTime * 0.9), 3, 2.1, 0.6);
  float halo = pow(max(1.0 - r, 0.0), 2.6) * (0.55 + 0.7 * rays);
  float inner = pow(max(1.0 - r, 0.0), 10.0) * 2.6;
  // anamorphic streak, sells the "hot light source" read
  float streak = exp(-abs(p.y) * 26.0) * exp(-abs(p.x) * 1.7) * 0.85;

  float pulse = 0.82 + 0.18 * sin(uTime * 19.0);
  float I = (halo + inner + streak) * pulse;
  vec3 col = mix(uColor, vec3(1.0), clamp(inner * 0.6, 0.0, 1.0)) * I;
  gl_FragColor = vec4(col * uIntensity, clamp(I, 0.0, 1.0));
}
`;

/* ---------------------------------------------------------------- trail */

const TRAIL_VERT = /* glsl */ `
precision highp float;
attribute float aT;
attribute float aSide;
varying float vT;
varying float vSide;
void main() {
  vT = aT;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TRAIL_FRAG = /* glsl */ `
precision highp float;
${GLSL_HASH}
${GLSL_NOISE}

uniform float uTime;
uniform float uIntensity;
uniform float uFill;
uniform vec3  uColor;
varying float vT;
varying float vSide;

void main() {
  float s = abs(vSide);
  float core = exp(-s * s * 16.0);
  float glow = exp(-s * s * 2.4);

  // energy shimmer running back along the wake
  float n = fbm2(vec2(vT * 9.0 + uTime * 3.5, 3.7), 3, 2.2, 0.55);
  float shimmer = 0.66 + 0.62 * n;

  float lenFade = pow(max(1.0 - vT, 0.0), 1.5) * smoothstep(0.0, 0.04, vT);
  float valid = step(vT, uFill + 1e-4);

  vec3 hot = mix(vec3(1.0, 1.0, 1.0), uColor, smoothstep(0.0, 0.22, vT));
  vec3 cold = uColor * vec3(0.45, 0.62, 1.0);
  vec3 col = mix(hot, cold, smoothstep(0.12, 0.85, vT));

  float I = (core * 1.9 + glow * 0.55) * lenFade * shimmer * valid;
  // the white-hot streak only survives near the head; the wake stays blue
  float hotHead = 1.0 - smoothstep(0.0, 0.22, vT);
  col = col * I + vec3(0.88, 0.95, 1.0) * core * core * lenFade * valid * hotHead * 1.3;
  gl_FragColor = vec4(col * uIntensity, clamp(I, 0.0, 1.0));
}
`;

/* --------------------------------------------------------------- sparks */

const SPARK_VERT = /* glsl */ `
precision highp float;
attribute float aIdx;
uniform float uTime;
uniform float uRadius;
uniform float uPixelScale;
uniform float uSize;
uniform vec3  uBack;      // local-space "backwards" (opposite travel)
uniform float uPull;
varying float vSeed;
varying float vLife;

float h(float x){ return fract(sin(x * 78.233) * 43758.5453); }

void main() {
  float i = aIdx;
  float s1 = h(i * 1.37);
  float s2 = h(i * 2.71 + 4.1);
  float s3 = h(i * 5.13 + 9.7);
  vSeed = s1;

  float sp = 2.2 + s2 * 5.5;
  float t = uTime * sp + i * 2.399963;

  vec3 axis = normalize(vec3(s1 - 0.5, s2 - 0.5, s3 - 0.5) + vec3(0.001));
  vec3 u = normalize(cross(axis, vec3(0.0, 0.0, 1.0) + vec3(0.31, 0.11, 0.0)));
  vec3 w = cross(axis, u);

  float rr = uRadius * (0.55 + 0.75 * s3) * (0.85 + 0.15 * sin(t * 0.83 + s1 * 10.0));
  vec3 p = (u * cos(t) + w * sin(t)) * rr;
  // streamed back into the wake
  p += uBack * (uPull * (0.15 + 1.25 * s2) * (0.55 + 0.45 * sin(t * 0.4)));

  vLife = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (7.0 + s2 * 14.0) + s1 * 30.0));

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (0.5 + s1) * uPixelScale / max(-mv.z, 0.01), 1.0, 60.0);
}
`;

const SPARK_FRAG = /* glsl */ `
precision highp float;
uniform float uIntensity;
uniform vec3  uColor;
varying float vSeed;
varying float vLife;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = pow(max(1.0 - d, 0.0), 3.5);
  float glow = pow(max(1.0 - d, 0.0), 1.2);
  float I = (core * 2.4 + glow * 0.4) * vLife;
  vec3 col = mix(uColor, vec3(1.0), core * 0.7) * I;
  gl_FragColor = vec4(col * uIntensity, clamp(I, 0.0, 1.0));
}
`;

/* ------------------------------------------------------------- factory */

const _wp = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _side = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _back = new THREE.Vector3();

export function createTorpedoVisual(opts?: { color?: THREE.Color; scale?: number; trail?: number }): TorpedoVisual {
  const color = (opts?.color ?? new THREE.Color(0.42, 0.82, 1.0)).clone();
  const scale = opts?.scale ?? 1;
  const trailLen = opts?.trail ?? 95 * scale;
  const step = trailLen / SEGMENTS;
  const step2 = step * step;

  const group = new THREE.Group();
  group.name = 'torpedo-fx';

  /* core */
  const coreGeo = new THREE.IcosahedronGeometry(0.42 * scale, 4);
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.62 },
      uColor: { value: color.clone() },
    },
    vertexShader: CORE_VERT,
    fragmentShader: CORE_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.FrontSide, toneMapped: true,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.renderOrder = 16;
  group.add(core);

  /* corona */
  const quad = new THREE.PlaneGeometry(2, 2);
  const coronaMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.28 },
      uSize: { value: 1.45 * scale },
      uColor: { value: color.clone() },
    },
    vertexShader: BILLBOARD_VERT,
    fragmentShader: CORONA_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, toneMapped: true,
  });
  const corona = new THREE.Mesh(quad, coronaMat);
  corona.frustumCulled = false;
  corona.renderOrder = 15;
  group.add(corona);

  /* trail ribbon */
  const trailGeo = new THREE.BufferGeometry();
  const tPos = new THREE.BufferAttribute(new Float32Array(NPTS * 2 * 3), 3);
  tPos.setUsage(THREE.DynamicDrawUsage);
  const tT = new Float32Array(NPTS * 2);
  const tS = new Float32Array(NPTS * 2);
  const tIdx: number[] = [];
  for (let i = 0; i < NPTS; i++) {
    const t = i / SEGMENTS;
    tT[i * 2] = t; tT[i * 2 + 1] = t;
    tS[i * 2] = -1; tS[i * 2 + 1] = 1;
    if (i < SEGMENTS) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      tIdx.push(a, b, c, b, d, c);
    }
  }
  trailGeo.setAttribute('position', tPos);
  trailGeo.setAttribute('aT', new THREE.BufferAttribute(tT, 1));
  trailGeo.setAttribute('aSide', new THREE.BufferAttribute(tS, 1));
  trailGeo.setIndex(tIdx);
  trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), trailLen * 2.5);
  const trailMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.28 },
      uFill: { value: 0 },
      uColor: { value: color.clone() },
    },
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: true,
  });
  const trail = new THREE.Mesh(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.renderOrder = 14;
  group.add(trail);

  /* orbiting sparks */
  const sparkGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array(SPARKS * 3);
  const sIdx = new Float32Array(SPARKS);
  for (let i = 0; i < SPARKS; i++) sIdx[i] = i;
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  sparkGeo.setAttribute('aIdx', new THREE.BufferAttribute(sIdx, 1));
  sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20 * scale);
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0.9 },
      uRadius: { value: 1.15 * scale },
      uPixelScale: { value: 900 },
      uSize: { value: 0.085 * scale },
      uBack: { value: new THREE.Vector3(0, 0, 1) },
      uPull: { value: 2.6 * scale },
      uColor: { value: color.clone() },
    },
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, toneMapped: true,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  sparks.renderOrder = 15;
  group.add(sparks);

  /* trail state (world space) */
  const pts = new Float32Array(NPTS * 3);
  let nPts = 0;
  let intensity = 1;
  let started = false;

  const pushPoint = (x: number, y: number, z: number) => {
    pts.copyWithin(3, 0, (NPTS - 1) * 3);
    pts[0] = x; pts[1] = y; pts[2] = z;
    if (nPts < NPTS) nPts++;
  };

  const resetTrail = (x: number, y: number, z: number) => {
    for (let i = 0; i < NPTS; i++) { pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z; }
    nPts = 1;
  };

  /** ribbon point i: 0 = live head position, i>=1 = committed path point i-1 */
  let lastIdx = 0;
  const at = (i: number, out: THREE.Vector3): THREE.Vector3 => {
    const k = Math.min(i, lastIdx);
    if (k <= 0) return out.copy(_wp);
    const j = k - 1;
    return out.set(pts[j * 3], pts[j * 3 + 1], pts[j * 3 + 2]);
  };

  const update = (dt: number, time: number, camera: THREE.Camera, velocity: THREE.Vector3) => {
    group.updateWorldMatrix(true, false);
    group.getWorldPosition(_wp);
    camera.getWorldPosition(_cam);

    if (!started) { resetTrail(_wp.x, _wp.y, _wp.z); started = true; }

    // Append committed path points at a fixed spacing, interpolating across
    // fast frames. Ribbon vertex 0 is always the live position; vertex i>=1
    // reads committed point i-1, so the ribbon never detaches from the head.
    _prev.set(pts[0], pts[1], pts[2]);
    let d2 = _wp.distanceToSquared(_prev);
    if (d2 > trailLen * trailLen * 9) {
      resetTrail(_wp.x, _wp.y, _wp.z);        // teleport / respawn
    } else {
      let guard = 0;
      while (d2 > step2 && guard++ < NPTS) {
        const d = Math.sqrt(d2);
        _p.lerpVectors(_prev, _wp, step / d);
        pushPoint(_p.x, _p.y, _p.z);
        _prev.copy(_p);
        d2 = _wp.distanceToSquared(_prev);
      }
    }

    // rebuild the ribbon in the group's local frame
    _inv.copy(group.matrixWorld).invert();
    const arr = tPos.array as Float32Array;
    const last = Math.min(nPts, NPTS - 1);
    lastIdx = last;
    const headW = 0.22 * scale;
    for (let i = 0; i < NPTS; i++) {
      at(i, _p);
      at(Math.max(i - 1, 0), _a);
      at(Math.min(i + 1, last), _b);
      _tan.subVectors(_a, _b);
      if (_tan.lengthSq() < 1e-9) _tan.set(0, 0, 1);
      _tan.normalize();
      _toCam.subVectors(_cam, _p).normalize();
      _side.crossVectors(_tan, _toCam);
      if (_side.lengthSq() < 1e-9) _side.set(1, 0, 0); else _side.normalize();

      const t = i / SEGMENTS;
      // narrow at the head, flares just behind it, tapers to a needle point
      const ramp = Math.min(1, t * 6.5);
      const w = i > last ? 0 : headW * (0.38 + 1.35 * ramp) * Math.pow(Math.max(0, 1 - t), 0.75);

      _p.applyMatrix4(_inv);
      _side.transformDirection(_inv).multiplyScalar(w);
      const o = i * 6;
      arr[o] = _p.x - _side.x; arr[o + 1] = _p.y - _side.y; arr[o + 2] = _p.z - _side.z;
      arr[o + 3] = _p.x + _side.x; arr[o + 4] = _p.y + _side.y; arr[o + 5] = _p.z + _side.z;
    }
    tPos.needsUpdate = true;
    trailMat.uniforms.uFill.value = last / SEGMENTS;

    // uniforms
    coreMat.uniforms.uTime.value = time;
    coronaMat.uniforms.uTime.value = time;
    trailMat.uniforms.uTime.value = time;
    sparkMat.uniforms.uTime.value = time;

    // pixel scale for the spark points
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) {
      const h = (typeof window !== 'undefined' ? window.innerHeight : 1080) * (window.devicePixelRatio || 1);
      sparkMat.uniforms.uPixelScale.value = h / (2 * Math.tan((pc.fov * Math.PI) / 360));
    }

    // stream sparks opposite the direction of travel, in local space
    _back.copy(velocity);
    if (_back.lengthSq() < 1e-8) _back.set(0, 0, 1); else _back.normalize().negate();
    _back.transformDirection(_inv);
    (sparkMat.uniforms.uBack.value as THREE.Vector3).copy(_back);
  };

  const setIntensity = (v: number) => {
    intensity = Math.max(0, v);
    coreMat.uniforms.uIntensity.value = 0.62 * intensity;
    coronaMat.uniforms.uIntensity.value = 0.28 * intensity;
    trailMat.uniforms.uIntensity.value = 0.55 * intensity;
    sparkMat.uniforms.uIntensity.value = 0.9 * intensity;
    group.visible = intensity > 0.001;
  };

  const dispose = () => {
    coreGeo.dispose(); coreMat.dispose();
    quad.dispose(); coronaMat.dispose();
    trailGeo.dispose(); trailMat.dispose();
    sparkGeo.dispose(); sparkMat.dispose();
    group.removeFromParent?.();
  };

  return { object: group, setIntensity, update, dispose };
}
