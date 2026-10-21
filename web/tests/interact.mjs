// Interaction films from the child's camera: tap-tap on a T. rex (roar, stomp) and hold-to-follow.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/interact'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
const setup = async (sp, place) => {
  const id = await page.evaluate(([sp, place]) => {
    const a = window.__dino; a.pause(true); a.setTime(13); a.teleport(0, 0); a.setView(0, 0.2, 7);
    const me = a.dinos.find((d) => d.species === sp);
    let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
    a.command(me.id, { place, stop: true }); return me.id;
  }, [sp, place]);
  for (let i = 0; i < 100; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
  await page.evaluate(([id, place]) => { const a = window.__dino; a.command(id, { place, stop: true }); a.command(id, { release: true }); a.step(20); }, [id, place]);
  return id;
};
const film = async (name, n, every) => { for (let f = 0; f < n; f++) { await page.evaluate((k) => window.__dino.step(k), every); await page.screenshot({ path: `${OUT}/${name}_${String(f).padStart(2, '0')}.png` }); } };
// 1. T. rex: tap → roar, tap again → stomp
let id = await setup('trex', [6, -34, Math.PI / 2]);
let xy = await page.evaluate((id) => window.__dino.screenOf(id), id);
console.log('tap1', await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), xy));
await film('rex_roar', 16, 15);
xy = await page.evaluate((id) => window.__dino.screenOf(id), id);
console.log('tap2', await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), xy));
await film('rex_stomp', 12, 6);
console.log('rex', JSON.stringify(await page.evaluate((id) => { const l = window.__dino.loco(id); return { slip: l.maxSlip, reach: l.maxReach, state: l.state }; }, id)));
// 2. Triceratops: hold → follows the explorer who walks away
id = await setup('triceratops', [-6, -16, 0.4]);
xy = await page.evaluate((id) => window.__dino.screenOf(id), id);
console.log('hold', await page.evaluate(([x, y]) => window.__dino.holdAt(x, y), xy));
await page.evaluate(() => { window.__dino.step(30); });
for (let k = 0; k < 4; k++) { await page.evaluate(() => { const a = window.__dino; a.tapAt(590, 520); }); await film(`follow${k}`, 4, 20); }
console.log('follow', JSON.stringify(await page.evaluate((id) => { const a = window.__dino; const l = a.loco(id); const p = a.stats().player; return { dino: l.pos, player: [p.x, p.z], state: l.state, follow: l.follow }; }, id)));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
