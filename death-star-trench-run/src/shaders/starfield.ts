import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE, GLSL_COLOR, GLSL_ROT } from './lib';

/* =============================================================================
   STARFIELD — the deep-space backdrop.

   Everything is procedural GLSL: no textures, no image files.
   The material is meant for an *inverted* sphere (BackSide) of radius ~420 000
   that is re-centred on the camera every frame, so the object-space direction
   of a fragment is exactly the world-space view direction.

   Content:
     · 4 density layers of hash-grid stars with a power-law flux distribution,
       a stellar-class colour ramp, a pixel-tight Gaussian core, a 4-point
       diffraction cross on the brightest few and a slow twinkle.
     · domain-warped FBM nebula concentrated on a galactic band, in cool
       blue/teal with magenta and dull-gold accents, broken into filaments.
     · a darker warm dust lane that crosses the band and extincts the stars
       behind it.

   Output is HDR linear — ACES + bloom happen in post.
============================================================================= */

const STAR_GLSL = /* glsl */ `
/* stellar class ramp: 0 = O/B blue-white, 1 = M red */
vec3 stellarColor(float t){
  vec3 c = vec3(0.62,0.75,1.00);
  c = mix(c, vec3(0.85,0.91,1.00), smoothstep(0.00,0.20,t));
  c = mix(c, vec3(1.00,0.99,0.96), smoothstep(0.18,0.40,t));
  c = mix(c, vec3(1.00,0.94,0.79), smoothstep(0.38,0.60,t));
  c = mix(c, vec3(1.00,0.80,0.58), smoothstep(0.58,0.80,t));
  c = mix(c, vec3(1.00,0.64,0.45), smoothstep(0.78,1.00,t));
  return c;
}

/* One grid cell -> the light it contributes to direction d.
   pixAng = radians subtended by one screen pixel (from screen derivatives),
   so every star is sized in *pixels* and stays crisp at any resolution. */
vec3 starCell(vec3 cell, vec3 d, float pixAng, float dens, float fluxScale,
              float sd, vec3 camX, vec3 camY, float twAmt, float spikeAmt){
  if(hash13(cell*0.913 + sd) > dens) return vec3(0.0);

  vec3 j  = hash33(cell + sd*1.7 + 3.1);
  vec3 r2 = hash33(cell*1.31 - sd*0.71 + 11.9);

  vec3 q  = cell + 0.25 + j*0.5;                 // jittered position inside the cell
  vec3 sdir = q * inversesqrt(dot(q,q));         // its direction on the sky
  vec3 dl = sdir - d;
  float rp = length(dl) / pixAng;                // angular distance, in pixels
  if(rp > 62.0) return vec3(0.0);

  /* power-law flux: N(>F) ~ F^-1.5  ->  F = u^(-1/1.5), a few very bright,
     thousands faint. */
  float u = max(r2.x, 0.0009);
  float flux = fluxScale * min(pow(u, -0.62), 120.0);

  /* brighter stars skew hotter/bluer (true of the naked-eye sky) */
  float ct = clamp(r2.y*1.16 - 0.34*smoothstep(2.0, 18.0, flux), 0.0, 1.0);
  vec3 col = stellarColor(ct);

  float tw = 1.0 + twAmt * sin(uTime*(0.65 + r2.z*2.2) + r2.z*61.0 + r2.y*23.0);

  float core = exp(-rp*rp*0.80);                 // tight ~0.8 px sigma gaussian
  float halo = 0.030 * exp(-rp*rp*0.050);        // faint airy skirt
  float I = core + halo;

  /* 4-point diffraction cross, screen aligned, only on the brightest few */
  float bg = smoothstep(7.0, 26.0, flux) * spikeAmt;
  if(bg > 0.002){
    float sx = dot(dl, camX)/pixAng;
    float sy = dot(dl, camY)/pixAng;
    float sp = exp(-abs(sx)*0.34 - sy*sy*2.4) + exp(-abs(sy)*0.34 - sx*sx*2.4);
    I += sp * 0.055 * bg;
  }
  return col * (flux * tw * I);
}

/* 2x2x2 neighbourhood is enough: any star within 0.25 cells of the sample
   point is guaranteed to be found, which is far beyond its visible radius. */
vec3 starLayer(vec3 d, float scale, float dens, float fluxScale, float pixAng,
               float sd, vec3 camX, vec3 camY, float twAmt, float spikeAmt){
  vec3 base = floor(d*scale - 0.5);
  vec3 acc = vec3(0.0);
  for(int i=0;i<2;i++)
  for(int k=0;k<2;k++)
  for(int m=0;m<2;m++){
    acc += starCell(base + vec3(float(i),float(k),float(m)), d, pixAng,
                    dens, fluxScale, sd, camX, camY, twAmt, spikeAmt);
  }
  return acc;
}
`;

const NEBULA_GLSL = /* glsl */ `
/* galactic band normal, and the slightly tilted dust-lane normal so the lane
   crosses the band rather than sitting exactly inside it */
const vec3 GAL_AXIS  = vec3(0.4104, 0.8208, -0.3972);
const vec3 DUST_AXIS = vec3(0.3106, 0.8926, -0.3252);

vec3 nebula(vec3 d, float seed, out float dustExt){
  float wob  = fbm3(d*1.35 + seed + 21.0, 3, 2.1, 0.55) - 0.5;
  float bb   = dot(d, GAL_AXIS) + wob*0.20;
  float band = exp(-bb*bb*13.0);

  vec3 p = d*2.1 + seed*0.37;
  vec3 w = warp3(p, 0.70, 1.25);

  float f1 = fbm3(w, 5, 2.03, 0.55);                 // broad cloud envelope
  float f2 = ridged3(w*2.4 + 5.5, 4, 2.15, 0.52);    // filaments
  float f3 = ridged3(w*6.1 + 17.0, 3, 2.30, 0.50);   // fine strands

  float env  = smoothstep(0.30, 0.76, f1);
  float mass = env * band;
  float fil  = smoothstep(0.48, 0.93, f2) * mass;
  float fine = smoothstep(0.58, 0.96, f3) * mass;

  const vec3 colA = vec3(0.07, 0.17, 0.34);   // cool blue
  const vec3 colB = vec3(0.05, 0.25, 0.27);   // teal
  const vec3 colC = vec3(0.30, 0.08, 0.26);   // magenta accent
  const vec3 colD = vec3(0.34, 0.25, 0.08);   // dull gold accent

  /* filaments carry most of the visible structure so it never reads as
     round cotton-wool blobs */
  /* Regional accents: magenta and gold are pushed into *different* patches of
     sky, otherwise they overlap everywhere and average out to mud. */
  float reg = fbm3(d*0.85 + seed + 5.0, 2, 2.0, 0.5);
  float wMag = smoothstep(0.50, 0.72, reg);
  float wGld = smoothstep(0.48, 0.26, reg);

  vec3 n = colA * mass * 0.42
         + colB * fil  * 0.85
         + colC * pow(fil, 1.3) * 0.72 * wMag
         + colD * fine * 0.75 * wGld;

  /* broad unresolved-star haze — this is what makes the band read as a galaxy */
  n += vec3(0.046,0.053,0.072) * band * (0.24 + 0.76*f1);

  /* dust lane: warm, dark, narrow, broken up by its own noise */
  float lw  = dot(d, DUST_AXIS) + (fbm3(d*2.4 + seed + 61.0, 3, 2.1, 0.55)-0.5)*0.26;
  float dn  = smoothstep(0.36, 0.76, fbm3(warp3(d*3.1 + 7.0, 0.55, 1.9), 4, 2.05, 0.55));
  float dust = clamp(exp(-lw*lw*48.0) * dn * 1.15, 0.0, 1.0);

  dustExt = exp(-dust * 2.2 * uDust);
  n *= mix(1.0, 0.30, dust * uDust);
  n += vec3(0.028,0.016,0.008) * dust * uDust;   // faint warm re-emission
  return n * 0.60;
}
`;

const VERT = /* glsl */ `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime, uSeed, uNebula, uStarBright, uDust;
varying vec3 vDir;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_COLOR}
${STAR_GLSL}
${NEBULA_GLSL}

void main(){
  vec3 d = normalize(vDir);

  /* radians per pixel, straight from the screen derivative — keeps stars the
     same crisp size at any resolution / FOV */
  float pixAng = max(length(dFdx(d)), 1e-7);

  /* world-space camera axes (rows of the view matrix) for screen-aligned spikes */
  vec3 camX = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camY = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  float ext;
  vec3 neb = nebula(d, uSeed, ext) * uNebula;
  /* hue-preserving ceiling: the sky must never bloom into a grey haze */
  neb *= 0.28 / max(max(max(neb.r, neb.g), neb.b), 0.28);

  vec3 stars = vec3(0.0);
  stars += starLayer(d, 27.0, 0.30, 0.070, pixAng, uSeed +  0.0, camX, camY, 0.10, 0.0);
  stars += starLayer(d, 15.0, 0.32, 0.185, pixAng, uSeed + 17.0, camX, camY, 0.16, 0.6);
  stars += starLayer(d,  8.5, 0.24, 0.420, pixAng, uSeed + 41.0, camX, camY, 0.20, 1.0);
  stars += starLayer(d,  4.6, 0.17, 1.050, pixAng, uSeed + 73.0, camX, camY, 0.24, 1.0);
  stars *= uStarBright * ext;

  vec3 col = vec3(0.0015,0.0021,0.0040) + neb + stars;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export function createStarfieldMaterial(opts: { seed?: number } = {}): THREE.ShaderMaterial {
  const seed = opts.seed ?? 1337;
  return new THREE.ShaderMaterial({
    name: 'starfield',
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: (seed % 997) * 0.131 },
      uNebula: { value: 1.0 },
      uStarBright: { value: 1.0 },
      uDust: { value: 1.0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    transparent: false,
    fog: false,
    toneMapped: false,
  });
}

/* ---------------------------------------------------------------------------
   Yavin — banded gas giant.  Shared here so the sky and the planet keep one
   consistent noise vocabulary.
--------------------------------------------------------------------------- */

const PLANET_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vW;
void main(){
  vLocal = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PLANET_FRAG = /* glsl */ `
precision highp float;
uniform float uTime, uSeed, uExposure;
uniform vec3 uSunDir, uSunColor;
varying vec3 vLocal;
varying vec3 vN;
varying vec3 vW;

${GLSL_HASH}
${GLSL_NOISE}
${GLSL_ROT}

void main(){
  float lat = asin(clamp(vLocal.y, -1.0, 1.0));
  float lon = atan(vLocal.z, vLocal.x);
  vec2 ring = vec2(cos(lon), sin(lon));          // seamless longitude

  /* zonal jets: each latitude band is sheared a different amount in longitude,
     which is what makes a gas giant read as *turbulent* rather than striped */
  float shear = sin(lat*5.0)*0.95 + sin(lat*11.0 + 1.3)*0.42;
  vec3 q = vec3(rot2(shear*0.42) * (ring*1.25), lat*3.0);
  vec3 wq = warp3(q + uSeed, 0.55, 1.15);

  float turb = fbm3(wq*1.6, 5, 2.05, 0.55);
  float fine = fbm3(vec3(ring*3.0, lat*26.0) + uSeed, 4, 2.2, 0.50);
  float curl = ridged3(wq*4.4 + 9.0, 3, 2.2, 0.5);

  /* narrow zonal bands, plus a slow belt/zone envelope so the disc has a
     large-scale read as well as fine striping */
  float bands = 0.5 + 0.5*sin(lat*15.0 + (turb-0.5)*3.0 + (fine-0.5)*0.9);
  bands = mix(bands, smoothstep(0.24, 0.76, bands), 0.55);
  float belt = 0.5 + 0.5*sin(lat*5.0 + 0.6);

  float tone = clamp(bands*0.50 + belt*0.26 + (turb-0.5)*0.44
                     + (curl-0.5)*0.16 + 0.15, 0.0, 1.0);

  vec3 alb = mix(vec3(0.185,0.092,0.046), vec3(0.60,0.33,0.125), smoothstep(0.00,0.40,tone));
  alb = mix(alb, vec3(0.82,0.59,0.30), smoothstep(0.36,0.66,tone));
  alb = mix(alb, vec3(0.93,0.85,0.66), smoothstep(0.68,0.95,tone));
  /* thin pale ammonia wisps riding the shear */
  alb = mix(alb, vec3(0.96,0.92,0.80), smoothstep(0.82,0.99,fine)*0.30);

  /* ---- great red spot: domain-warped vortex around one point ---- */
  float dlon = lon - 1.15;
  dlon = atan(sin(dlon), cos(dlon));
  vec2 sp = vec2(dlon*cos(lat), (lat + 0.34)*2.15);
  float sr = length(sp)/0.40;
  float swirl = 1.0 - clamp(sr, 0.0, 1.0);
  sp = rot2(swirl*swirl*4.4 + uTime*0.015) * sp;
  float sn = fbm3(vec3(sp*4.5, 3.7) + uSeed, 4, 2.1, 0.55);
  vec3 spotCol = mix(vec3(0.60,0.20,0.10), vec3(0.90,0.55,0.30), smoothstep(0.32,0.76,sn));
  alb = mix(alb, spotCol, smoothstep(1.02,0.42,sr) * (0.55 + 0.45*sn));
  /* cream collar dragged around the vortex */
  alb = mix(alb, vec3(0.93,0.85,0.66),
            smoothstep(0.88,1.02,sr) * smoothstep(1.22,1.02,sr) * (0.30 + 0.35*sn));

  /* ---- lighting ---- */
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, uSunDir);
  float vdn = clamp(dot(N, V), 0.0, 1.0);

  /* a real lambert terminator: narrow softening, then a proper cosine falloff */
  float lam = smoothstep(-0.07, 0.20, ndl) * pow(clamp(ndl, 0.0, 1.0), 0.65);

  float limb = pow(vdn, 0.55);                     // limb darkening
  vec3 lit = alb * lam * limb * uSunColor * uExposure;
  lit = mix(lit, lit*vec3(1.22,0.85,0.55), (1.0-vdn)*0.75);   // warm toward the limb

  /* bright forward-scattered rim on the lit limb — also softens the silhouette */
  float rim = pow(1.0 - vdn, 2.6) * smoothstep(-0.02, 0.38, ndl);
  lit += uSunColor * vec3(1.00,0.80,0.55) * rim * 0.45 * uExposure;

  /* thin hazy atmosphere hugging the lit limb */
  float atmo = pow(1.0 - vdn, 4.5) * smoothstep(-0.26, 0.50, ndl);
  lit += vec3(0.95,0.83,0.64) * atmo * 0.34 * uExposure;

  /* warm twilight scattering right along the terminator */
  float twi = exp(-pow(ndl * 7.0, 2.0)) * (1.0 - vdn * 0.45);
  lit += vec3(0.55, 0.28, 0.13) * twi * 0.055 * uExposure;

  lit += alb * 0.008;                              // night side isn't pure black

  gl_FragColor = vec4(max(lit, 0.0), 1.0);
}
`;

export function createGasGiantMaterial(opts: { seed?: number } = {}): THREE.ShaderMaterial {
  const seed = opts.seed ?? 1337;
  return new THREE.ShaderMaterial({
    name: 'yavin',
    uniforms: {
      uTime: { value: 0 },
      uSeed: { value: (seed % 613) * 0.077 },
      uExposure: { value: 0.62 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.42, 0.72).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.86) },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
    side: THREE.FrontSide,
    depthWrite: false,
    depthTest: false,
    transparent: false,
    fog: false,
    toneMapped: false,
  });
}
