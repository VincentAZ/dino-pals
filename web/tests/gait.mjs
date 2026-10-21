// Gait QA: films dinosaurs walking, turning in place and stopping at a fixed 30 fps simulation step,
// and records the locomotion measurements (foot slip in stance, IK reach misses, steps).
// Usage: node tests/gait.mjs [species,species,...]
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/gait'; fs.mkdirSync(OUT, { recursive: true });
const SPECIES = (process.argv[2] || 'trex,triceratops,paluxysaurus,velociraptor,stegosaurus').split(',');
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'load' });
await page.waitForSelector('#splash'); await page.waitForTimeout(300);
await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__dino.setTime(13); });
const results = {};
const shot = async (name) => page.screenshot({ path: `${OUT}/${name}.png` });
for (const sp of SPECIES) {
  // park everybody else far away so nothing interferes
  const id = await page.evaluate((sp) => {
    const api = window.__dino; api.pause(true);
    const list = api.dinos;
    const me = list.find((d) => d.species === sp);
    let k = 0;
    for (const d of list) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) api.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
    return me.id;
  }, sp);
  // make sure the real model is loaded
  await page.evaluate((id) => window.__dino.command(id, { place: [-14, -26, Math.PI / 2], stop: true }), id);
  for (let i = 0; i < 200; i++) {
    const real = await page.evaluate((id) => { window.__dino.step(3); return window.__dino.dinos.find((d) => d.id === id).real; }, id);
    if (real) break;
    await page.waitForTimeout(50);
  }
  const info0 = await page.evaluate((id) => window.__dino.loco(id), id);
  const L = info0 ? Math.max(6, info0.legLen * 4.2) : 12;
  await page.evaluate(([id, L]) => { const a = window.__dino; a.command(id, { place: [-14, -26, Math.PI / 2], stop: true }); a.step(40); a.watch(id, -Math.PI / 2, 0.06, L, 0.4); }, [id, L]);
  // ---- walk across (side view), 10 shots per second for 4 s
  await page.evaluate((id) => window.__dino.command(id, { walkTo: [30, -26] }), id);
  for (let f = 0; f < 40; f++) { await page.evaluate(() => window.__dino.step(3)); if (f >= 16) await shot(`${sp}_walk_${String(f - 16).padStart(2, '0')}`); }
  const walk = await page.evaluate((id) => window.__dino.loco(id), id);
  // ---- stop and settle
  await page.evaluate((id) => window.__dino.command(id, { stop: true }), id);
  for (let f = 0; f < 30; f++) { await page.evaluate(() => window.__dino.step(3)); if (f % 3 === 0) await shot(`${sp}_stop_${String(f / 3).padStart(2, '0')}`); }
  const stop = await page.evaluate((id) => window.__dino.loco(id), id);
  // ---- turn in place towards a point behind, 3/4 high view
  await page.evaluate(([id, L]) => { const a = window.__dino; const d = a.loco(id); a.watch(id, -2.3, 0.45, L * 1.1, 0.3); a.command(id, { face: [d.pos[0] - 20, d.pos[1] + 2] }); }, [id, L]);
  for (let f = 0; f < 36; f++) { await page.evaluate(() => window.__dino.step(3)); if (f % 2 === 0) await shot(`${sp}_turn_${String(f / 2).padStart(2, '0')}`); }
  const turn = await page.evaluate((id) => window.__dino.loco(id), id);
  results[sp] = { id, walk, stop, turn };
  console.log(sp, JSON.stringify({ walk, stop: { maxSlip: stop.maxSlip, maxReach: stop.maxReach, steps: stop.steps, settle: stop.settle, emergency: stop.emergency }, turn: { heading: turn.heading, maxSlip: turn.maxSlip, maxReach: turn.maxReach, steps: turn.steps } }));
  await page.evaluate((id) => { const a = window.__dino; a.watch(null); a.command(id, { place: [400, 400, 0], stop: true }); }, id);
}
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 1));
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
