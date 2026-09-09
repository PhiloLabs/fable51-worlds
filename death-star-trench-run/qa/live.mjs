// Runs the experience in real time and screenshots at wall-clock milestones,
// which exercises the actual frame loop (streaming, pooling, perf) rather than
// the deterministic seek path.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; })
);
const URL_ = args.url || 'http://localhost:5190/';
const OUT = args.out || 'qa/live';
const DUR = parseFloat(args.dur || '215');
const EVERY = parseFloat(args.every || '5');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.route('**/@vite/client', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: 'export const createHotContext=()=>({on(){},send(){},accept(){},dispose(){},prune(){},invalidate(){}});export function injectQuery(u){return u}export function removeStyle(){}' }));
await page.goto(URL_, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => !!window.__demo?.ready, null, { timeout: 240000 });
await page.evaluate(() => window.__demo.start(false));

const samples = [];
let next = 0;
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < DUR) {
  const el = (Date.now() - t0) / 1000;
  if (el >= next) {
    const st = await page.evaluate(() => window.__demo.state());
    samples.push({ wall: +el.toFixed(1), ...st });
    await page.screenshot({ path: path.join(OUT, `${String(Math.round(el)).padStart(3, '0')}s-${st.phase}.png`) });
    console.log(`${el.toFixed(0).padStart(4)}s seq=${st.t.toFixed(1).padStart(6)} ${st.phase.padEnd(12)} ${st.shot.padEnd(20)} fps=${st.fps.toFixed(0).padStart(3)} calls=${String(st.calls).padStart(4)} tris=${(st.tris / 1e6).toFixed(2)}M`);
    next += EVERY;
  }
  await page.waitForTimeout(120);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ samples, errors }, null, 2));
if (errors.length) { console.log('\nerrors:'); [...new Set(errors)].slice(0, 30).forEach((e) => console.log(' ', e)); }
await browser.close();
