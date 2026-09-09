import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Final grade: radial speed blur -> chromatic aberration -> lift/gamma/gain grade
 * -> vignette -> grain -> flash.  Runs in HDR linear space, before OutputPass
 * applies ACES tone mapping + sRGB.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAspect: { value: 1.777 },
    uSpeedBlur: { value: 0.0 },     // 0..1 radial blur amount
    uBlurCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uCA: { value: 0.00042 },          // chromatic aberration
    uVignette: { value: 0.72 },
    uGrain: { value: 0.016 },
    uFlash: { value: 0.0 },          // additive white flash (HDR)
    uFlashColor: { value: new THREE.Color(1, 0.92, 0.78) },
    uLift: { value: new THREE.Vector3(0.004, 0.008, 0.020) },
    uGain: { value: new THREE.Vector3(1.02, 1.00, 1.03) },
    uSaturation: { value: 1.06 },
    uDesat: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uSpeedBlur, uCA, uVignette, uGrain, uFlash, uSaturation, uDesat;
    uniform vec2 uBlurCenter;
    uniform vec3 uLift, uGain, uFlashColor;
    varying vec2 vUv;

    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

    void main(){
      vec2 uv = vUv;
      vec2 d = uv - uBlurCenter;
      float r2 = dot(d,d);
      float ca = uCA * (0.25 + r2*2.2);
      vec3 col;

      if(uSpeedBlur > 0.001){
        // chromatic radial blur: each channel walks a slightly different scale,
        // so the smear and the dispersion come from the same samples
        float j = h12(uv*vec2(1024.0,768.0) + uTime) * 0.1;
        float disp = 1.0 + uSpeedBlur*0.9;
        vec3 acc = vec3(0.0); float wsum = 0.0;
        for(int i=0;i<10;i++){
          float t = (float(i)+j)/10.0;
          float w = 1.0 - t*0.55;
          float s = 1.0 - uSpeedBlur*0.13*t;
          float e = ca*disp*1.6;
          acc.r += texture2D(tDiffuse, uBlurCenter + d*(s*(1.0+e))).r * w;
          acc.g += texture2D(tDiffuse, uBlurCenter + d*s).g * w;
          acc.b += texture2D(tDiffuse, uBlurCenter + d*(s*(1.0-e))).b * w;
          wsum += w;
        }
        col = acc/wsum;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
        if(ca > 0.00002){
          vec2 off = d * ca * 2.2;
          col.r = texture2D(tDiffuse, uv + off).r;
          col.b = texture2D(tDiffuse, uv - off).b;
        }
      }

      // grade: lift / gain / saturation
      col = col * uGain + uLift;
      float l = dot(col, vec3(0.2126,0.7152,0.0722));
      col = mix(vec3(l), col, uSaturation);
      col = mix(col, vec3(l), uDesat);

      // additive flash (before tonemap so ACES rolls it off)
      col += uFlashColor * uFlash;

      // vignette
      vec2 vd = (uv-0.5) * vec2(uAspect,1.0);
      float vig = 1.0 - uVignette * pow(clamp(dot(vd,vd)*0.86,0.0,1.0), 1.35);
      col *= vig;

      // grain (scaled by darkness so highlights stay clean)
      float g = h12(uv*vec2(1920.0,1080.0) + fract(uTime)*77.0) - 0.5;
      col += g * uGrain * (0.35 + 0.65*(1.0 - clamp(l,0.0,1.0)));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export class PostFX {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  renderPass: RenderPass;
  private output: OutputPass;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const dpr = renderer.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(size.x * dpr, size.y * dpr, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.58, 0.45, 1.08);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);
  }

  setCamera(cam: THREE.Camera) { this.renderPass.camera = cam; }

  /** drop MSAA + bloom resolution if we are struggling */
  setQuality(q: number) {
    this.bloom.strength = q < 0.8 ? 0.48 : 0.58;
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  get u() { return this.grade.uniforms as any; }

  update(dt: number, time: number) { this.grade.uniforms.uTime.value = time; }

  render(dt: number) { this.composer.render(dt); }
}
