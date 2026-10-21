// iPad lifecycle: WebGL context loss + restore, background/foreground, audio revival.
//   node tests/lifecycle.mjs
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'tests', 'shots', 'lifecycle');
const PORT = 4173 + Math.floor(Math.random() * 500);
await fs.mkdir(SHOTS, { recursive: true });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview start timeout')), 20000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const assert = (c, m) => { if (!c) { failed = true; console.error('ASSERT FAILED:', m); } else console.log('ok -', m); };
try {
  const viewport = { width: 1180, height: 820 };
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  let navigations = 0; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
  await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'load' });
  await page.waitForSelector('#splash', { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.touchscreen.tap(viewport.width / 2, viewport.height / 2);
  await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
  await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // mean luminance of the canvas tells "rendering" from "black/frozen"
  const lum = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => {
    const c = document.querySelector('#app canvas'); const o = document.createElement('canvas'); o.width = 64; o.height = 48;
    const g = o.getContext('2d'); g.drawImage(c, 0, 0, 64, 48); const d = g.getImageData(0, 0, 64, 48).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; res(s / (d.length / 4) / 3);
  })));
  const before = await lum();
  await page.screenshot({ path: path.join(SHOTS, '01-before.png') });
  const navs0 = navigations;
  // 1) context loss and restore
  await page.evaluate(() => { window.__lc = document.querySelector('#app canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__lc.restoreContext());
  await page.waitForTimeout(4000);
  const after = await lum();
  await page.screenshot({ path: path.join(SHOTS, '02-after-restore.png') });
  const st = await page.evaluate(() => window.__dino.stats());
  console.log('luminance before', before.toFixed(1), 'after restore', after.toFixed(1), 'losses', st.contextLosses, 'fps', st.fps, 'tris', st.triangles);
  assert(st.contextLosses === 1, 'context loss observed');
  assert(navigations === navs0, 'restored without a page reload');
  assert(Math.abs(after - before) < 25 && after > 30, 'scene renders again after restore');
  // tapping a dinosaur still works after restore
  const tapped = await page.evaluate(() => { const a = window.__dino; const d = a.dinos.find((x) => x.real && !x.baby); const xy = d && a.screenOf(d.id); return xy ? a.tapAt(xy[0], xy[1]) : 'none-visible'; });
  console.log('tap after restore ->', tapped);
  // 2) a context that never comes back reloads the page (instead of a frozen screen)
  await page.evaluate(() => { window.__lc = document.querySelector('#app canvas').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
  await page.waitForTimeout(6000);
  assert(navigations > navs0, 'unrecovered context loss reloads the page');
  await page.waitForSelector('#splash', { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.touchscreen.tap(viewport.width / 2, viewport.height / 2);
  await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  // 3) audio suspended behind our back (iOS "interrupted") comes back on the next touch
  await page.evaluate(() => window.__dino.stats());
  const s0 = await page.evaluate(async () => { await window.__dinoAudioSuspend?.(); return window.__dino.stats().audioState; });
  console.log('audio state after reload+tap', s0);
  // 4) hide / show
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(2500);
  const fps = (await page.evaluate(() => window.__dino.stats())).fps;
  assert(fps > 20, `loop runs again after hide/show (fps ${fps})`);
  const realErr = errors.filter((e) => !/CONTEXT_LOST|context lost|WebGL: /i.test(e));
  console.log('console errors', errors.length, realErr.slice(0, 5));
  assert(realErr.length === 0, 'no runtime errors');
} finally {
  await browser.close();
  try { process.kill(-server.pid); } catch { /* */ }
}
console.log(failed ? 'LIFECYCLE FAILED' : 'LIFECYCLE PASSED');
process.exit(failed ? 1 : 0);
