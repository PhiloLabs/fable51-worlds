import * as THREE from 'three';
import { GLSL_HASH, GLSL_NOISE } from '../shaders/lib';

/**
 * Shared hull material for every piece of Imperial hardware.
 *
 * Reads two custom vertex attributes produced by greebleKit:
 *   aEmis  0..1  — emissive mask (lit windows, vents, warning strips)
 *   aMat   0..3  — 0 painted plate · 1 exposed metal · 2 pipe/strut · 3 emissive fixture
 *
 * Adds procedural panel lines, grime, roughness break-up and per-window
 * flicker on top of MeshStandardMaterial so we keep real PBR lighting.
 */
export interface HullOptions {
  color?: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  emissiveStrength?: number;
  panelScale?: number;
  roughness?: number;
  metalness?: number;
  grime?: number;
  windowDensity?: number;
}

export function createHullMaterial(opts: HullOptions = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(opts.color ?? 0x8d949b),
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.62,
    // MUST be black: three seeds `totalEmissiveRadiance = emissive`, so any
    // non-zero value here lights every pixel of the mesh, not just the masked
    // window/vent areas the injected code adds to.
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
  });
  const uniforms = {
    uPanel: { value: opts.panelScale ?? 0.35 },
    uGrime: { value: opts.grime ?? 0.55 },
    uEmisCol: { value: new THREE.Color(opts.emissive ?? 0xffb45a) },
    uEmisStr: { value: opts.emissiveStrength ?? 3.0 },
    uWindow: { value: opts.windowDensity ?? 0.55 },
    uTime: { value: 0 },
    uDamage: { value: 0 },      // 0..1 — global "station is dying" heat glow
  };
  (mat as any).userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aEmis;
        attribute float aMat;
        varying float vEmis;
        varying float vMat;
        varying vec3 vWorldPos;
        varying vec3 vObjPos;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vEmis = aEmis;
        vMat = aMat;
        vObjPos = position;
      `)
      .replace('#include <project_vertex>', /* glsl */`
        #include <project_vertex>
        vec4 hmWp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          hmWp = instanceMatrix * hmWp;
        #endif
        vWorldPos = (modelMatrix * hmWp).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        varying float vEmis;
        varying float vMat;
        varying vec3 vWorldPos;
        varying vec3 vObjPos;
        uniform float uPanel, uGrime, uEmisStr, uWindow, uTime, uDamage;
        uniform vec3 uEmisCol;
        ${GLSL_HASH}
        ${GLSL_NOISE}
        // triplanar panel-line field in world space
        float panelLines(vec3 p, vec3 n, float scale){
          vec3 a = abs(n);
          a /= (a.x+a.y+a.z);
          vec2 uvx = p.zy*scale, uvy = p.xz*scale, uvz = p.xy*scale;
          float d = 0.0;
          vec2 gx = abs(fract(uvx)-0.5), gy = abs(fract(uvy)-0.5), gz = abs(fract(uvz)-0.5);
          d += a.x * (1.0-smoothstep(0.0,0.045,min(gx.x,gx.y)));
          d += a.y * (1.0-smoothstep(0.0,0.045,min(gy.x,gy.y)));
          d += a.z * (1.0-smoothstep(0.0,0.045,min(gz.x,gz.y)));
          return d;
        }
      `)
      .replace('#include <color_fragment>', /* glsl */`
        #include <color_fragment>
        {
          vec3 wp = vWorldPos;
          vec3 nn = normalize(vNormal);
          // large-scale plate tint
          float plate = vnoise3(wp*0.035);
          float plate2 = vnoise3(wp*0.011);
          float tint = 0.82 + 0.34*plate + 0.16*plate2;
          // material class tinting
          vec3 base = diffuseColor.rgb;
          if(vMat > 2.5)      base = mix(base, vec3(0.30,0.33,0.36), 0.6);
          else if(vMat > 1.5) base = mix(base, vec3(0.44,0.45,0.48), 0.55);
          else if(vMat > 0.5) base = mix(base, vec3(0.60,0.61,0.63), 0.45);
          base *= tint;
          // panel lines
          float pl = panelLines(wp, nn, uPanel);
          base *= (1.0 - 0.55*pl);
          // grime streaks
          float streak = fbm3(wp*vec3(0.02,0.10,0.02), 4, 2.2, 0.55);
          base *= mix(1.0, 0.62 + 0.5*streak, uGrime);
          diffuseColor.rgb = base;
        }
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        {
          float rv = vnoise3(vWorldPos*0.28);
          float rv2 = vnoise3(vWorldPos*1.7);
          roughnessFactor = clamp(roughnessFactor * (0.72 + 0.55*rv) + 0.10*(rv2-0.5), 0.14, 1.0);
        }
      `)
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        {
          float m = vEmis;
          if(m > 0.001){
            // break the emissive strip into individual lit windows
            vec3 wp = vWorldPos;
            float cells = hash13(floor(wp*0.55));
            float lit = step(1.0-uWindow, cells);
            float flick = 0.86 + 0.14*sin(uTime*(2.0+cells*9.0) + cells*40.0);
            vec3 c = uEmisCol;
            // some panels run cool-white / blue
            if(cells > 0.72) c = mix(c, vec3(0.62,0.82,1.0), 0.85);
            totalEmissiveRadiance += c * (m * lit * flick * uEmisStr);
          }
          // dying-station heat glow bleeding through the seams
          if(uDamage > 0.001){
            float crack = fbm3(vWorldPos*0.006 + vec3(0.0,uTime*0.05,0.0), 4, 2.3, 0.55);
            float hot = smoothstep(0.62 - uDamage*0.45, 0.78, crack) * uDamage;
            totalEmissiveRadiance += vec3(3.0,0.75,0.12) * hot * 3.5;
          }
        }
      `);
  };
  mat.customProgramCacheKey = () => 'hull-v3';
  return mat;
}

/** Advance time / damage on any number of hull materials at once. */
export function updateHullMaterials(mats: THREE.Material[], time: number, damage = 0) {
  for (const m of mats) {
    const u = (m as any).userData?.uniforms;
    if (u) { u.uTime.value = time; u.uDamage.value = damage; }
  }
}
