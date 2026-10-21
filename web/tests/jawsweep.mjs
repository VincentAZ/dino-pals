// Side views of each head while closing the jaw in steps, to measure how far each sculpted-open mouth
// must close at rest.   SP=allosaurus,carnotaurus node tests/jawsweep.mjs
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const OUT = ROOT + '/tests/shots/jaw'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 900, height: 600 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(450, 300);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
const ANG = (process.env.ANG || '0,7,14,21,28,35').split(',').map(Number);
const SIZE = { trex: 12, carnotaurus: 8, allosaurus: 9, velociraptor: 2.6, ankylosaurus: 7, triceratops: 8.5, spinosaurus: 14, iguanodon: 9, pachycephalosaurus: 4.5, sauropelta: 5.5, stegosaurus: 8, paluxysaurus: 20 };
for (const sp of (process.env.SP || 'allosaurus,carnotaurus').split(',')) {
  const id = await page.evaluate((sp) => {
    const a = window.__dino; a.pause(true); a.setTime(13); a.teleport(0, 0);
    const me = a.dinos.find((d) => d.species === sp && !d.baby);
    let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
    a.command(me.id, { place: [-14, -26, 0.9], stop: true }); return me.id;
  }, sp);
  for (let i = 0; i < 100; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
  for (const deg of ANG) {
    await page.evaluate(([id, sp, deg, L, dk]) => { const a = window.__dino; a.command(id, { place: [-14, -26, 0.9], stop: true }); if (deg >= 0) a.setJawClose(sp, deg); a.watch(id, 1.5708, 0.02, Math.max(1.2, L * dk), 0.5, true); a.step(45); }, [id, sp, deg, SIZE[sp] ?? 6, +(process.env.DK || 0.16)]);
    console.log(sp, deg, JSON.stringify(await page.evaluate((id) => { const l = window.__dino.loco(id); return { state: l.state }; }, id)));
    await page.screenshot({ path: `${OUT}/${sp}_${String(deg).padStart(2, '0')}.png`, clip: { x: 225, y: 150, width: 450, height: 300 } });
  }
  await page.evaluate((id) => { const a = window.__dino; a.watch(null); a.command(id, { place: [400, 400, 0], stop: true }); }, id);
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
