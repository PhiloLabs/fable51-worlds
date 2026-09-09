import * as THREE from 'three';
import { PostFX } from './postfx';
import { CAM_FAR, CAM_NEAR, FOV_DEFAULT } from './constants';

export class Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  post: PostFX;
  time = 0;
  dt = 0;
  frame = 0;
  paused = false;
  timeScale = 1;
  private _raf = 0;
  private _last = 0;
  private _acc: number[] = [];
  fps = 60;
  /** adaptive quality 0.55..1 */
  quality = 1;

  onUpdate: ((dt: number, t: number) => void) | null = null;

  constructor(container: HTMLElement) {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = false;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    this.camera = new THREE.PerspectiveCamera(FOV_DEFAULT, innerWidth / innerHeight, CAM_NEAR, CAM_FAR);
    this.camera.position.set(0, 0, 0);

    this.post = new PostFX(this.renderer, this.scene, this.camera);

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2) * this.quality;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, dpr);
  }

  start() {
    this._last = performance.now();
    const loop = (now: number) => {
      this._raf = requestAnimationFrame(loop);
      let raw = (now - this._last) / 1000;
      this._last = now;
      if (raw > 0.1) raw = 0.1;          // avoid huge steps after a stall
      this._acc.push(raw);
      if (this._acc.length > 45) this._acc.shift();
      this.fps = 1 / (this._acc.reduce((a, b) => a + b, 0) / this._acc.length);

      const dt = this.paused ? 0 : raw * this.timeScale;
      this.dt = dt;
      this.time += dt;
      this.frame++;

      this.renderer.info.reset();
      this.autoQuality(raw);
      this.onUpdate?.(dt, this.time);
      this.post.update(dt, this.time);
      this.post.render(Math.max(dt, 1e-4));
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this._raf); }

  /** Drop the render scale if we cannot hold ~50 fps, raise it again when we can. */
  private _qTimer = 0;
  autoQualityEnabled = true;
  private autoQuality(raw: number) {
    if (!this.autoQualityEnabled || this.frame < 90) return;
    this._qTimer += raw;
    if (this._qTimer < 1.5) return;
    this._qTimer = 0;
    const f = this.fps;
    let q = this.quality;
    if (f < 42 && q > 0.6) q = Math.max(0.6, q - 0.12);
    else if (f > 58 && q < 1) q = Math.min(1, q + 0.08);
    if (Math.abs(q - this.quality) > 0.001) {
      this.quality = q;
      this.post.setQuality(q);
      this.resize();
    }
  }
}
