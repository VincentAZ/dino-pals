// Home-screen icon: a square close-up of the game's T. rex mid-roar.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(500, 500);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.addStyleTag({ content: '#hud{display:none!important}' });
const VARIANTS = JSON.parse(process.env.V || '[[2.4,1.2,-0.2,26],[2.0,1.6,0.0,30],[2.8,0.6,-0.4,22]]');
const id = await page.evaluate(() => { const a = window.__dino; a.pause(true); a.setTime(17.8); a.teleport(0, 0); const me = a.dinos.find((d) => d.species === 'trex' && !d.baby); let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true }); a.command(me.id, { place: [0, -14, 0], stop: true }); return me.id; });
for (let i = 0; i < 120; i++) { const r = await page.evaluate((id) => { window.__dino.step(3); return window.__dino.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
for (const [i, [fwd, side, up, frames]] of VARIANTS.entries()) {
  await page.evaluate(([id, fwd, side, up, frames]) => {
    const a = window.__dino; a.command(id, { place: [0, -14, 0], stop: true }); a.step(30); a.command(id, { release: true });
    const xy = a.screenOf(id); if (xy) a.tapAt(xy[0], xy[1]); a.step(frames); a.clearFx();
    const [hx, hy, hz, h] = a.headPos(id); const s = Math.sin(h), c = Math.cos(h);
    a.director([hx + s * fwd + c * side, hy + up, hz + c * fwd - s * side], null, [hx - s * 0.7, hy - 0.15, hz - c * 0.7]); a.step(1, 0);
  }, [id, fwd, side, up, frames]);
  await page.screenshot({ path: `${ROOT}/tests/shots/icon_${i}.png` });
}
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
console.log('ok');
