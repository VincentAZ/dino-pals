// Can animals still cross the snow conifer forest (low-crowned firs are now foliage obstacles)?
// Sends a small and a big dinosaur 70 m across the forest from several starts; reports arrival / stuck / overlaps.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 900, height: 600 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high${process.env.QS ?? ''}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(450, 300);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
const snow = await page.evaluate(() => window.__dino.biomes.snow);
let fails = 0;
for (const sp of ['velociraptor', 'triceratops']) {
  for (const [dx, dz] of [[1, 0], [0, 1], [-0.7, 0.7], [0.7, 0.7]]) {
    const r = await page.evaluate(async ([sp, snow, dx, dz]) => {
      const a = window.__dino; a.pause(true); a.setTime(12);
      const sx = snow[0] - dx * 35, sz = snow[1] - dz * 35, gx = snow[0] + dx * 35, gz = snow[1] + dz * 35;
      a.teleport(sx, sz);
      const me = a.dinos.find((d) => d.species === sp && !d.baby);
      let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x - snow[0], d.z - snow[1]) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
      for (let i = 0; i < 60; i++) { a.step(3); await new Promise((r) => setTimeout(r, 30)); if (a.dinos.find((d) => d.id === me.id).real) break; }
      a.command(me.id, { place: [sx, sz, Math.atan2(dx, dz)], stop: true }); a.step(10);
      a.command(me.id, { walkTo: [gx, gz] });
      let worst = 0;
      for (let f = 0; f < 60 * 30; f += 15) { a.teleport(a.dinos.find((d) => d.id === me.id).x + 8, a.dinos.find((d) => d.id === me.id).z + 8); a.step(15); const o = a.overlaps(); worst = Math.max(worst, o.worst); if (Math.hypot(a.dinos.find((d) => d.id === me.id).x - gx, a.dinos.find((d) => d.id === me.id).z - gz) < 4) break; await new Promise((r) => setTimeout(r, 0)); }
      const d = a.dinos.find((x) => x.id === me.id);
      const left = Math.hypot(d.x - gx, d.z - gz);
      a.command(me.id, { place: [400, 400, 0], stop: true });
      return { left: +left.toFixed(1), worst: +worst.toFixed(2) };
    }, [sp, snow, dx, dz]);
    const ok = r.left < 6 && r.worst === 0;
    if (!ok) fails++;
    console.log(sp, dx, dz, JSON.stringify(r), ok ? 'ok' : 'STUCK/OVERLAP');
  }
}
console.log('errors', errors.length, errors.slice(0, 2));
console.log(fails === 0 ? 'FOREST PASSED' : `FOREST: ${fails} problem runs`);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
