// Build a labelled contact sheet from a directory of PNGs so many frames can be
// reviewed at once.  node qa/sheet.mjs --dir qa/shots --out qa/sheet.png --cols 4
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean)
    .map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; })
);
const DIR = args.dir || 'qa/shots';
const OUT = args.out || 'qa/sheet.png';
const COLS = parseInt(args.cols || '4', 10);
const CELL = parseInt(args.cell || '520', 10);
const FILTER = args.match ? new RegExp(args.match) : null;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png') && (!FILTER || FILTER.test(f))).sort();
if (!files.length) { console.error('no pngs in', DIR); process.exit(1); }
console.log(`${files.length} frames → ${OUT}`);

const rows = Math.ceil(files.length / COLS);
const cellH = Math.round(CELL * 9 / 16);
const html = `<!doctype html><meta charset=utf8><style>
 body{margin:0;background:#0a0c10;font:11px/1.4 ui-monospace,Menlo,monospace;color:#8fb8d4}
 .g{display:grid;grid-template-columns:repeat(${COLS},${CELL}px);gap:6px;padding:6px}
 figure{margin:0}
 img{width:${CELL}px;height:${cellH}px;object-fit:cover;display:block;background:#000}
 figcaption{padding:2px 3px;color:#ffb400;white-space:nowrap;overflow:hidden}
</style><div class=g>${files.map((f) => `<figure><img src="file://${path.resolve(DIR, f)}"><figcaption>${f.replace('.png', '')}</figcaption></figure>`).join('')}</div>`;

const tmp = path.join(path.dirname(OUT), '_sheet.html');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(tmp, html);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: COLS * (CELL + 6) + 12, height: rows * (cellH + 24) + 12 } });
await page.goto('file://' + path.resolve(tmp));
await page.waitForTimeout(400);
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
fs.unlinkSync(tmp);
console.log('wrote', OUT);
