import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE } from './lib';

/* =========================================================================
   LASER BOLT — instanced, camera-facing "stretched billboard" capsule.

   The geometry is a unit-length quad strip running along +Z (z in [0,1],
   x = +-0.5).  The vertex shader rebuilds the ribbon in VIEW space so the
   bolt always presents its full width to the camera, which is what makes a
   thin bolt read as a solid volumetric shaft instead of a flat card.

   The material expects the instanced mesh to carry two instanced attributes:
     aColor : vec3   base colour (linear, ~1.0 range — brightness is in the shader)
     aData  : vec4   x = age01 (0..1 over the bolt's life)
                     y = length  (metres)
                     z = radius  (metres)
                     w = seed    (0..1, for the energy animation)
   The instance matrix carries position (bolt TAIL) + rotation (+Z = travel),
   with unit scale; length/radius come from aData so one geometry serves all.
   ========================================================================= */

/** Segments along the bolt. More = smoother width profile / less perspective error. */
const SEGMENTS = 16;

export function createBoltGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const n = SEGMENTS + 1;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / SEGMENTS;
    // left
    pos[i * 6 + 0] = -0.5; pos[i * 6 + 1] = 0; pos[i * 6 + 2] = t;
    // right
    pos[i * 6 + 3] = 0.5; pos[i * 6 + 4] = 0; pos[i * 6 + 5] = t;
    uv[i * 4 + 0] = 0; uv[i * 4 + 1] = t;
    uv[i * 4 + 2] = 1; uv[i * 4 + 3] = t;
    if (i < SEGMENTS) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  // The vertex shader relocates everything; give it a generous fixed bound and
  // let the owning mesh disable frustum culling.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.5), 4000);
  return g;
}

const VERT = /* glsl */ `
precision highp float;

attribute vec3 aColor;
attribute vec4 aData;   // age01, length, radius, seed

uniform float uPixelScale;   // world units per pixel at 1m depth (2*tan(fov/2)/screenH)
uniform float uMinPixels;    // minimum on-screen half-width, in pixels

varying vec3  vColor;
varying float vT;
varying float vSide;
varying float vAge;
varying float vSeed;
varying float vFatten;

void main() {
  vColor = aColor;
  vAge   = aData.x;
  vSeed  = aData.w;

  float len = aData.y;
  float rad = aData.z;
  float t   = position.z;
  vT = t;

  // Instance frame -> view space.
  vec4 originVS4 = modelViewMatrix * (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0));
  vec3 originVS  = originVS4.xyz;
  vec3 axisVS    = normalize((modelViewMatrix * (instanceMatrix * vec4(0.0, 0.0, 1.0, 0.0))).xyz);

  vec3 p = originVS + axisVS * (t * len);

  // Camera-facing ribbon: expand perpendicular to both the bolt axis and the eye ray.
  vec3 toEye = normalize(-p);
  vec3 c = cross(axisVS, toEye);
  float cl = length(c);
  vec3 side = (cl > 1e-4) ? (c / cl) : vec3(1.0, 0.0, 0.0);

  // 0 = seen broadside, 1 = looking straight down the barrel.
  float headOn = clamp(1.0 - cl, 0.0, 1.0);
  vFatten = headOn;

  // Width profile: tapered tail, full body, slight bulge just behind the head.
  float body   = pow(smoothstep(0.0, 0.20, t), 0.55) * (1.0 - 0.62 * smoothstep(0.84, 1.0, t));
  float bulge  = exp(-pow((t - 0.885) / 0.085, 2.0));
  float w = rad * (0.42 + 0.85 * body + 0.55 * bulge);

  // Foreshortened bolts become round glows rather than vanishing.
  w *= mix(1.0, 3.4, headOn * headOn);

  // Never let a distant bolt fall below a couple of pixels.
  float depth = max(-p.z, 0.02);
  w = max(w, depth * uPixelScale * uMinPixels);

  vSide = position.x * 2.0;
  p += side * (position.x * 2.0 * w);

  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

${GLSL_HASH}
${GLSL_NOISE}

uniform float uTime;
uniform float uIntensity;

varying vec3  vColor;
varying float vT;
varying float vSide;
varying float vAge;
varying float vSeed;
varying float vFatten;

void main() {
  float s  = abs(vSide);
  float s2 = s * s;

  // Three nested radial lobes: needle core, plasma sheath, soft halo.
  float core = exp(-s2 * 30.0);
  float glow = exp(-s2 * 4.6);
  float halo = exp(-s2 * 1.15);

  float t = vT;

  // Longitudinal shaping.
  float tail   = smoothstep(0.0, 0.14, t);
  float endcap = 1.0 - smoothstep(0.955, 1.0, t);
  float head   = smoothstep(0.68, 0.98, t);

  // Animated energy running down the shaft.
  float n = fbm2(vec2(t * 11.0 - uTime * 26.0 + vSeed * 91.0, vSeed * 23.0), 3, 2.2, 0.55);
  float energy = 0.72 + 0.62 * n;

  // Life fade: bolts dim slightly as they age out rather than blinking off.
  float lifeFade = 1.0 - smoothstep(0.86, 1.0, vAge);
  // Head-on bolts lose the shaft, keep the glow.
  float shaft = mix(1.0, 0.35, vFatten);

  float body = (core * 3.2 * energy * shaft + glow * 0.62 + halo * 0.13) * tail * endcap;
  float flare = head * (core * 2.6 + glow * 0.55);
  float I = (body + flare) * lifeFade;

  vec3 col = vColor * I;
  // A near-white needle in the centre so bloom blooms white, not just tinted.
  float white = core * core * (1.9 + 1.6 * head) * tail * endcap * lifeFade * shaft;
  col += vec3(1.0, 0.97, 0.93) * white;

  float a = clamp(I + white * 0.5, 0.0, 1.0);
  gl_FragColor = vec4(col * uIntensity, a);
}
`;

export function createLaserMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 4.2 },
      uPixelScale: { value: 0.0018 },
      uMinPixels: { value: 1.35 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: true,
  });
  return m;
}
