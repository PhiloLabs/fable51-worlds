/* =========================================================================
   TRENCH RUN — HUD / targeting-computer overlay.
   DOM + SVG, styled after a 1977-vintage X-wing targeting scope: thin amber
   vector lines, blue-white monospace telemetry, sparse & corner-hugging.
   All CSS is injected from here — no external stylesheet, no web fonts.
   ========================================================================= */

import { clamp, saturate, damp, lerp } from '../core/mathx';
import { TRENCH_BOOST } from '../core/constants';

export type HUDMode = 'off' | 'cinematic' | 'combat' | 'targeting';

export interface HUD {
  root: HTMLElement;
  setMode(m: HUDMode): void;
  setVisible(v: boolean): void;
  /** speed in m/s, and whether the boost is engaged */
  setSpeed(v: number, boost: boolean): void;
  setShield(v: number): void; // 0..1
  setTorpedoes(n: number): void; // remaining
  setLasers(ready: boolean, heat: number): void; // heat 0..1
  /** targeting-computer lock progress 0..1 and whether it has locked */
  setLock(progress: number, locked: boolean): void;
  /** move the aim reticle; x,y in NDC (-1..1), y up */
  setReticle(x: number, y: number, visible: boolean): void;
  /** the exhaust-port target box; x,y NDC, size in px */
  setTargetBox(x: number, y: number, size: number, visible: boolean, locked: boolean): void;
  /** distance-to-target readout in metres, or null to hide */
  setRange(m: number | null): void;
  /** radio chatter line; queues if one is already showing */
  radio(speaker: string, text: string, dur?: number): void;
  /** big centre-screen title card, e.g. phase names; auto-fades */
  title(main: string, sub?: string, dur?: number): void;
  setPhase(name: string): void; // small corner label
  flashDamage(intensity?: number): void; // red edge flash
  setLetterbox(v: number): void; // 0..1 cinematic bars
  setStats(fps: number, draws: number, tris: number, ms: number): void;
  showStats(v: boolean): void;
  /** bottom-of-screen progress through the whole 3.5-minute sequence, 0..1 */
  setProgress(p: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------------ */
/*  CSS                                                                     */
/* ------------------------------------------------------------------------ */

const STYLE_ID = 'sw-hud-style';

const CSS = `
.sw-hud, .sw-hud * { box-sizing: border-box; }
.sw-hud {
  position: fixed; inset: 0; overflow: hidden; pointer-events: none;
  font-family: "SF Mono","Menlo","Consolas",monospace;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  color: #cfe9ff;
  --amber: #ffb400;
  --amber-soft: #ffd684;
  --amber-dim: #7a5410;
  --blue: #d7ecff;
  --blue-dim: #5f88a4;
  --green: #79ffb4;
  --red: #ff4438;
  user-select: none;
}
.sw-hud[data-visible="0"] { display: none; }

.sw-hud .sw-el { position: absolute; left: 0; top: 0; will-change: transform; }

/* ---------------- letterbox ---------------- */
.sw-lb { position: absolute; left: 0; width: 100%; height: clamp(40px, 13vh, 150px); background: #000; }
.sw-lb-top { top: 0; transform-origin: top center; transform: scaleY(0); }
.sw-lb-bot { bottom: 0; transform-origin: bottom center; transform: scaleY(0); }

/* ---------------- damage flash / vignette ---------------- */
.sw-vignette-static {
  position: absolute; inset: -2px;
  background-image:
    radial-gradient(ellipse at center, transparent 55%, rgba(255,60,60,.05) 100%),
    radial-gradient(ellipse at center, transparent 58%, rgba(60,190,255,.05) 100%);
  background-position: -2px 0, 2px 0;
  background-size: 100% 100%, 100% 100%;
  background-repeat: no-repeat, no-repeat;
  mix-blend-mode: screen;
}
.sw-dmg {
  position: absolute; inset: -2px; opacity: 0;
  background: radial-gradient(ellipse at center, transparent 45%, rgba(255,30,20,.65) 100%);
}

/* ---------------- scanlines (topmost, subtle) ---------------- */
.sw-scan {
  position: absolute; inset: 0; opacity: .035; mix-blend-mode: overlay;
  background: repeating-linear-gradient(to bottom, rgba(255,255,255,.9) 0px, rgba(255,255,255,.9) 1px, transparent 1px, transparent 3px);
}

/* ---------------- reticle ---------------- */
.sw-reticle-wrap { position: absolute; left: 0; top: 0; opacity: 1; transition: opacity .35s ease; }
.sw-reticle-wrap.is-hidden { opacity: 0; }
.sw-reticle-svg { width: clamp(120px, 15vmin, 230px); height: clamp(120px, 15vmin, 230px); overflow: visible; display: block; transform: translate(-50%,-50%); }
.sw-reticle-svg .ring { stroke: var(--amber); stroke-width: 1; fill: none; opacity: .8; }
.sw-reticle-svg .brk { stroke: var(--amber); stroke-width: 1.4; fill: none; }
.sw-reticle-svg .tick { stroke: var(--amber); stroke-width: 1.2; }
.sw-reticle-svg .dot { fill: var(--amber); }
.sw-reticle-svg .lockgrp { opacity: 0; transition: opacity .3s ease; }
.sw-hud.mode-targeting .sw-reticle-svg .lockgrp { opacity: 1; }
.sw-reticle-svg .lockbox { stroke: var(--amber); stroke-width: 1; fill: none; transition: stroke .25s ease; }
.sw-reticle-svg .lockbox.locked { stroke: var(--green); }
.sw-reticle-svg .corner { stroke: var(--amber); stroke-width: 1.6; fill: none; transition: stroke .25s ease, transform .18s cubic-bezier(.2,1.5,.4,1); }
.sw-reticle-svg .corner.locked { stroke: var(--green); }
.sw-reticle-svg .pulse { stroke: var(--green); stroke-width: 1.2; fill: none; opacity: 0; }
.sw-reticle-svg .locktxt { fill: var(--green); font-size: 11px; letter-spacing: .3em; opacity: 0; font-family: inherit; }

/* ---------------- target box ---------------- */
.sw-tbox-wrap { position: absolute; inset: 0; opacity: 0; transition: opacity .25s ease; }
.sw-tbox-wrap.is-visible { opacity: 1; }
.sw-tbox-box { position: absolute; left: 0; top: 0; width: 100px; height: 100px; }
.sw-tbox-svg { width: 100%; height: 100%; display: block; overflow: visible; }
.sw-tbox-svg .frame { stroke: var(--amber); stroke-width: 1; fill: none; opacity: .35; }
.sw-tbox-svg .corner { stroke: var(--amber); stroke-width: 2; fill: none; }
.sw-tbox-svg .cross { stroke: var(--green); stroke-width: 1; opacity: 0; transition: opacity .25s ease; }
.sw-tbox-wrap.is-locked .sw-tbox-svg .corner { stroke: var(--green); }
.sw-tbox-wrap.is-locked .sw-tbox-svg .frame { stroke: var(--green); opacity: .5; }
.sw-tbox-wrap.is-locked .sw-tbox-svg .cross { opacity: .9; }
.sw-tbox-label {
  position: absolute; left: 0; top: 0; transform: translate(-50%,0);
  font-size: clamp(9px, 1.1vmin, 12px); letter-spacing: .28em; color: var(--amber);
  text-shadow: 0 0 6px rgba(255,180,0,.5); white-space: nowrap;
}
.sw-tbox-wrap.is-locked .sw-tbox-label { color: var(--green); text-shadow: 0 0 6px rgba(120,255,180,.5); }
.sw-tbox-range {
  position: absolute; left: 0; top: 0; transform: translate(-50%,0);
  font-size: clamp(9px, 1vmin, 11px); letter-spacing: .12em; color: var(--blue-dim); white-space: nowrap;
}

/* ---------------- corner panels ---------------- */
.sw-panel { position: absolute; opacity: 1; transition: opacity .4s ease; }
.sw-hud:not(.mode-combat):not(.mode-targeting) .sw-panel { opacity: 0; }

.sw-panel-left { left: clamp(12px, 2.2vw, 30px); bottom: clamp(14px, 3vh, 34px); width: clamp(96px, 10vw, 140px); }
.sw-panel-right { right: clamp(12px, 2.2vw, 30px); bottom: clamp(14px, 3vh, 34px); width: clamp(120px, 12vw, 170px); }

.sw-cap { font-size: clamp(8px, .9vmin, 10px); letter-spacing: .3em; color: var(--blue-dim); text-align: center; margin-top: 4px; }

.sw-shield-wrap { position: relative; width: clamp(70px, 8vw, 108px); height: clamp(70px, 8vw, 108px); margin: 0 auto; }
.sw-shield-svg { width: 100%; height: 100%; display: block; overflow: visible; }
.sw-shield-svg .track { stroke: rgba(120,170,200,.18); stroke-width: 4; fill: none; }
.sw-shield-svg .fill { stroke: var(--blue); stroke-width: 4; fill: none; stroke-linecap: butt; transition: stroke .3s ease; }
.sw-shield-svg .fill.low { stroke: var(--red); }
.sw-shield-pct {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: clamp(13px, 1.5vw, 18px); color: var(--blue); text-shadow: 0 0 8px rgba(160,210,255,.35);
}
.sw-deflector { width: clamp(46px, 5.2vw, 68px); height: clamp(46px, 5.2vw, 68px); margin: 8px auto 0; display: block; overflow: visible; }
.sw-deflector .quad { fill: var(--blue); stroke: #050a10; stroke-width: 2; opacity: .3; transition: opacity .3s ease, fill .3s ease; }
.sw-deflector .quad.low { fill: var(--red); }
.sw-deflector .cross { stroke: rgba(200,230,255,.65); stroke-width: 1; }
.sw-deflector .ring { stroke: rgba(200,230,255,.65); stroke-width: 1.2; fill: none; }
.sw-deflector .hub { fill: rgba(200,230,255,.8); }

.sw-right-row { display: flex; align-items: flex-end; gap: 8px; }
.sw-throttle-track { position: relative; width: 8px; height: clamp(64px, 9vh, 110px); background: rgba(120,170,200,.14); border: 1px solid rgba(120,170,200,.3); flex: none; }
.sw-throttle-fill { position: absolute; left: 0; bottom: 0; width: 100%; height: 100%; background: var(--amber); transform: scaleY(0); transform-origin: bottom; }
.sw-throttle-fill.boost { background: var(--amber-soft); box-shadow: 0 0 10px rgba(255,190,80,.7); }

.sw-right-col { flex: 1; min-width: 0; }
.sw-speed { font-size: clamp(18px, 2.1vw, 26px); color: var(--blue); text-shadow: 0 0 8px rgba(160,210,255,.35); letter-spacing: .05em; line-height: 1; text-align: right; }
.sw-speed .unit { font-size: .4em; letter-spacing: .2em; color: var(--blue-dim); margin-left: .35em; }
.sw-boost-tag {
  margin-top: 4px; text-align: right; font-size: clamp(8px, .9vmin, 10px); letter-spacing: .3em;
  color: var(--amber-dim); transition: color .2s ease, text-shadow .2s ease;
}
.sw-boost-tag.on { color: var(--amber); text-shadow: 0 0 8px rgba(255,180,0,.6); }

.sw-laser { margin-top: 10px; }
.sw-laser-label { font-size: clamp(8px, .9vmin, 10px); letter-spacing: .28em; color: var(--blue-dim); display: flex; justify-content: space-between; }
.sw-laser-label .state { color: var(--amber); }
.sw-laser-label .state.hot { color: var(--red); }
.sw-laser-track { height: 4px; background: rgba(120,170,200,.14); border: 1px solid rgba(120,170,200,.3); margin-top: 3px; }
.sw-laser-fill { height: 100%; width: 100%; background: var(--green); transform: scaleX(0); transform-origin: left; }

.sw-torp { margin-top: 10px; display: flex; justify-content: flex-end; gap: 6px; }
.sw-torp svg { width: 26px; height: 12px; overflow: visible; }
.sw-torp path { fill: var(--amber); stroke: var(--amber); stroke-width: .5; transition: fill .3s ease, opacity .3s ease; }
.sw-torp .spent path { fill: rgba(110,140,160,.25); stroke: rgba(110,140,160,.25); }

/* ---------------- corner stats / phase ---------------- */
.sw-stats {
  position: absolute; left: clamp(10px, 1.6vw, 20px); top: clamp(10px, 1.6vh, 20px);
  font-size: clamp(9px, 1vmin, 11px); letter-spacing: .1em; color: var(--blue-dim); opacity: 0; transition: opacity .2s ease;
}
.sw-stats.on { opacity: .85; }
.sw-stats b { color: var(--blue); font-weight: 400; }

.sw-phase {
  position: absolute; right: clamp(10px, 1.6vw, 20px); top: clamp(10px, 1.6vh, 20px);
  font-size: clamp(9px, 1vmin, 11px); letter-spacing: .32em; color: var(--amber-dim);
  border-bottom: 1px solid rgba(255,180,0,.25); padding-bottom: 3px; opacity: .9;
}

/* ---------------- radio chatter ---------------- */
.sw-radio {
  position: absolute; left: 50%; bottom: clamp(58px, 9vh, 96px); transform: translateX(-50%);
  max-width: min(74vw, 640px); text-align: center; opacity: 0; transition: opacity .35s ease;
  font-size: clamp(11px, 1.5vmin, 15px); letter-spacing: .04em;
}
.sw-radio.show { opacity: 1; }
.sw-radio .spk { color: var(--amber); letter-spacing: .18em; text-shadow: 0 0 6px rgba(255,180,0,.4); }
.sw-radio .sep { color: var(--amber-dim); margin: 0 .5em; }
.sw-radio .txt { color: var(--blue); text-shadow: 0 0 5px rgba(160,210,255,.3); }

/* ---------------- title card ---------------- */
.sw-title { position: absolute; left: 50%; top: 44%; transform: translate(-50%,-50%); text-align: center; opacity: 0; transition: opacity .9s ease; }
.sw-title.show { opacity: 1; }
.sw-title .main { font-size: clamp(16px, 3.4vw, 46px); letter-spacing: .24em; color: var(--amber-soft); font-weight: 400; text-shadow: 0 0 22px rgba(255,190,60,.4); white-space: nowrap; }
.sw-title .sub { margin-top: 12px; font-size: clamp(9px, 1.15vw, 14px); letter-spacing: .38em; color: var(--blue-dim); white-space: nowrap; }

/* ---------------- progress hairline ---------------- */
.sw-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 1px; background: rgba(120,170,200,.14); }
.sw-progress i { display: block; height: 100%; width: 100%; background: var(--amber-dim); transform: scaleX(0); transform-origin: left; }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------------ */
/*  DOM helpers                                                             */
/* ------------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

function he<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
function se(tag: string, attrs?: Record<string, string | number>, parent?: Element): SVGElement {
  const e = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(e);
  return e;
}
function polar(cx: number, cy: number, r: number, angDeg: number) {
  const a = ((angDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p0 = polar(cx, cy, r, a0);
  const p1 = polar(cx, cy, r, a1);
  const large = ((a1 - a0) % 360 + 360) % 360 > 180 ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}
function torpedoPath(): string {
  // simple torpedo silhouette in a 28x12 box, nose pointing right — single closed path
  return 'M2,6 C2,3 5,1 9,1 L17,1 L26,6 L17,11 L9,11 C5,11 2,9 2,6 Z';
}
function fmtTris(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtRange(m: number): string {
  const r = Math.max(0, Math.round(m));
  return r.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' M';
}

/* ------------------------------------------------------------------------ */
/*  createHUD                                                               */
/* ------------------------------------------------------------------------ */

export function createHUD(root: HTMLElement): HUD {
  injectStyles();
  root.classList.add('sw-hud');
  root.setAttribute('data-visible', '1');

  let vw = window.innerWidth || 1280;
  let vh = window.innerHeight || 720;
  const onResize = () => { vw = window.innerWidth; vh = window.innerHeight; };
  window.addEventListener('resize', onResize);

  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------------- build DOM ---------------- */

  const vignetteStatic = he('div', 'sw-vignette-static', root);
  const lbTop = he('div', 'sw-lb sw-lb-top', root);
  const lbBot = he('div', 'sw-lb sw-lb-bot', root);
  const dmgEl = he('div', 'sw-dmg', root);

  // ---- reticle ----
  const reticleWrap = he('div', 'sw-reticle-wrap is-hidden', root);
  const reticleSvg = se('svg', { viewBox: '0 0 200 200', class: 'sw-reticle-svg' }, reticleWrap) as unknown as SVGSVGElement;
  const ringGroup = se('g', { class: 'ringgrp' }, reticleSvg) as unknown as SVGGElement;
  se('circle', { cx: 100, cy: 100, r: 88, class: 'ring', 'stroke-dasharray': '3 8' }, ringGroup);
  se('path', { d: arcPath(100, 100, 72, 235, 305), class: 'brk' }, reticleSvg);
  se('path', { d: arcPath(100, 100, 72, 55, 125), class: 'brk' }, reticleSvg);
  for (const ang of [0, 90, 180, 270]) {
    const p0 = polar(100, 100, 52, ang);
    const p1 = polar(100, 100, 64, ang);
    se('line', { x1: p0.x.toFixed(1), y1: p0.y.toFixed(1), x2: p1.x.toFixed(1), y2: p1.y.toFixed(1), class: 'tick' }, reticleSvg);
  }
  se('circle', { cx: 100, cy: 100, r: 2.2, class: 'dot' }, reticleSvg);

  const lockGroup = se('g', { class: 'lockgrp' }, reticleSvg) as unknown as SVGGElement;
  const lockBox = se('rect', { x: 52, y: 52, width: 96, height: 96, class: 'lockbox' }, lockGroup) as unknown as SVGRectElement;
  const cornerLen = 10;
  function cornerPath(sx: number, sy: number, dx: number, dy: number): string {
    return `M ${sx} ${sy + dy * cornerLen} L ${sx} ${sy} L ${sx + dx * cornerLen} ${sy}`;
  }
  const corners: SVGPathElement[] = [];
  const cornerSigns: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (const [sx, sy] of cornerSigns) {
    const p = se('path', { class: 'corner' }, lockGroup) as unknown as SVGPathElement;
    corners.push(p);
  }
  const pulseRing = se('circle', { cx: 100, cy: 100, r: 20, class: 'pulse' }, reticleSvg) as unknown as SVGCircleElement;
  const lockText = se('text', { x: 100, y: 152, class: 'locktxt', 'text-anchor': 'middle' }, reticleSvg) as unknown as SVGTextElement;
  lockText.textContent = 'LOCK';

  // ---- target box ----
  const tboxWrap = he('div', 'sw-tbox-wrap', root);
  const tboxBox = he('div', 'sw-tbox-box', tboxWrap);
  const tboxSvg = se('svg', { viewBox: '0 0 100 100', class: 'sw-tbox-svg' }, tboxBox) as unknown as SVGSVGElement;
  se('rect', { x: 4, y: 4, width: 92, height: 92, class: 'frame' }, tboxSvg);
  const TC = 16;
  const tCornerD = [
    `M4,${4 + TC} L4,4 L${4 + TC},4`,
    `M${96 - TC},4 L96,4 L96,${4 + TC}`,
    `M4,${96 - TC} L4,96 L${4 + TC},96`,
    `M${96 - TC},96 L96,96 L96,${96 - TC}`,
  ];
  for (const d of tCornerD) se('path', { d, class: 'corner' }, tboxSvg);
  se('line', { x1: 4, y1: 4, x2: 96, y2: 96, class: 'cross' }, tboxSvg);
  se('line', { x1: 96, y1: 4, x2: 4, y2: 96, class: 'cross' }, tboxSvg);
  const tboxLabel = he('div', 'sw-tbox-label', tboxWrap);
  tboxLabel.textContent = 'EXHAUST PORT';
  const tboxRange = he('div', 'sw-tbox-range', tboxWrap);

  // ---- left panel (shield) ----
  const panelLeft = he('div', 'sw-panel sw-panel-left', root);
  const shieldWrap = he('div', 'sw-shield-wrap', panelLeft);
  const shieldSvg = se('svg', { viewBox: '0 0 120 120', class: 'sw-shield-svg' }, shieldWrap) as unknown as SVGSVGElement;
  const SHIELD_R = 50;
  const SHIELD_C = 2 * Math.PI * SHIELD_R;
  se('circle', { cx: 60, cy: 60, r: SHIELD_R, class: 'track' }, shieldSvg);
  const shieldFill = se('circle', {
    cx: 60, cy: 60, r: SHIELD_R, class: 'fill',
    'stroke-dasharray': SHIELD_C.toFixed(1), transform: 'rotate(-90 60 60)',
  }, shieldSvg) as unknown as SVGCircleElement;
  const shieldPct = he('div', 'sw-shield-pct', shieldWrap);
  const deflSvg = se('svg', { viewBox: '0 0 80 80', class: 'sw-deflector' }, panelLeft) as unknown as SVGSVGElement;
  const deflQuads: SVGPathElement[] = [];
  const quadArcs = [[0, 90], [90, 180], [180, 270], [270, 360]];
  for (const [a0, a1] of quadArcs) {
    const p0 = polar(40, 40, 30, a0), p1 = polar(40, 40, 30, a1);
    const large = a1 - a0 > 180 ? 1 : 0;
    const d = `M40,40 L${p0.x.toFixed(1)},${p0.y.toFixed(1)} A30,30 0 ${large} 1 ${p1.x.toFixed(1)},${p1.y.toFixed(1)} Z`;
    deflQuads.push(se('path', { d, class: 'quad' }, deflSvg) as unknown as SVGPathElement);
  }
  se('circle', { cx: 40, cy: 40, r: 30, class: 'ring' }, deflSvg);
  se('line', { x1: 10, y1: 40, x2: 70, y2: 40, class: 'cross' }, deflSvg);
  se('line', { x1: 40, y1: 10, x2: 40, y2: 70, class: 'cross' }, deflSvg);
  se('circle', { cx: 40, cy: 40, r: 2.4, class: 'hub' }, deflSvg);
  const leftCap = he('div', 'sw-cap', panelLeft);
  leftCap.textContent = 'DEFLECTOR';

  // ---- right panel (speed / throttle / laser / torpedo) ----
  const panelRight = he('div', 'sw-panel sw-panel-right', root);
  const rightRow = he('div', 'sw-right-row', panelRight);
  const throttleTrack = he('div', 'sw-throttle-track', rightRow);
  const throttleFill = he('div', 'sw-throttle-fill', throttleTrack);
  const rightCol = he('div', 'sw-right-col', rightRow);
  const speedEl = he('div', 'sw-speed', rightCol);
  const speedUnit = he('span', 'unit', speedEl);
  speedUnit.textContent = 'M/S';
  const boostTag = he('div', 'sw-boost-tag', rightCol);
  boostTag.textContent = 'BOOST';

  const laserWrap = he('div', 'sw-laser', rightCol);
  const laserLabelRow = he('div', 'sw-laser-label', laserWrap);
  const laserLabel = he('span', undefined, laserLabelRow);
  laserLabel.textContent = 'LASER';
  const laserState = he('span', 'state', laserLabelRow);
  laserState.textContent = 'READY';
  const laserTrack = he('div', 'sw-laser-track', laserWrap);
  const laserFill = he('div', 'sw-laser-fill', laserTrack);

  const torpRow = he('div', 'sw-torp', rightCol);
  const torpIcons: HTMLElement[] = [];
  for (let i = 0; i < 2; i++) {
    const wrap = he('div', undefined, torpRow);
    const svg = se('svg', { viewBox: '0 0 28 12' }, wrap) as unknown as SVGSVGElement;
    se('path', { d: torpedoPath() }, svg);
    torpIcons.push(wrap);
  }

  // ---- stats / phase ----
  const statsEl = he('div', 'sw-stats', root);
  const phaseEl = he('div', 'sw-phase', root);

  // ---- radio ----
  const radioEl = he('div', 'sw-radio', root);
  const radioSpeaker = he('span', 'spk', radioEl);
  const radioSep = he('span', 'sep', radioEl);
  radioSep.textContent = '▸';
  const radioText = he('span', 'txt', radioEl);

  // ---- title ----
  const titleEl = he('div', 'sw-title', root);
  const titleMain = he('div', 'main', titleEl);
  const titleSub = he('div', 'sub', titleEl);

  // ---- progress ----
  const progressEl = he('div', 'sw-progress', root);
  const progressFill = he('i', undefined, progressEl);

  // scanlines: topmost
  const scanEl = he('div', 'sw-scan', root);

  /* ---------------- state ---------------- */

  type RadioItem = { speaker: string; text: string; dur: number };
  type RadioActive = RadioItem & { phase: 'type' | 'hold' | 'fade'; t: number; shown: number };
  type TitleState = { main: string; sub: string; dur: number; phase: 'in' | 'hold' | 'out'; t: number };

  const st = {
    mode: 'off' as HUDMode,
    visible: true,
    speedLast: -1,
    boostLast: undefined as boolean | undefined,
    shieldLast: -1,
    torpLast: -1,
    laserReadyLast: undefined as boolean | undefined,
    laserHeatLast: -1,
    lockProgress: 0,
    locked: false,
    lockSizeCur: 96,
    pulseActive: false,
    pulseT: 0,
    reticle: { x: 0, y: 0, visible: false, px: 0, py: 0 },
    reticleShownLast: false,
    tbox: { x: 0, y: 0, size: 60, visible: false, locked: false },
    tboxVisibleLast: false,
    tboxLockedLast: false,
    rangeLast: undefined as number | null | undefined,
    phaseLast: '',
    letterboxTarget: 0,
    letterboxCur: 0,
    dmgFlash: 0,
    statsOn: false,
    progressLast: -1,
    ringAngle: 0,
    radioQueue: [] as RadioItem[],
    radioActive: null as RadioActive | null,
    title: null as TitleState | null,
  };

  const ndcToPx = (x: number, y: number) => ({
    x: (x * 0.5 + 0.5) * vw,
    y: (1 - (y * 0.5 + 0.5)) * vh,
  });

  /* ---------------- mode / visibility ---------------- */

  function applyMode() {
    root.classList.remove('mode-off', 'mode-cinematic', 'mode-combat', 'mode-targeting');
    root.classList.add('mode-' + st.mode);
  }

  /* ---------------- setters ---------------- */

  function setMode(m: HUDMode) {
    if (st.mode === m) return;
    st.mode = m;
    applyMode();
  }

  function setVisible(v: boolean) {
    if (st.visible === v) return;
    st.visible = v;
    root.setAttribute('data-visible', v ? '1' : '0');
  }

  function setSpeed(v: number, boost: boolean) {
    const rv = Math.round(v);
    if (rv !== st.speedLast) {
      st.speedLast = rv;
      const s = Math.max(0, Math.min(9999, rv)).toString().padStart(4, '0');
      speedEl.firstChild!.textContent = s + ' ';
    }
    if (boost !== st.boostLast) {
      st.boostLast = boost;
      boostTag.classList.toggle('on', boost);
      throttleFill.classList.toggle('boost', boost);
    }
    const frac = saturate(v / TRENCH_BOOST);
    throttleFill.style.transform = `scaleY(${frac.toFixed(3)})`;
  }

  function setShield(v: number) {
    const sv = saturate(v);
    if (Math.abs(sv - st.shieldLast) < 0.001 && st.shieldLast >= 0) return;
    st.shieldLast = sv;
    const off = SHIELD_C * (1 - sv);
    shieldFill.setAttribute('stroke-dashoffset', off.toFixed(1));
    const low = sv < 0.35;
    shieldFill.classList.toggle('low', low);
    shieldPct.textContent = Math.round(sv * 100) + '%';
    for (const q of deflQuads) q.classList.toggle('low', low);
    for (const q of deflQuads) (q as unknown as SVGPathElement).style.opacity = String(0.12 + sv * 0.55);
  }

  function setTorpedoes(n: number) {
    if (n === st.torpLast) return;
    st.torpLast = n;
    torpIcons.forEach((el, i) => el.classList.toggle('spent', i >= n));
  }

  function setLasers(ready: boolean, heat: number) {
    const h = saturate(heat);
    if (ready !== st.laserReadyLast) {
      st.laserReadyLast = ready;
      laserState.textContent = ready ? 'READY' : 'OVERHEAT';
      laserState.classList.toggle('hot', !ready);
    }
    if (Math.abs(h - st.laserHeatLast) > 0.003) {
      st.laserHeatLast = h;
      laserFill.style.transform = `scaleX(${h.toFixed(3)})`;
      laserFill.style.background = h > 0.85 ? 'var(--red)' : h > 0.55 ? 'var(--amber)' : 'var(--green)';
    }
  }

  function setLock(progress: number, locked: boolean) {
    st.lockProgress = saturate(progress);
    if (locked && !st.locked) {
      st.pulseActive = true;
      st.pulseT = 0;
    }
    st.locked = locked;
    lockBox.classList.toggle('locked', locked);
    for (const c of corners) c.classList.toggle('locked', locked);
  }

  function setReticle(x: number, y: number, visible: boolean) {
    st.reticle.x = x; st.reticle.y = y; st.reticle.visible = visible;
    if (visible !== st.reticleShownLast) {
      st.reticleShownLast = visible;
      reticleWrap.classList.toggle('is-hidden', !visible);
    }
    if (visible) {
      const p = ndcToPx(x, y);
      reticleSvg.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-50%,-50%)`;
    }
  }

  function setTargetBox(x: number, y: number, size: number, visible: boolean, locked: boolean) {
    st.tbox.x = x; st.tbox.y = y; st.tbox.size = size; st.tbox.visible = visible; st.tbox.locked = locked;
    if (visible !== st.tboxVisibleLast) {
      st.tboxVisibleLast = visible;
      tboxWrap.classList.toggle('is-visible', visible);
    }
    if (locked !== st.tboxLockedLast) {
      st.tboxLockedLast = locked;
      tboxWrap.classList.toggle('is-locked', locked);
    }
    if (!visible) return;
    const p = ndcToPx(x, y);
    const scale = size / 100;
    tboxBox.style.transform = `translate(${(p.x - 50).toFixed(1)}px,${(p.y - 50).toFixed(1)}px) scale(${scale.toFixed(3)})`;
    const half = size / 2;
    tboxLabel.style.transform = `translate(${p.x.toFixed(0)}px,${(p.y - half - 20).toFixed(0)}px) translate(-50%,0)`;
    tboxRange.style.transform = `translate(${p.x.toFixed(0)}px,${(p.y + half + 12).toFixed(0)}px) translate(-50%,0)`;
  }

  function setRange(m: number | null) {
    if (m === st.rangeLast) return;
    st.rangeLast = m;
    tboxRange.style.opacity = m === null ? '0' : '1';
    tboxRange.textContent = m === null ? '' : fmtRange(m);
  }

  function radio(speaker: string, text: string, dur = 3.6) {
    if (st.radioQueue.length + (st.radioActive ? 1 : 0) >= 4) return;
    st.radioQueue.push({ speaker, text, dur });
  }

  function title(main: string, sub = '', dur = 3.5) {
    st.title = { main, sub, dur, phase: 'in', t: 0 };
    titleMain.textContent = main;
    titleSub.textContent = sub;
    titleSub.style.display = sub ? '' : 'none';
    titleEl.classList.add('show');
  }

  function setPhase(name: string) {
    if (name === st.phaseLast) return;
    st.phaseLast = name;
    phaseEl.textContent = name;
  }

  function flashDamage(intensity = 1) {
    st.dmgFlash = Math.max(st.dmgFlash, saturate(intensity));
  }

  function setLetterbox(v: number) {
    st.letterboxTarget = saturate(v);
  }

  function setStats(fps: number, draws: number, tris: number, ms: number) {
    statsEl.innerHTML =
      `<b>${Math.round(fps)}</b> FPS &middot; <b>${Math.round(draws)}</b> DRAWS &middot; <b>${fmtTris(tris)}</b> TRIS &middot; <b>${ms.toFixed(1)}</b> MS`;
  }

  function showStats(v: boolean) {
    if (v === st.statsOn) return;
    st.statsOn = v;
    statsEl.classList.toggle('on', v);
  }

  function setProgress(p: number) {
    const sp = saturate(p);
    if (Math.abs(sp - st.progressLast) < 0.0005) return;
    st.progressLast = sp;
    progressFill.style.transform = `scaleX(${sp.toFixed(4)})`;
  }

  /* ---------------- per-frame update ---------------- */

  function updateLockGeometry() {
    const target = lerp(96, 40, st.lockProgress);
    st.lockSizeCur = damp(st.lockSizeCur, target, 10, 1 / 60);
    const size = st.lockSizeCur;
    const half = size / 2;
    const x0 = 100 - half, y0 = 100 - half;
    lockBox.setAttribute('x', x0.toFixed(2));
    lockBox.setAttribute('y', y0.toFixed(2));
    lockBox.setAttribute('width', size.toFixed(2));
    lockBox.setAttribute('height', size.toFixed(2));
    const inset = 4;
    const cx0 = x0 + inset, cy0 = y0 + inset, cx1 = x0 + size - inset, cy1 = y0 + size - inset;
    corners[0].setAttribute('d', cornerPath(cx0, cy0, 1, 1));
    corners[1].setAttribute('d', cornerPath(cx1, cy0, -1, 1));
    corners[2].setAttribute('d', cornerPath(cx0, cy1, 1, -1));
    corners[3].setAttribute('d', cornerPath(cx1, cy1, -1, -1));
  }

  function updatePulse(dt: number) {
    if (!st.pulseActive) return;
    st.pulseT += dt;
    const PULSE_DUR = 0.5;
    const k = st.pulseT / PULSE_DUR;
    if (k >= 1) {
      st.pulseActive = false;
      (pulseRing as unknown as HTMLElement).style.opacity = '0';
      (lockText as unknown as HTMLElement).style.opacity = '0';
      return;
    }
    const r = lerp(18, 74, k);
    pulseRing.setAttribute('r', r.toFixed(1));
    (pulseRing as unknown as HTMLElement).style.opacity = String(1 - k);
    const txtOpacity = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
    (lockText as unknown as HTMLElement).style.opacity = String(Math.max(0, txtOpacity));
  }

  function updateRadio(dt: number) {
    if (!st.radioActive && st.radioQueue.length) {
      const item = st.radioQueue.shift()!;
      st.radioActive = { ...item, phase: 'type', t: 0, shown: 0 };
      radioSpeaker.textContent = item.speaker.toUpperCase();
      radioText.textContent = '';
      radioEl.classList.add('show');
    }
    const r = st.radioActive;
    if (!r) return;
    r.t += dt;
    if (r.phase === 'type') {
      const shown = Math.min(r.text.length, Math.floor(r.t * 28));
      if (shown !== r.shown) {
        r.shown = shown;
        radioText.textContent = r.text.slice(0, shown);
      }
      if (shown >= r.text.length) { r.phase = 'hold'; r.t = 0; }
    } else if (r.phase === 'hold') {
      if (r.t >= r.dur) { r.phase = 'fade'; r.t = 0; radioEl.classList.remove('show'); }
    } else {
      if (r.t >= 0.4) st.radioActive = null;
    }
  }

  function updateTitle(dt: number) {
    const t = st.title;
    if (!t) return;
    t.t += dt;
    if (t.phase === 'in') {
      if (t.t >= 0.9) { t.phase = 'hold'; t.t = 0; }
    } else if (t.phase === 'hold') {
      if (t.t >= t.dur) { t.phase = 'out'; t.t = 0; titleEl.classList.remove('show'); }
    } else {
      if (t.t >= 0.9) st.title = null;
    }
  }

  function update(dt: number, time: number) {
    if (dt <= 0) dt = 1 / 60;

    // reticle ring rotation
    if (!reduceMotion) st.ringAngle += dt * 9; // deg/s, slow
    ringGroup.setAttribute('transform', `rotate(${st.ringAngle.toFixed(2)} 100 100)`);

    updateLockGeometry();
    updatePulse(dt);

    // letterbox
    st.letterboxCur = damp(st.letterboxCur, st.letterboxTarget, 4, dt);
    if (Math.abs(st.letterboxCur - st.letterboxTarget) > 0.001 || st.letterboxCur > 0.0005 || st.letterboxTarget === 0) {
      lbTop.style.transform = `scaleY(${st.letterboxCur.toFixed(4)})`;
      lbBot.style.transform = `scaleY(${st.letterboxCur.toFixed(4)})`;
    }

    // damage flash decay
    if (st.dmgFlash > 0.0005) {
      st.dmgFlash *= Math.exp(-dt * 3.4);
      dmgEl.style.opacity = st.dmgFlash.toFixed(3);
    } else if (st.dmgFlash !== 0) {
      st.dmgFlash = 0;
      dmgEl.style.opacity = '0';
    }

    updateRadio(dt);
    updateTitle(dt);
  }

  function dispose() {
    window.removeEventListener('resize', onResize);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.classList.remove('sw-hud', 'mode-off', 'mode-cinematic', 'mode-combat', 'mode-targeting');
    root.removeAttribute('data-visible');
  }

  // init default text nodes that setSpeed expects (text node before unit span)
  speedEl.insertBefore(document.createTextNode('0000 '), speedUnit);
  setSpeed(0, false);
  setShield(1);
  setTorpedoes(2);
  setLasers(true, 0);
  setLock(0, false);
  applyMode();
  void vignetteStatic; void scanEl;

  return {
    root,
    setMode,
    setVisible,
    setSpeed,
    setShield,
    setTorpedoes,
    setLasers,
    setLock,
    setReticle,
    setTargetBox,
    setRange,
    radio,
    title,
    setPhase,
    flashDamage,
    setLetterbox,
    setStats,
    showStats,
    setProgress,
    update,
    dispose,
  };
}
