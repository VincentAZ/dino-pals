// Resolution governor: emulate a slow device (busy-wait per frame) and check the app lowers render
// scale, then the tier, and recovers sharpness once frames are fast again.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
let failed = false; const assert = (c, m) => { if (!c) { failed = true; console.error('ASSERT FAILED:', m); } else console.log('ok -', m); };
await page.goto(`http://localhost:${PORT}/?q=high&gov=1`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);
const st = () => page.evaluate(() => { const s = window.__dino.stats(); return { fps: s.fps, scale: s.renderScale, pr: s.pixelRatio, tier: s.quality }; });
const s0 = await st(); console.log('start', JSON.stringify(s0));
await page.evaluate(() => window.__dino.simulateSlow(28));
const trace = [];
for (let i = 0; i < 9; i++) { await page.waitForTimeout(2500); trace.push(await st()); }
console.log('slow', JSON.stringify(trace));
const s1 = trace[trace.length - 1];
assert(s0.scale === 1 && s0.tier === 'high', 'starts sharp on high');
assert(trace.some((t) => t.scale < 1 && t.tier === 'high'), 'first trades resolution');
assert(s1.tier === 'low', 'then drops to the low tier when still slow');
await page.evaluate(() => window.__dino.simulateSlow(0));
const rec = [];
for (let i = 0; i < 12; i++) { await page.waitForTimeout(2500); rec.push(await st()); }
console.log('recover', JSON.stringify(rec));
const sMid = trace.find((t) => t.tier === 'low') ?? s1;
assert(rec[rec.length - 1].scale > sMid.scale || rec[rec.length - 1].scale === 1, 'sharpness recovers when frames are fast');
// production URL (no forced tier): a fast machine must stay sharp on high through the loading phase
const page2 = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
page2.on('pageerror', (e) => errors.push(String(e)));
await page2.goto(`http://localhost:${PORT}/`); await page2.waitForSelector('#splash'); await page2.waitForTimeout(300); await page2.touchscreen.tap(590, 410);
await page2.waitForFunction(() => window.__dino && window.__dino.ready);
const prod = [];
for (let i = 0; i < 8; i++) { await page2.waitForTimeout(2500); prod.push(await page2.evaluate(() => { const s = window.__dino.stats(); return { fps: s.fps, scale: s.renderScale, tier: s.quality }; })); }
console.log('production', JSON.stringify(prod));
assert(prod.every((p) => p.tier === 'high' && p.scale === 1), 'production start keeps high tier and full sharpness on a fast machine');
assert(errors.length === 0, 'no errors');
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
console.log(failed ? 'GOVERNOR FAILED' : 'GOVERNOR PASSED'); process.exit(failed ? 1 : 0);
