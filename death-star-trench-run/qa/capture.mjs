// Playwright QA harness: boots the app, seeks the sequence deterministically and
// screenshots milestones.  Usage:
//   node qa/capture.mjs [--url http://localhost:5180] [--times 0,10,40] [--out qa/shots] [--w 1600] [--h 900]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; })
);
const URL_ = args.url || 'http://localhost:5190/';
const OUT = args.out || 'qa/shots';
const W = parseInt(args.w || '1600', 10);
const H = parseInt(args.h || '900', 10);
const LABEL = args.label ? args.label + '-' : '';
const TIMES = (args.times ||
  '2,10,17,20,26,32,36,42,50,56,60,66,72,76,79,82,90,100,110,120,128,132,136,140,143,146,150,155,160,164,168,171,174,177,180,184,190,198')
  .split(',').map(Number);

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-webgl',
    '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /THREE|WebGL|shader|Error/i.test(t)) {
    errors.push(`[${m.type()}] ${t}`);
  }
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){}});export function injectQuery(u){return u}export function removeStyle(){}' }));
console.log('→', URL_);
await page.goto(URL_, { waitUntil: 'load', timeout: 120000 });

await page.waitForFunction(() => !!window.__demo?.ready, null, { timeout: 240000 });
const boot = await page.evaluate(() => document.getElementById('bootstatus')?.textContent);
console.log('boot:', boot);

await page.evaluate(() => window.__demo.start(false));
await page.waitForTimeout(600);

const report = [];
for (const t of TIMES) {
  const t0 = Date.now();
  const st = await page.evaluate(async (target) => {
    await window.__demo.seek(target);
    window.__demo.render();
    return window.__demo.state();
  }, t);
  await page.waitForTimeout(90);
  const file = path.join(OUT, `${LABEL}${String(Math.round(t)).padStart(3, '0')}s-${st.phase}.png`);
  await page.screenshot({ path: file });
  report.push({ ...st, t, file, ms: Date.now() - t0 });
  console.log(`  ${String(t).padStart(4)}s ${st.phase.padEnd(11)} ${st.shot.padEnd(19)} s=${String(Math.round(st.s)).padStart(6)} v=${String(Math.round(st.speed)).padStart(5)} calls=${String(st.calls).padStart(4)} tris=${(st.tris / 1e6).toFixed(2)}M`);
}

fs.writeFileSync(path.join(OUT, `${LABEL}report.json`), JSON.stringify({ report, errors }, null, 2));
if (errors.length) {
  console.log('\n--- console errors ---');
  for (const e of [...new Set(errors)].slice(0, 40)) console.log(e);
}
await browser.close();
console.log('\ndone →', OUT);
