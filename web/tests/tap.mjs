// Interaction film from the child's camera: tap a dinosaur standing side-on, watch it look, roar and turn.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/tap'; fs.mkdirSync(OUT, { recursive: true });
const SPECIES = (process.argv[2] || 'triceratops').split(',');
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
for (const sp of SPECIES) {
  const id = await page.evaluate((sp) => {
    const a = window.__dino; a.pause(true); a.setTime(13); a.teleport(0, 0); a.setView(0, 0.18, 7);
    const me = a.dinos.find((d) => d.species === sp);
    let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
    a.command(me.id, { place: [2, -16, Math.PI / 2], stop: true });
    return me.id;
  }, sp);
  for (let i = 0; i < 80; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
  await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [2, -16, Math.PI / 2], stop: true }); a.command(id, { release: true }); a.step(30); }, id);
  await page.screenshot({ path: `${OUT}/${sp}_00.png` });
  const xy = await page.evaluate((id) => window.__dino.screenOf(id), id);
  const res = await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), xy);
  for (let f = 1; f <= 16; f++) { await page.evaluate(() => window.__dino.step(9)); await page.screenshot({ path: `${OUT}/${sp}_${String(f).padStart(2, '0')}.png` }); }
  console.log(sp, 'tap→', res, JSON.stringify(await page.evaluate((id) => { const l = window.__dino.loco(id); return { heading: l.heading, state: l.state, maxSlip: l.maxSlip }; }, id)));
}
console.log('errors', errors.length);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
