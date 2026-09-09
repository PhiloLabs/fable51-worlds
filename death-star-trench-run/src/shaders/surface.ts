import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE } from './lib';

/* =========================================================================
   DEATH STAR SURFACE MATERIAL
   MeshStandardMaterial + onBeforeCompile so we keep real PBR lighting from
   the integrator's key DirectionalLight, but every texel of albedo,
   roughness, normal and emissive is procedural.

   Reads (all optional, supplied by deathstar.ts):
     aRegion  float  — macro structural region id (0..1) for big tonal zones
     aEmis    float  — emissive mask (strip lights, window banks)
     aMat     float  — 0 plate · 1 metal · 2 pipe · 3 emissive fixture

   Uniforms: uTime, uDamage, uCamPos, uSeed (+ tuning knobs).
   ========================================================================= */

export interface SurfaceOptions {
  seed?: number;
  color?: THREE.ColorRepresentation;
  /** metres — used to normalise the procedural frequencies */
  radius?: number;
  windowStrength?: number;
  /** multiplies every detail frequency; trench/dish sub-parts use >1 */
  detailScale?: number;
  roughness?: number;
  metalness?: number;
  /** colour of `aEmis`-tagged fixtures (dish core uses a green) */
  emissiveTint?: THREE.ColorRepresentation;
  /** strength of `aEmis`-tagged fixtures */
  emissiveStrength?: number;
  /** InstancedMesh greebles: [fadeStart, fadeEnd] metres from uCamPos. */
  instanceFade?: [number, number];
  /**
   * How the procedural plating is projected:
   *  'cube'  — sphere cube projection (the shell, the dish bowl)
   *  'local' — triplanar on object-local position (greebles, structures)
   *  'uv'    — the geometry's own uv (swept rings)
   */
  projection?: 'cube' | 'local' | 'uv';
}

/** Cube-projection + multi-scale panel field. Shared by every surface piece. */
const GLSL_SURFACE_LIB = /* glsl */ `
// Direction -> (face index, face uv in [-1,1]).  Stable, pole-free.
vec3 cubeUV(vec3 d){
  vec3 a = abs(d);
  if(a.x >= a.y && a.x >= a.z){
    return vec3(d.z / a.x, d.y / a.x, d.x > 0.0 ? 0.0 : 1.0);
  } else if(a.y >= a.z){
    return vec3(d.x / a.y, d.z / a.y, d.y > 0.0 ? 2.0 : 3.0);
  }
  return vec3(d.x / a.z, d.y / a.z, d.z > 0.0 ? 4.0 : 5.0);
}

// One level of jittered rectangular plating.
// returns: x = plate tone (0..1), y = edge mask (1 at the seam), z = plate id
vec3 plateLevel(vec2 uv, float seed, float lineW){
  vec2 id = floor(uv);
  vec2 f = fract(uv);
  float h = hash12(id + seed);
  // split some cells into halves so plates are not a uniform checker
  float split = hash12(id * 1.31 + seed + 5.7);
  if(split > 0.66){
    if(split > 0.83){ f.x = fract(f.x * 2.0); id.x += 77.0 * floor(fract(uv.x) * 2.0); }
    else            { f.y = fract(f.y * 2.0); id.y += 51.0 * floor(fract(uv.y) * 2.0); }
    h = hash12(id * 2.17 + seed + 1.9);
  }
  vec2 e = min(f, 1.0 - f);
  float d = min(e.x, e.y);
  float aa = max(fwidth(d), 1e-5);
  float edge = 1.0 - smoothstep(lineW, lineW + aa * 1.4, d);
  return vec3(h, edge, hash12(id * 3.71 + seed));
}

// Level of detail fade: 1 when a cell of this scale is comfortably bigger
// than a pixel, 0 once it aliases away.  Kills shimmer at long range.
float lodFade(vec2 uv){
  float w = max(length(fwidth(uv)), 1e-6);
  return 1.0 - smoothstep(0.09, 0.40, w);
}
`;

export function createSurfaceMaterial(opts: SurfaceOptions = {}): THREE.MeshStandardMaterial {
  const seed = opts.seed ?? 7;
  const radius = opts.radius ?? 50000;

  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color ?? 0xb2bac1),
    roughness: opts.roughness ?? 0.78,
    metalness: opts.metalness ?? 0.14,
    // NOTE: must stay black — `totalEmissiveRadiance` is seeded from it, and
    // everything this shader glows with is added on top.
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
  });

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uDamage: { value: 0 },
    uCamPos: { value: new THREE.Vector3() },
    uSeed: { value: seed },
    uRadius: { value: radius },
    uDetail: { value: opts.detailScale ?? 1 },
    uWindow: { value: opts.windowStrength ?? 1 },
    uNightFloor: { value: 0.06 },
    uEmisTint: { value: new THREE.Color(opts.emissiveTint ?? 0xffb768) },
    uEmisStr: { value: opts.emissiveStrength ?? 1.0 },
    uFade: { value: new THREE.Vector2(opts.instanceFade?.[0] ?? 0, opts.instanceFade?.[1] ?? 0) },
  };
  (mat as any).userData.uniforms = uniforms;
  const proj = opts.projection ?? 'cube';
  if (proj === 'local') mat.defines = { ...(mat.defines || {}), DS_LOCAL_UV: '' };
  if (proj === 'uv') mat.defines = { ...(mat.defines || {}), DS_MESH_UV: '' };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aRegion;
        attribute float aEmis;
        attribute float aMat;
        varying float vRegion;
        varying float vEmis;
        varying float vMat;
        varying vec3 vWPos;
        varying vec3 vOPos;
        varying vec2 vDsUv;
        varying vec3 vDsN;
        uniform vec2 uFade;
        uniform vec3 uCamPos;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vRegion = aRegion;
        vEmis = aEmis;
        vMat = aMat;
        #ifdef USE_INSTANCING
        if(uFade.y > 0.0){
          // distance-based scale ramp: a streamed greeble grows out of the
          // hull instead of popping in when its cell enters range.
          vec3 io = (modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
          float dd = length(io - uCamPos);
          float sFade = 1.0 - smoothstep(uFade.x, uFade.y, dd);
          sFade = sFade * sFade * (3.0 - 2.0 * sFade);
          transformed *= sFade;
        }
        #endif
        vOPos = position;
        vDsUv = uv;
        vDsN = objectNormal;
      `)
      .replace('#include <project_vertex>', /* glsl */`
        #include <project_vertex>
        {
          vec4 dsWp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            dsWp = instanceMatrix * dsWp;
          #endif
          vWPos = (modelMatrix * dsWp).xyz;
        }
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying float vRegion;
        varying float vEmis;
        varying float vMat;
        varying vec3 vWPos;
        varying vec3 vOPos;
        varying vec2 vDsUv;
        varying vec3 vDsN;
        uniform float uTime, uDamage, uSeed, uRadius, uDetail, uWindow, uNightFloor, uEmisStr;
        uniform vec3 uCamPos, uEmisTint;
        ${GLSL_HASH}
        ${GLSL_NOISE}
        ${GLSL_SURFACE_LIB}

        // Which 2D space the plating lives in, for this material.
        vec2 dsPanelUV(vec3 nrm){
        #if defined( DS_LOCAL_UV )
          vec3 a = abs(nrm); a /= max(a.x + a.y + a.z, 1e-4);
          vec3 lp = vOPos * (1.0 / 24.0) * uDetail;
          vec2 uvp = (a.y >= a.x && a.y >= a.z) ? lp.xz : ((a.x >= a.z) ? lp.zy : lp.xy);
          return uvp;
        #elif defined( DS_MESH_UV )
          return vDsUv * uDetail;
        #else
          vec3 cu = cubeUV(normalize(vOPos));
          // each structural region gets its own plate module, so neighbouring
          // sectors of the hull are visibly built to different standards
          float ps = mix(0.55, 2.10, vRegion);
          return cu.xy * 9.0 * ps * uDetail + vec2(cu.z * 17.0, cu.z * 31.0);
        #endif
        }

        // Bump height field, in metres, evaluated in world space.
        // Everything the normal perturbation and the albedo agree on lives here.
        float dsHeight(vec3 wp, vec2 puv, float dsc){
          // metres of surface per pixel — every term below is faded out once it
          // would be finer than a pixel, otherwise the perturbed normal turns
          // into per-pixel noise and the whole hull sparkles.
          float mpp = max(length(fwidth(wp)), 1e-3);
          float h = 0.0;
          // continental plating swells
          h += 26.0 * fbm3(wp * (0.9 / uRadius) * 6.0 + uSeed, 4, 2.1, 0.55)
               * (1.0 - smoothstep(300.0, 1400.0, mpp));
          // mid machinery relief
          h += 17.0 * fbm3(wp * (0.9 / uRadius) * 42.0 + uSeed * 3.1, 3, 2.3, 0.5)
               * (1.0 - smoothstep(60.0, 300.0, mpp));
          // meso relief: ~280 m ridges and pits, the scale you read at 1-20 km
          h += 5.0 * fbm3(wp * (0.9 / uRadius) * 190.0 + uSeed * 5.3, 3, 2.2, 0.5)
               * (1.0 - smoothstep(14.0, 70.0, mpp));
          // plate steps: each plate sits a few metres proud of its neighbours
          vec3 p1 = plateLevel(puv * 1.0, uSeed, 0.012);
          vec3 p2 = plateLevel(puv * 4.0, uSeed + 11.0, 0.016);
          vec3 p3 = plateLevel(puv * 16.0, uSeed + 23.0, 0.022);
          vec3 p4 = plateLevel(puv * 64.0, uSeed + 41.0, 0.026);
          h += (p1.x - 0.5) * 9.0 * lodFade(puv * 1.0);
          h += (p2.x - 0.5) * 3.4 * lodFade(puv * 4.0);
          h += (p3.x - 0.5) * 1.1 * lodFade(puv * 16.0);
          // seams cut down
          h -= p1.y * 6.0 * lodFade(puv * 1.0);
          h -= p2.y * 2.2 * lodFade(puv * 4.0);
          h -= p3.y * 0.8 * lodFade(puv * 16.0);
          h += (p4.x - 0.5) * 0.55 * lodFade(puv * 64.0);
          h -= p4.y * 0.45 * lodFade(puv * 64.0);
          // fine grain so raking light always has something to catch
          h += 2.2 * (worley3(wp * (0.9 / uRadius) * 900.0 * dsc) - 0.5)
               * (1.0 - smoothstep(4.0, 22.0, mpp));
          return h;
        }
      `)
      // ---------------------------------------------------------------- albedo
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          vec3 wp = vWPos;
          vec3 dir = normalize(vWPos);
          vec2 puv = dsPanelUV(normalize(vDsN));

          vec3 base = diffuseColor.rgb;

          // --- macro structural regions: broad tonal zones -------------------
          float regTone = 0.88 + 0.22 * vRegion;
          float cont = fbm3(dir * 2.3 + uSeed * 0.7, 4, 2.15, 0.55);
          float cont2 = fbm3(dir * 6.1 + uSeed * 1.9, 3, 2.4, 0.5);
          base *= regTone * (0.74 + 0.36 * cont + 0.14 * cont2);

          // --- latitudinal mechanical bands ---------------------------------
          float lat = dir.y;
          float bandF = sin(lat * 46.0 + fbm3(dir * 3.0, 3, 2.0, 0.5) * 4.0);
          float band = smoothstep(0.86, 0.995, abs(bandF));
          base *= mix(1.0, 0.66, band * 0.8);
          // a handful of heavy structural rings
          float ring = smoothstep(0.985, 1.0, abs(sin(lat * 9.0 + 0.6)));
          base *= mix(1.0, 0.55, ring);

          // --- multi-scale panel tessellation -------------------------------
          vec3 L0 = plateLevel(puv * 1.0, uSeed, 0.010);
          vec3 L1 = plateLevel(puv * 4.0, uSeed + 11.0, 0.014);
          vec3 L2 = plateLevel(puv * 16.0, uSeed + 23.0, 0.018);
          vec3 L3 = plateLevel(puv * 64.0, uSeed + 41.0, 0.024);
          vec3 L4 = plateLevel(puv * 256.0, uSeed + 67.0, 0.030);
          float f0 = lodFade(puv * 1.0), f1 = lodFade(puv * 4.0);
          float f2 = lodFade(puv * 16.0), f3 = lodFade(puv * 64.0);
          float f4 = lodFade(puv * 256.0);

          float tone = 1.0;
          tone *= mix(1.0, 0.78 + 0.36 * L0.x, f0);
          tone *= mix(1.0, 0.84 + 0.26 * L1.x, f1);
          tone *= mix(1.0, 0.89 + 0.19 * L2.x, f2);
          tone *= mix(1.0, 0.92 + 0.14 * L3.x, f3);
          tone *= mix(1.0, 0.94 + 0.11 * L4.x, f4);
          base *= tone;

          float seam = max(max(max(L0.y * f0 * 1.0, L1.y * f1 * 0.85),
                               max(L2.y * f2 * 0.7, L3.y * f3 * 0.55)),
                           L4.y * f4 * 0.45);
          base *= (1.0 - 0.62 * seam);

          // --- long thin grooves cut across the plating ---------------------
          vec2 sc = puv * 0.111;
          float scr = smoothstep(0.962, 1.0, abs(sin(sc.y * 96.0 + fbm2(sc * 5.0, 3, 2.0, 0.5) * 9.0)));
          scr *= step(0.55, hash12(floor(sc * vec2(6.0, 1.0))));
          base *= mix(1.0, 0.42, scr * f1 * lodFade(puv * 8.0));

          // --- material class + grime ---------------------------------------
          if(vMat > 2.5)      base = mix(base, vec3(0.30,0.33,0.36), 0.55);
          else if(vMat > 1.5) base = mix(base, vec3(0.42,0.44,0.47), 0.5);
          else if(vMat > 0.5) base = mix(base, vec3(0.58,0.60,0.63), 0.4);

          float grime = fbm3(wp * vec3(0.000085, 0.00013, 0.000085) * uDetail, 4, 2.2, 0.55);
          base *= mix(0.87, 1.05, grime);

          // faint warm/cool duotone so the plating is not flat grey
          base *= mix(vec3(0.97,0.98,1.03), vec3(1.05,1.00,0.93), cont);

          diffuseColor.rgb = clamp(base, vec3(0.0), vec3(0.88));
        }
      `)
      // ------------------------------------------------------- normal + rough
      .replace('#include <normal_fragment_begin>', /* glsl */`
        #include <normal_fragment_begin>
        {
          vec2 puv = dsPanelUV(normalize(vDsN));
          float dsc = uDetail;
          float h = dsHeight(vWPos, puv, dsc);
          vec3 vp = -vViewPosition;
          vec3 dpdx = dFdx(vp), dpdy = dFdy(vp);
          float dhdx = dFdx(h), dhdy = dFdy(h);
          vec3 r1 = cross(dpdy, normal);
          vec3 r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          if(abs(det) > 1e-12){
            vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
            normal = normalize(abs(det) * normal - grad);
          }
        }
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          vec2 puv = dsPanelUV(normalize(vDsN));
          vec3 R0 = plateLevel(puv * 4.0, uSeed + 11.0, 0.014);
          vec3 R1 = plateLevel(puv * 16.0, uSeed + 23.0, 0.018);
          float rv = fbm3(vWPos * (1.0/uRadius) * 60.0 + uSeed, 3, 2.2, 0.55);
          roughnessFactor = clamp(
            roughnessFactor
            * (0.80 + 0.36 * rv)
            + 0.16 * (R0.z - 0.5) * lodFade(puv * 4.0)
            + 0.10 * (R1.z - 0.5) * lodFade(puv * 16.0),
            0.16, 1.0);
          if(vMat > 0.5 && vMat < 2.5) roughnessFactor *= 0.72;
        }
      `)
      // ------------------------------------------------- windows / night side
      .replace('#include <lights_fragment_end>', /* glsl */`
        #include <lights_fragment_end>
        {
          vec2 puv = dsPanelUV(normalize(vDsN));

          // How lit is this fragment by the key light?  Divide the reflected
          // diffuse back out by the albedo so this is (N.L * lightIntensity)
          // and does not depend on how dark this particular plate happens to
          // be — otherwise dim plating reads as "night" in full sunlight.
          float dcl = max(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
          float sunlit = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722)) / (dcl * 0.3183);
          float night = 1.0 - smoothstep(0.02, 0.24, sunlit);

          // ---- window banks: a dense grid of tiny lit cells -----------------
          vec2 wuv = puv * 210.0;
          vec2 wid = floor(wuv);
          vec2 wf = fract(wuv);
          float wr = hash12(wid + uSeed * 2.0);
          // clustered: windows only live on some plates, in some bands
          vec3 P = plateLevel(puv * 16.0, uSeed + 23.0, 0.018);
          // each hash dissolves into its own mean as it shrinks past a pixel,
          // so the window field becomes a smooth glow instead of noise
          float aF = min(lodFade(wuv / 7.0), lodFade(puv * 16.0));
          float allow = mix(0.42, step(0.44, P.z) * step(0.30, hash12(floor(wuv / 7.0) + uSeed)), aF);
          float shape = step(0.18, wf.x) * step(wf.x, 0.62) * step(0.30, wf.y) * step(wf.y, 0.70);
          float lit = step(0.62, wr) * allow * shape;
          float wfade = lodFade(wuv * 0.35);
          // Everything driven by the per-window hash — the flicker and the
          // warm/cool tint as well as the on/off — has to dissolve into its
          // mean at range, or the night side turns into coloured confetti.
          float flick = mix(0.90, 0.80 + 0.20 * sin(uTime * (1.3 + wr * 5.0) + wr * 60.0), wfade);
          vec3 wcol = mix(vec3(0.88, 0.79, 0.63),
                          mix(vec3(1.00, 0.80, 0.46), vec3(0.55, 0.78, 1.00), step(0.74, wr)), wfade);
          float wcell = mix(0.055 * allow, lit, wfade);
          float wamp = uWindow * wcell * flick * (0.05 + 1.95 * night);
          totalEmissiveRadiance += wcol * wamp * 0.95;

          // ---- larger strip / hangar glows (survive at long range) ---------
          float sF = lodFade(puv * 4.0);
          float strip = mix(0.10, step(0.90, hash12(floor(puv * 4.0) + uSeed * 5.0)), sF);
          float sband = mix(0.10, smoothstep(0.42, 0.5, abs(fract(puv.y * 4.0) - 0.5)), sF);
          totalEmissiveRadiance += vec3(0.95, 0.72, 0.40) * strip * sband * night * 0.45 * uWindow;

          // ---- tagged emissive geometry (strip lights, dish core) ----------
          if(vEmis > 0.001){
            float cells = hash13(floor(vWPos * 0.08));
            float f2 = 0.85 + 0.15 * sin(uTime * (2.0 + cells * 8.0) + cells * 40.0);
            vec3 c = mix(uEmisTint, mix(uEmisTint, vec3(0.66, 0.82, 1.0), 0.8), step(0.72, cells));
            totalEmissiveRadiance += c * vEmis * f2 * uEmisStr;
          }

          // ---- night side is never pure black: self-illumination bounce ----
          totalEmissiveRadiance += diffuseColor.rgb * uNightFloor * night;
          // and a soft, clustered city haze that survives any distance
          float haze = fbm3(normalize(vWPos) * 11.0 + uSeed, 2, 2.3, 0.5);
          haze = smoothstep(0.46, 0.92, haze);
          totalEmissiveRadiance += vec3(0.82, 0.80, 0.78) * haze * night * 0.030 * uWindow;

          // ---- damage: cracks that spread and brighten ---------------------
          if(uDamage > 0.0005){
            float mppD = max(length(fwidth(vWPos)), 1e-3);
            // ridged noise gives filaments, not blobs — these read as fissures
            float veins = ridged3(vWPos * (1.0 / uRadius) * 18.0 + uSeed, 4, 2.2, 0.55);
            float fine = ridged3(vWPos * (1.0 / uRadius) * 78.0 + uSeed * 2.0, 3, 2.3, 0.5)
                         * (1.0 - smoothstep(80.0, 400.0, mppD));
            float mask = fbm3(vWPos * (1.0 / uRadius) * 3.4 + uTime * 0.02, 3, 2.2, 0.5);
            float spread = smoothstep(0.70 - uDamage * 0.85, 0.94 - uDamage * 0.55, mask);
            float c = smoothstep(0.62, 0.97, veins) + 0.55 * smoothstep(0.70, 1.0, fine);
            float hot = c * spread * uDamage;
            vec3 hotCol = mix(vec3(2.4, 0.55, 0.06), vec3(4.0, 2.6, 1.2), uDamage * uDamage);
            totalEmissiveRadiance += hotCol * hot * (0.8 + 4.0 * uDamage);
            // scorch the plating around the fissures
            diffuseColor.rgb *= (1.0 - 0.72 * clamp(spread * uDamage, 0.0, 1.0));
          }
        }
      `);
  };

  mat.customProgramCacheKey = () => 'ds-surface-v4-' + proj;
  return mat;
}

/** Set a uniform on a material built by `createSurfaceMaterial` (or any hull material). */
export function setSurfaceUniform(mat: THREE.Material, name: string, value: any): void {
  const u = (mat as any)?.userData?.uniforms;
  if (!u) return;
  const slot = u[name];
  if (!slot) return;
  if (slot.value && typeof slot.value === 'object' && typeof (slot.value as any).copy === 'function'
      && value && typeof value === 'object') {
    (slot.value as any).copy(value);
  } else {
    slot.value = value;
  }
}
