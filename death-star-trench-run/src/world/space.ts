import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE } from '../shaders/lib';
import { createStarfieldMaterial, createGasGiantMaterial } from '../shaders/starfield';
import { RNG } from '../core/rng';
import { clamp, smoothstep } from '../core/mathx';

/* =============================================================================
   SPACE ENVIRONMENT — the backdrop for the Battle of Yavin.

   Everything here is procedural GLSL: no textures, no external assets.
   The whole thing is 5 draw calls:
       sky sphere · gas giant · sun billboard · moons · dust motes

   `group` is re-centred on the camera every frame, so the sky, the sun and
   Yavin are all effectively at infinity while their *lighting* stays fixed in
   world space.
============================================================================= */

/** Direction from the world origin toward the sun. */
const SUN_DIR = new THREE.Vector3(0.34, 0.30, 0.89).normalize();
/**
 * Yavin sits ~92 deg from the sun and well clear of it: far enough away to be a
 * pure background element, and at a phase angle that gives a strong half-lit
 * terminator rather than a flat fully-lit disc. Lifted above the trench horizon
 * so it is visible along the whole run.
 */
const PLANET_DIR = new THREE.Vector3(0.20, 0.94, -0.185).normalize();

const SKY_R = 420000;
const SUN_LIGHT_DIST = 300000;
const SUN_BILLBOARD_DIST = 400000;
const SUN_BILLBOARD_HALF = 78000;      // ~11.0 deg half-angle — room for the flare
const PLANET_DIST = 480000;
const PLANET_R = 60000;                // subtends ~7.2 deg half-angle
const MOTE_BOX = 1400;                 // metres — mote wrap volume around the camera
const MOTE_COUNT = 260;

/* ------------------------------------------------------------------ sun disc */

const SUN_VERT = /* glsl */ `
varying vec2 vP;
void main(){
  vP = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SUN_FRAG = /* glsl */ `
precision highp float;
uniform float uTime, uFade, uCore, uDiscR;
varying vec2 vP;

void main(){
  float r = length(vP);
  float ang = atan(vP.y, vP.x);

  vec3 warm  = vec3(1.00, 0.95, 0.87);
  vec3 amber = vec3(1.00, 0.70, 0.36);

  /* photosphere: crisp disc, HDR core. Kept small and not too hot — bloom
     turns anything larger into a featureless white ball. */
  float aa = fwidth(r) * 1.3 + 0.0004;
  float disc = smoothstep(uDiscR + aa, uDiscR - aa, r);
  vec3 c = warm * disc * uCore;

  /* chromosphere: a thin hot skirt right off the limb */
  c += warm * 3.0 * exp(-r * 130.0);

  /* corona with a little ray structure so it isn't a plain radial blob.
     Amber, so the bloom skirt keeps some colour instead of going pure white. */
  float rays = 0.70 + 0.20 * sin(ang * 19.0 + 1.7 + uTime * 0.05)
                    + 0.10 * sin(ang * 7.0 - 0.6 - uTime * 0.03);
  c += mix(warm, amber, 0.80) * 0.55 * exp(-r * 11.0) * rays;

  /* wide halo — the part that reads as atmospheric veiling flare */
  c += amber * 0.055 * exp(-r * 6.0) * uFade;

  /* screen-aligned streaks: a long 4-point cross plus faint 45 deg spurs */
  float spike = exp(-abs(vP.x) * 4.2 - vP.y * vP.y * 9000.0)
              + exp(-abs(vP.y) * 4.2 - vP.x * vP.x * 9000.0);
  vec2 dg = vec2(vP.x + vP.y, vP.x - vP.y) * 0.70710678;
  spike += 0.30 * (exp(-abs(dg.x) * 7.5 - dg.y * dg.y * 14000.0)
                 + exp(-abs(dg.y) * 7.5 - dg.x * dg.x * 14000.0));
  c += mix(warm, amber, 0.25) * spike * 0.80 * uFade;

  /* a few concentric ghost rings — kept very faint and angularly broken so
     they read as lens artefacts rather than a bullseye */
  float garc = 0.45 + 0.55 * (0.5 + 0.5 * sin(ang * 2.0 + 0.8));
  float g = 0.0;
  g += exp(-pow((r - 0.30) * 34.0, 2.0)) * 0.60;
  g += exp(-pow((r - 0.46) * 26.0, 2.0)) * 0.38 * garc;
  g += exp(-pow((r - 0.66) * 19.0, 2.0)) * 0.26 * garc;
  c += mix(amber, vec3(0.50, 0.78, 1.00), 0.42) * g * 0.045 * uFade;

  c *= smoothstep(1.0, 0.88, r);      // never show the quad edge
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}
`;

/* -------------------------------------------------------------------- moons */

const MOON_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute float aSize;
attribute float aIdx;
varying vec2 vP;
varying vec3 vC;
varying float vI;
void main(){
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wpos = (modelMatrix * vec4(position, 1.0)).xyz;
  vP = aCorner;
  vI = aIdx;
  vC = normalize(wpos - cameraPosition);
  vec3 wp = wpos + (camR * aCorner.x + camU * aCorner.y) * aSize;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const MOON_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform float uBright;
varying vec2 vP;
varying vec3 vC;
varying float vI;

${GLSL_HASH}
${GLSL_NOISE}

void main(){
  float r = length(vP);
  if(r > 1.0) discard;

  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 n = normalize(camR * vP.x + camU * vP.y - vC * sqrt(max(1.0 - r * r, 0.0)));

  float d = dot(n, uSunDir);
  float lam = smoothstep(-0.04, 0.24, d) * (0.22 + 0.78 * clamp(d, 0.0, 1.0));
  float mot = 0.70 + 0.55 * vnoise3(n * 6.5 + vI * 17.0);
  float edge = smoothstep(1.0, 1.0 - max(fwidth(r) * 2.0, 0.015), r);

  vec3 base = mix(vec3(0.74, 0.71, 0.66), vec3(0.60, 0.66, 0.74), vI);
  gl_FragColor = vec4(max(base * lam * mot * edge * uBright, 0.0), 1.0);
}
`;

/* --------------------------------------------------------------- dust motes */

const MOTE_VERT = /* glsl */ `
uniform vec3 uCamPos;
uniform float uBox, uSize, uPix;
attribute float aSeed;
varying float vA;
void main(){
  /* wrap the whole cloud into a box centred on the camera -> infinite field */
  vec3 rel = mod(position - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
  vec4 mv = modelViewMatrix * vec4(rel, 1.0);
  float dist = max(-mv.z, 0.001);
  vA = smoothstep(6.0, 60.0, dist) * (1.0 - smoothstep(uBox * 0.36, uBox * 0.5, length(rel)));
  vA *= 0.55 + 0.45 * aSeed;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPix * clamp(220.0 / dist, 0.35, 2.2);
}
`;

const MOTE_FRAG = /* glsl */ `
precision highp float;
uniform float uBright;
varying float vA;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float a = exp(-dot(c, c) * 14.0);
  gl_FragColor = vec4(vec3(0.52, 0.60, 0.78) * a * vA * uBright, 1.0);
}
`;

/* ========================================================================== */

export interface SpaceEnv {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  fill: THREE.HemisphereLight;
  /** call every frame */
  update(dt: number, time: number, camera: THREE.Camera): void;
  setNebula(v: number): void;
  setStarBrightness(v: number): void;
  /** Yavin gas giant — the integrator may reposition or hide it */
  planet: THREE.Object3D;
  dispose(): void;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * Build the planet's orientation so that (a) its spin axis is a pleasing tilt
 * in world space and (b) the great-spot vortex baked into the shader ends up
 * facing the camera, a little off centre. Called once at build time.
 */
function orientPlanet(): THREE.Quaternion {
  // the vortex centre baked into the gas-giant shader: lat -0.34, lon 1.15
  const lat = -0.34, lon = 1.15;
  const sl = new THREE.Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.sin(lon),
  ).normalize();

  const Y = new THREE.Vector3(0, 1, 0);
  const sy = sl.dot(Y);
  const h = sl.clone().addScaledVector(Y, -sy).normalize();
  const Ml = new THREE.Matrix4().makeBasis(h, Y, new THREE.Vector3().crossVectors(h, Y));

  const axis = new THREE.Vector3(0.16, 0.95, 0.27).normalize();      // spin axis, world
  // direction from the planet toward the origin, swung a little around the
  // pole so the spot sits off centre rather than dead in the middle
  const V = PLANET_DIR.clone().negate().applyAxisAngle(axis, 0.38);
  const Vp = V.addScaledVector(axis, -V.dot(axis)).normalize();
  const Mw = new THREE.Matrix4().makeBasis(Vp, axis, new THREE.Vector3().crossVectors(Vp, axis));

  return new THREE.Quaternion().setFromRotationMatrix(Mw.multiply(Ml.transpose()));
}

export function createSpaceEnv(opts: { seed?: number } = {}): SpaceEnv {
  const seed = opts.seed ?? 1337;
  const rng = new RNG(seed);

  const group = new THREE.Group();
  group.name = 'spaceEnv';

  /* ---------------------------------------------------------- sky sphere -- */
  const skyGeo = new THREE.SphereGeometry(SKY_R, 96, 64);
  const skyMat = createStarfieldMaterial({ seed });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.matrixAutoUpdate = false;
  sky.updateMatrix();
  group.add(sky);

  /* -------------------------------------------------------------- planet -- */
  // `planet` is a container so the integrator can move / hide Yavin *and* its
  // moons as one thing.
  const planet = new THREE.Group();
  planet.name = 'yavin';
  planet.position.copy(PLANET_DIR).multiplyScalar(PLANET_DIST);
  group.add(planet);

  const planetGeo = new THREE.SphereGeometry(PLANET_R, 72, 48);
  const planetMat = createGasGiantMaterial({ seed: seed + 7 });
  planetMat.uniforms.uSunDir.value.copy(SUN_DIR);
  const planetMesh = new THREE.Mesh(planetGeo, planetMat);
  planetMesh.quaternion.copy(orientPlanet());
  planetMesh.renderOrder = -900;
  planetMesh.frustumCulled = false;
  planetMesh.matrixAutoUpdate = false;
  planetMesh.updateMatrix();
  planet.add(planetMesh);

  /* --------------------------------------------------------------- moons -- */
  // orthonormal basis around the planet direction
  _a.set(0, 1, 0).cross(PLANET_DIR).normalize();
  _b.copy(PLANET_DIR).cross(_a).normalize();
  const planetCentre = PLANET_DIR.clone().multiplyScalar(PLANET_DIST);
  const moonDefs = [
    { off: 0.205, az: 0.9, ang: 0.0096 },   // ~11.7 deg away, 0.55 deg radius
    { off: 0.285, az: 3.9, ang: 0.0058 },   // ~16.3 deg away, 0.33 deg radius
  ];
  const mPos = new Float32Array(8 * 3);
  const mCorner = new Float32Array(8 * 2);
  const mSize = new Float32Array(8);
  const mIdx = new Float32Array(8);
  const mIndex: number[] = [];
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < moonDefs.length; i++) {
    const d = moonDefs[i];
    _v.copy(PLANET_DIR)
      .addScaledVector(_a, Math.cos(d.az) * d.off)
      .addScaledVector(_b, Math.sin(d.az) * d.off)
      .normalize()
      .multiplyScalar(PLANET_DIST)
      .sub(planetCentre);            // stored relative to the planet container
    for (let k = 0; k < 4; k++) {
      const o = i * 4 + k;
      mPos[o * 3 + 0] = _v.x; mPos[o * 3 + 1] = _v.y; mPos[o * 3 + 2] = _v.z;
      mCorner[o * 2 + 0] = corners[k * 2 + 0];
      mCorner[o * 2 + 1] = corners[k * 2 + 1];
      mSize[o] = PLANET_DIST * Math.tan(d.ang);
      mIdx[o] = i;
    }
    const b0 = i * 4;
    mIndex.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
  }
  const moonGeo = new THREE.BufferGeometry();
  moonGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  moonGeo.setAttribute('aCorner', new THREE.BufferAttribute(mCorner, 2));
  moonGeo.setAttribute('aSize', new THREE.BufferAttribute(mSize, 1));
  moonGeo.setAttribute('aIdx', new THREE.BufferAttribute(mIdx, 1));
  moonGeo.setIndex(mIndex);
  const moonMat = new THREE.ShaderMaterial({
    name: 'yavinMoons',
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() },
      uBright: { value: 0.55 },
    },
    vertexShader: MOON_VERT,
    fragmentShader: MOON_FRAG,
    depthWrite: false,
    depthTest: false,
    transparent: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const moons = new THREE.Mesh(moonGeo, moonMat);
  moons.renderOrder = -890;
  moons.frustumCulled = false;
  moons.matrixAutoUpdate = false;
  moons.updateMatrix();
  planet.add(moons);

  /* ----------------------------------------------------------------- sun -- */
  const sunGeo = new THREE.PlaneGeometry(SUN_BILLBOARD_HALF * 2, SUN_BILLBOARD_HALF * 2);
  const sunMat = new THREE.ShaderMaterial({
    name: 'sunDisc',
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uCore: { value: 18 },
      uDiscR: { value: 0.038 },   // ~0.42 deg disc inside an 11 deg quad
    },
    vertexShader: SUN_VERT,
    fragmentShader: SUN_FRAG,
    depthWrite: false,
    depthTest: false,
    transparent: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const sunDisc = new THREE.Mesh(sunGeo, sunMat);
  sunDisc.position.copy(SUN_DIR).multiplyScalar(SUN_BILLBOARD_DIST);
  sunDisc.renderOrder = -880;
  sunDisc.frustumCulled = false;
  group.add(sunDisc);

  /* ----------------------------------------------------------- dust motes -- */
  const motePos = new Float32Array(MOTE_COUNT * 3);
  const moteSeed = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    motePos[i * 3 + 0] = rng.range(0, MOTE_BOX);
    motePos[i * 3 + 1] = rng.range(0, MOTE_BOX);
    motePos[i * 3 + 2] = rng.range(0, MOTE_BOX);
    moteSeed[i] = rng.next();
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(moteSeed, 1));
  const moteMat = new THREE.ShaderMaterial({
    name: 'dustMotes',
    uniforms: {
      uCamPos: { value: new THREE.Vector3() },
      uBox: { value: MOTE_BOX },
      uSize: { value: 1.7 },
      uPix: { value: 1 },
      uBright: { value: 0.5 },
    },
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    depthWrite: false,
    depthTest: true,
    transparent: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  // positive renderOrder: all normal opaque geometry lays down depth first, so
  // motes drifting past are correctly occluded by trench walls and hulls
  motes.renderOrder = 5;
  motes.frustumCulled = false;
  motes.matrixAutoUpdate = false;
  motes.updateMatrix();
  group.add(motes);

  /* --------------------------------------------------------------- lights -- */
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
  sun.position.copy(SUN_DIR).multiplyScalar(SUN_LIGHT_DIST);
  sun.castShadow = false;
  sun.name = 'keySun';

  const fill = new THREE.HemisphereLight(0x2a3d55, 0x100a06, 0.35);
  fill.name = 'spaceFill';
  // harmless inside the (position-independent) group; if the integrator adds it
  // to the scene itself three.js just reparents it.
  group.add(fill);

  /* --------------------------------------------------------------- update -- */
  const uSkyTime = skyMat.uniforms.uTime;
  const uPlanetTime = planetMat.uniforms.uTime;
  const uSunTime = sunMat.uniforms.uTime;
  const uSunFade = sunMat.uniforms.uFade;
  const uMoteCam = moteMat.uniforms.uCamPos.value as THREE.Vector3;
  moteMat.uniforms.uPix.value =
    typeof devicePixelRatio === 'number' ? Math.min(devicePixelRatio, 2) : 1;

  function update(_dt: number, time: number, camera: THREE.Camera) {
    // the whole backdrop rides with the camera -> effectively at infinity
    camera.getWorldPosition(_v);
    group.position.copy(_v);
    uMoteCam.copy(_v);

    // the sun billboard is screen-aligned so its spikes stay screen-aligned
    camera.getWorldQuaternion(_q);
    sunDisc.quaternion.copy(_q);

    uSkyTime.value = time;
    uPlanetTime.value = time;
    uSunTime.value = time;

    // flare strength falls off as the sun approaches the edge of frame
    _m.copy(camera.matrixWorld).invert();
    _a.copy(SUN_DIR).multiplyScalar(SUN_BILLBOARD_DIST).add(_v).applyMatrix4(_m);
    let fade = 0;
    if (_a.z < 0) {
      _a.applyMatrix4(camera.projectionMatrix);
      const edge = Math.max(Math.abs(_a.x), Math.abs(_a.y));
      fade = 1 - smoothstep(0.45, 1.05, edge);
    }
    uSunFade.value = fade;
  }

  /* --------------------------------------------------------------- public -- */
  return {
    group,
    sun,
    fill,
    planet,
    update,
    setNebula(v: number) { skyMat.uniforms.uNebula.value = clamp(v, 0, 1); },
    setStarBrightness(v: number) { skyMat.uniforms.uStarBright.value = Math.max(0, v); },
    dispose() {
      skyGeo.dispose(); skyMat.dispose();
      planetGeo.dispose(); planetMat.dispose();
      moonGeo.dispose(); moonMat.dispose();
      sunGeo.dispose(); sunMat.dispose();
      moteGeo.dispose(); moteMat.dispose();
      planet.clear();
      group.clear();
      sun.dispose();
      fill.dispose();
    },
  };
}
