// Dinosaur frustum culling must never hide a dinosaur that is on screen: spin the camera around a crowd
// and compare each frame with culling on vs off (pixel diff), and report the triangle savings.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const OUT = ROOT + '/tests/shots/cull'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const a = window.__dino; a.setTime(13); a.pause(true);
  const land = a.dinos.filter((d) => Math.hypot(d.x, d.z) < 150 && d.y > -1);
  let k = 0; for (const d of land) { const ang = (k++ / land.length) * Math.PI * 2; const r = 9 + (k % 3) * 7; a.command(d.id, { place: [Math.sin(ang) * r, Math.cos(ang) * r, ang + Math.PI * 0.5], stop: true }); }
  for (let i = 0; i < 80; i++) { a.step(2); await new Promise((r) => setTimeout(r, 40)); }
  for (const d of land) a.command(d.id, { stop: true });
  a.step(4);
});
let maxDiff = 0, sumOn = 0, sumOff = 0; const rows = [];
for (let i = 0; i < 16; i++) {
  const yaw = (i / 16) * Math.PI * 2, pitch = i % 2 ? 0.15 : 0.5, dist = i % 3 === 0 ? 4 : 10;
  const shoot = async (on) => {
    await page.evaluate(([on, yaw, pitch, dist]) => { const a = window.__dino; a.setDinoCulling(on); a.setView(yaw, pitch, dist); a.step(1, 0); }, [on, yaw, pitch, dist]);
    const tris = await page.evaluate(() => window.__dino.stats().triangles);
    const buf = await page.screenshot({ type: 'png' });
    return { tris, buf };
  };
  const off = await shoot(false), on = await shoot(true);
  fs.writeFileSync(`${OUT}/on_${i}.png`, on.buf); fs.writeFileSync(`${OUT}/off_${i}.png`, off.buf);
  sumOn += on.tris; sumOff += off.tris; rows.push([i, off.tris, on.tris]);
}
console.log(JSON.stringify(rows));
console.log('triangles: no-cull avg', Math.round(sumOff / 16), 'cull avg', Math.round(sumOn / 16));
console.log('errors', errors.length, errors.slice(0, 2));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
