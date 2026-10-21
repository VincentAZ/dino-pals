// Scenario runner for visual QA. Usage: node tests/look.mjs '<json scenario>'
// scenario: { species, place:[x,z,h], walkTo?:[x,z], frames, every, watch:[az,el,dist,height], prefix, eval?: "js run before" }
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/look'; fs.mkdirSync(OUT, { recursive: true });
const scenarios = JSON.parse(process.argv[2]);
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
await page.goto(`http://localhost:${PORT}/?q=high${process.env.QS ?? ''}`, { waitUntil: 'load' });
await page.waitForSelector('#splash'); await page.waitForTimeout(300);
await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1000);
await page.evaluate(() => { window.__dino.setTime(13); window.__dino.pause(true); });
for (const sc of (Array.isArray(scenarios) ? scenarios : [scenarios])) {
  const id = await page.evaluate((sc) => {
    const api = window.__dino; const list = api.dinos; const me = list.find((d) => d.species === sc.species);
    if (sc.isolate !== false) { let k = 0; for (const d of list) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) api.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true }); }
    api.command(me.id, { place: sc.place, stop: true });
    return me.id;
  }, sc);
  for (let i = 0; i < 200; i++) { const real = await page.evaluate((id) => { window.__dino.step(3); return window.__dino.dinos.find((d) => d.id === id).real; }, id); if (real) break; await page.waitForTimeout(50); }
  await page.evaluate(([id, sc]) => { const a = window.__dino; a.command(id, { place: sc.place, stop: true }); a.step(30); a.watch(id, ...sc.watch); if (sc.walkTo) a.command(id, { walkTo: sc.walkTo }); if (sc.face) a.command(id, { face: sc.face }); if (sc.eval) (0, eval)(sc.eval); }, [id, sc]);
  for (let f = 0; f < sc.frames; f++) {
    await page.evaluate((n) => window.__dino.step(n), sc.every || 3);
    await page.screenshot({ path: `${OUT}/${sc.prefix}_${String(f).padStart(2, '0')}.png` });
  }
  console.log(sc.prefix, JSON.stringify(await page.evaluate((id) => window.__dino.loco(id), id)));
  await page.evaluate((id) => { const a = window.__dino; a.watch(null); a.command(id, { place: [400, 400, 0], stop: true }); }, id);
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
