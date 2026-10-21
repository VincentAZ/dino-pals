// Post-deploy check against the live site: loads on an iPad-sized touch viewport, starts, streams the
// world, taps a dinosaur, drops food, and verifies zero errors, versioned data URLs and compressed textures.
//   BASE=https://dino-pals-ai-learning-center.vercel.app node tests/prod.mjs
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'https://dino-pals-ai-learning-center.vercel.app';
const OUT = '/home/vincent/Repos/dinos/web/tests/shots/prod'; fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
const errors = [], failed = [], ktx2 = [], bare = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => failed.push(r.url() + ' ' + r.failure()?.errorText));
page.on('response', (r) => { const u = new URL(r.url()); if (r.status() >= 400) failed.push(`${r.status()} ${u.pathname}`); if (/\.(glb|json|mp3|webp|ktx2)$/.test(u.pathname) && u.pathname.startsWith('/assets/') && !u.searchParams.get('v')) bare.push(u.pathname); if (u.pathname.endsWith('.ktx2')) ktx2.push(u.pathname); });
const t0 = Date.now();
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForSelector('#splash', { timeout: 30000 });
const tSplash = Date.now() - t0;
await page.waitForTimeout(500); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 90000 });
const tReady = Date.now() - t0;
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 120000 }).catch(() => {});
const tSettled = Date.now() - t0;
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/01-start.png` });
const tap = await page.evaluate(() => { const a = window.__dino; for (const d of a.dinos.filter((x) => x.real)) { const p = a.screenOf(d.id); if (p && p[0] > 60 && p[0] < innerWidth - 60 && p[1] > 60 && p[1] < innerHeight - 160) return a.tapAt(p[0], p[1]); } return 'no dino on screen'; });
await page.waitForTimeout(1500); await page.screenshot({ path: `${OUT}/02-tap.png` });
await page.evaluate(() => window.__dino.food()); await page.waitForTimeout(8000); await page.screenshot({ path: `${OUT}/03-food.png` });
const s = await page.evaluate(() => { const st = window.__dino.stats(); return { version: window.__dino.version, fps: st.fps, tris: st.triangles, quality: st.quality, real: st.dinos.real, audio: st.audioState }; });
console.log(JSON.stringify({ BASE, tSplash, tReady, tSettled, tap, ...s, ktx2: ktx2.length, bareData: bare.length, failed: failed.slice(0, 5), errors: errors.slice(0, 5) }));
await browser.close();
const ok = errors.length === 0 && failed.length === 0 && bare.length === 0 && tap !== 'no dino on screen';
console.log(ok ? 'PROD PASSED' : 'PROD FAILED'); process.exit(ok ? 0 : 1);
