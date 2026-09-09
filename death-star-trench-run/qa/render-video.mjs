/**
 * Renders a highlight reel straight out of the running experience.
 *
 * Frames are produced by stepping the sequence with a fixed 1/30 s timestep via
 * `window.__demo.seek`, so the output is deterministic and perfectly smooth
 * regardless of how long each screenshot takes.  Segments must be listed in
 * increasing time order — `seek` only ever moves forward.
 *
 *   node qa/render-video.mjs [url] [outfile]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5190/';
const OUT = process.argv[3] || 'trench-run.mp4';
const FPS = 30;
const W = 1280, H = 720;
const TMP = fs.mkdtempSync('/tmp/trenchrun-');

/** [sequence-time start, duration] — the cut. */
const SEGMENTS = [
  [4.0, 2.4],    // wide on the station, title card
  [21.5, 2.4],   // s-foils lock in attack position
  [30.0, 1.8],   // hero close-up
  [45.0, 2.4],   // TIE intercept
  [64.5, 2.4],   // dive to the surface
  [86.0, 2.4],   // trench run
  [114.0, 2.4],  // trench run under fire
  [137.0, 2.0],  // targeting the exhaust port
  [141.0, 2.2],  // torpedoes away
  [164.0, 3.0],  // core ignition into the fireball
  [168.8, 2.4],  // shockwave
  [185.0, 2.4],  // clear of the debris field
];
const total = SEGMENTS.reduce((a, s) => a + s[1], 0);
console.log(`${SEGMENTS.length} shots · ${total.toFixed(1)}s · ${Math.round(total * FPS)} frames · ${W}x${H}@${FPS}`);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){}});export function injectQuery(u){return u}export function removeStyle(){}' }));
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(URL_, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!window.__demo?.ready, null, { timeout: 240000 });
await page.evaluate(() => window.__demo.start(false));

let n = 0;
const t0 = Date.now();
for (const [start, dur] of SEGMENTS) {
  await page.evaluate((t) => window.__demo.seek(t), start);      // fast-forward, no frames
  const count = Math.round(dur * FPS);
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => window.__demo.seek(t), start + (i + 1) / FPS);
    await page.screenshot({ path: path.join(TMP, `f${String(n++).padStart(5, '0')}.png`) });
  }
  const st = await page.evaluate(() => window.__demo.state());
  console.log(`  ${String(start).padStart(6)}s +${dur}s  ${st.phase.padEnd(11)} ${st.shot.padEnd(20)} ${n} frames  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
if (errs.length) console.log('page errors:', [...new Set(errs)].slice(0, 5));
await browser.close();

console.log('\nencoding…');
const fade = total - 0.45;
execFileSync('ffmpeg', [
  '-y', '-framerate', String(FPS), '-i', path.join(TMP, 'f%05d.png'),
  '-vf', `fade=t=in:st=0:d=0.35,fade=t=out:st=${fade.toFixed(2)}:d=0.45`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  OUT,
], { stdio: 'inherit' });
fs.rmSync(TMP, { recursive: true, force: true });
const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`\nwrote ${OUT}  (${total.toFixed(1)}s, ${mb} MB)`);
