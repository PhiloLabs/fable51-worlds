/**
 * Final acceptance check.  Runs the shipped build (vite preview) and verifies:
 *   1. the whole sequence plays end to end with no console errors
 *   2. every phase and every camera shot is reached
 *   3. real-time frame rate at each phase
 *   4. the interactive controls all respond
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://localhost:4193/';
fs.mkdirSync('qa/verify', { recursive: true });
const b = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
let p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await p.goto(URL_, { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => !!window.__demo?.ready, null, { timeout: 240000 });
await p.evaluate(() => window.__demo.start(false));

// ---- 1 & 2: walk the whole sequence, recording phases and shots ----
const phases = new Set(), shots = new Set();
let last = null;
for (let t = 1; t <= 208; t += 1) {
  const st = await p.evaluate(async (tt) => { await window.__demo.seek(tt); return window.__demo.state(); }, t);
  phases.add(st.phase); shots.add(st.shot);
  if (st.phase !== last) { last = st.phase; console.log(`  ${String(Math.round(st.t)).padStart(3)}s → ${st.phase}`); }
}
console.log('\nphases reached:', [...phases].join(' '));
console.log('shots reached :', [...shots].sort().join(' '), `(${shots.size})`);

// `seek` only ever moves forward, so each later section needs a fresh page.
async function fresh(interactive) {
  const q = await b.newPage({ viewport: { width: 1600, height: 900 } });
  q.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  q.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await q.goto(URL_, { waitUntil: 'load', timeout: 120000 });
  await q.waitForFunction(() => !!window.__demo?.ready, null, { timeout: 240000 });
  await q.evaluate((i) => window.__demo.start(i), interactive);
  return q;
}
await p.close();

// ---- 3: real-time fps per phase ----
console.log('\nreal-time frame rate:');
for (const t of [8, 26, 46, 66, 88, 112, 134, 144, 156, 168, 176, 190]) {
  const q = await fresh(false);
  await q.evaluate(async (tt) => { await window.__demo.seek(tt); window.__demo.resume(); }, t);
  await q.waitForTimeout(3200);
  const st = await q.evaluate(() => ({ ...window.__demo.state(), q: window.__demo.engine.quality }));
  console.log(`  ${String(t).padStart(3)}s ${st.phase.padEnd(11)} ${st.fps.toFixed(0).padStart(4)} fps  ${String(st.calls).padStart(4)} calls  ${(st.tris / 1e6).toFixed(2)}M tris  q=${st.q.toFixed(2)}`);
  await q.close();
}

// ---- 4: interactive controls ----
console.log('\ninteractive:');
p = await fresh(true);
await p.evaluate(async () => { await window.__demo.seek(95); window.__demo.resume(); });
await p.waitForTimeout(500);
const a0 = await p.evaluate(() => ({ lat: window.__demo.ship.lateral, up: window.__demo.ship.up, v: window.__demo.ship.speed }));
await p.keyboard.down('KeyA'); await p.keyboard.down('KeyS'); await p.waitForTimeout(900);
await p.keyboard.up('KeyA'); await p.keyboard.up('KeyS');
const a1 = await p.evaluate(() => ({ lat: window.__demo.ship.lateral, up: window.__demo.ship.up }));
console.log(`  steer   lateral ${a0.lat.toFixed(0)} → ${a1.lat.toFixed(0)},  up ${a0.up.toFixed(0)} → ${a1.up.toFixed(0)}`);
await p.keyboard.down('ShiftLeft'); await p.waitForTimeout(1200);
const v1 = await p.evaluate(() => window.__demo.ship.speed); await p.keyboard.up('ShiftLeft');
console.log(`  boost   ${a0.v.toFixed(0)} → ${v1.toFixed(0)} m/s`);
await p.keyboard.down('Space'); await p.waitForTimeout(600); await p.keyboard.up('Space');
console.log(`  lasers  ${(await p.evaluate(() => window.__demo.world.fx.stats().lasers))} bolts in flight`);
await p.evaluate(() => { window.__demo.ship.up = -30; });
await p.keyboard.down('KeyW'); await p.waitForTimeout(1500); await p.keyboard.up('KeyW');
console.log(`  ceiling up clamped to ${(await p.evaluate(() => window.__demo.ship.up)).toFixed(1)} (must stay below 0)`);
await p.screenshot({ path: 'qa/verify/interactive.png' });

console.log('\nconsole errors:', errs.length ? errs.slice(0, 10) : 'none');
await b.close();
