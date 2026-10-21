import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts) const OUT = ROOT + '/tests/shots/look'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
const sp = process.argv[2] || 'triceratops';
const ids = await page.evaluate((sp) => {
  const a = window.__dino; a.pause(true); a.setTime(13);
  const baby = a.dinos.find((d) => d.species === sp && d.baby); const idx = +baby.id.split('-').pop(); const parent = a.dinos.find((d) => d.id === `dino-${sp}-${idx - 1}`);
  let k = 0; for (const d of a.dinos) if (d.id !== baby.id && d.id !== parent.id && Math.hypot(d.x + 10, d.z + 26) < 80) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
  a.command(parent.id, { place: [-20, -26, Math.PI / 2], stop: true }); a.command(baby.id, { place: [-22, -30, Math.PI / 2], stop: true }); a.command(baby.id, { release: true });
  return { baby: baby.id, parent: parent.id };
}, sp);
for (let i = 0; i < 100; i++) { const ok = await page.evaluate((ids) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === ids.baby).real && a.dinos.find((d) => d.id === ids.parent).real; }, ids); if (ok) break; await page.waitForTimeout(60); }
await page.evaluate((ids) => { const a = window.__dino; a.command(ids.parent, { place: [-20, -26, Math.PI / 2], stop: true }); a.step(20); a.command(ids.parent, { walkTo: [30, -26] }); a.watch(ids.parent, 2.0, 0.3, 16, 0.2); }, ids);
for (let f = 0; f < 16; f++) {
  const st = await page.evaluate((ids) => { const a = window.__dino; a.step(8); const b = a.loco(ids.baby); const p = a.loco(ids.parent); return { b: b.pos, bv: b.speed, bst: b.state, route: b.route, steer: b.steerSpeed, bl: b.blocked, p: p.pos }; }, ids);
  if (process.env.TRACE) console.log(JSON.stringify(st));
  await page.screenshot({ path: `${OUT}/fam_${sp}_${String(f).padStart(2, '0')}.png` });
}
console.log(JSON.stringify(await page.evaluate((ids) => ({ baby: window.__dino.loco(ids.baby), parent: window.__dino.loco(ids.parent).pos }), ids)));
console.log('errors', errors.length);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
