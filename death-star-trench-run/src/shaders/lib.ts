/**
 * Shared GLSL chunks. Import and string-concat into shader sources.
 * Every function is prefixed to avoid collisions with three.js built-ins.
 */

export const GLSL_HASH = /* glsl */ `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3 = fract(p3*0.1031); p3 += dot(p3, p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3  hash33(vec3 p3){ p3 = fract(p3*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
`;

/** Gradient (Perlin-ish) value noise + FBM. Requires GLSL_HASH. */
export const GLSL_NOISE = /* glsl */ `
float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i+vec2(0,0)), hash12(i+vec2(1,0)), u.x),
             mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash13(i+vec3(0,0,0)), hash13(i+vec3(1,0,0)), u.x),
                 mix(hash13(i+vec3(0,1,0)), hash13(i+vec3(1,1,0)), u.x), u.y),
             mix(mix(hash13(i+vec3(0,0,1)), hash13(i+vec3(1,0,1)), u.x),
                 mix(hash13(i+vec3(0,1,1)), hash13(i+vec3(1,1,1)), u.x), u.y), u.z);
}
float snoise3(vec3 p){ return vnoise3(p)*2.0-1.0; }

float fbm3(vec3 p, int oct, float lac, float gain){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    s += a*vnoise3(p); n += a; p *= lac; a *= gain;
  }
  return s/max(n,1e-4);
}
float fbm2(vec2 p, int oct, float lac, float gain){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    s += a*vnoise2(p); n += a; p *= lac; a *= gain;
  }
  return s/max(n,1e-4);
}
/** ridged multifractal — good for fire filaments & nebula strands */
float ridged3(vec3 p, int oct, float lac, float gain){
  float a = 0.5, s = 0.0, n = 0.0;
  for(int i=0;i<8;i++){
    if(i>=oct) break;
    float v = 1.0 - abs(snoise3(p));
    v *= v;
    s += a*v; n += a; p *= lac; a *= gain;
  }
  return s/max(n,1e-4);
}
/** curl-ish domain warp */
vec3 warp3(vec3 p, float amt, float freq){
  return p + amt*vec3(
    vnoise3(p*freq + vec3(11.3, 4.1, 7.7)),
    vnoise3(p*freq + vec3(3.9, 19.2, 1.4)),
    vnoise3(p*freq + vec3(23.1, 8.8, 15.5))) * 2.0 - amt;
}
float worley3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  float d = 1.0;
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g = vec3(float(x),float(y),float(z));
    vec3 o = hash33(i+g);
    d = min(d, length(g+o-f));
  }
  return d;
}
`;

/** Colour helpers: black-body ramp for fire, and a compact tonemap-friendly ramp. */
export const GLSL_COLOR = /* glsl */ `
// t: 0 = cold smoke, 1 = white-hot core
vec3 blackbody(float t){
  t = clamp(t, 0.0, 1.0);
  vec3 c;
  c  = vec3(0.06,0.02,0.015) * smoothstep(0.0,0.22,t);
  c += vec3(0.85,0.16,0.02)  * smoothstep(0.10,0.45,t);
  c += vec3(1.10,0.55,0.06)  * smoothstep(0.34,0.70,t);
  c += vec3(1.20,1.02,0.42)  * smoothstep(0.58,0.90,t);
  c += vec3(1.30,1.30,1.30)  * smoothstep(0.84,1.00,t);
  return c;
}
vec3 plasmaRamp(float t, vec3 core, vec3 mid, vec3 outer){
  t = clamp(t,0.0,1.0);
  return mix(outer, mix(mid, core, smoothstep(0.45,1.0,t)), smoothstep(0.0,0.6,t));
}
float luma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }
`;

export const GLSL_ROT = /* glsl */ `
mat2 rot2(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }
mat3 rotAxis(vec3 ax, float a){
  float s=sin(a), c=cos(a), t=1.0-c;
  return mat3(t*ax.x*ax.x+c, t*ax.x*ax.y-s*ax.z, t*ax.x*ax.z+s*ax.y,
              t*ax.x*ax.y+s*ax.z, t*ax.y*ax.y+c, t*ax.y*ax.z-s*ax.x,
              t*ax.x*ax.z-s*ax.y, t*ax.y*ax.z+s*ax.x, t*ax.z*ax.z+c);
}
`;

/** Utility SDF-ish helpers used by panel / greeble shaders. */
export const GLSL_PANEL = /* glsl */ `
// returns vec3(cellId.xy hashed, distance-to-nearest-edge)
vec3 panelCell(vec2 uv, float scale, float jitter){
  vec2 p = uv*scale;
  vec2 id = floor(p);
  vec2 f = fract(p);
  float h = hash12(id);
  // subdivide some cells for variety
  if(h > 0.62){ p *= 2.0; id = floor(p); f = fract(p); h = hash12(id*1.7+3.1); }
  vec2 e = min(f, 1.0-f);
  float d = min(e.x, e.y);
  return vec3(h, hash12(id+7.3), d);
}
float grid(vec2 uv, float scale, float w){
  vec2 g = abs(fract(uv*scale)-0.5);
  float d = min(g.x,g.y);
  return 1.0 - smoothstep(w, w+fwidth(d)*1.5, d);
}
`;

/** Combined "everything" prelude for heavy VFX shaders. */
export const GLSL_PRELUDE = GLSL_HASH + GLSL_NOISE + GLSL_COLOR + GLSL_ROT;
