// Feeding QA: drop food in front of the explorer, let herbivores come and eat; measure bite accuracy
// (snout→item distance at the moment of the bite), film from the child's camera and close-up.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/eat'; fs.mkdirSync(OUT, { recursive: true });
const SPECIES = (process.argv[2] || 'triceratops,stegosaurus,paluxysaurus').split(',');
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
const ids = await page.evaluate((sps) => {
  const a = window.__dino; a.pause(true); a.setTime(13); a.teleport(0, 0); a.setView(0, 0.3, 8);
  const ids = []; let k = 0;
  for (const d of a.dinos) if (Math.hypot(d.x, d.z) < 150) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
  sps.forEach((sp, i) => { const d = a.dinos.find((x) => x.species === sp); a.command(d.id, { place: [-25 + 25 * i, -45, 0], stop: true }); ids.push(d.id); });
  return ids;
}, SPECIES);
for (let i = 0; i < 100; i++) { const ok = await page.evaluate((ids) => { const a = window.__dino; a.step(3); return ids.every((id) => a.dinos.find((d) => d.id === id).real); }, ids); if (ok) break; await page.waitForTimeout(60); }
await page.evaluate((ids) => { const a = window.__dino; ids.forEach((id, i) => a.command(id, { place: [-25 + 25 * i, -45, 0], stop: true })); a.step(10); for (const id of ids) a.command(id, { release: true }); a.dropFoodAt(0, -12); }, ids);
// child's view: 25 s at 2 fps, then close-up of the first eater
for (let f = 0; f < 50; f++) {
  await page.evaluate(() => window.__dino.step(15));
  if (f % 2 === 0) await page.screenshot({ path: `${OUT}/kid_${String(f / 2).padStart(2, '0')}.png` });
}
const mid = await page.evaluate(() => ({ foods: window.__dino.foods(), bites: window.__dino.biteLog().length }));
console.log('after 25 s', JSON.stringify(mid));
const eater = await page.evaluate((ids) => ids.find((id) => window.__dino.dinos.find((d) => d.id === id).state === 'eat') ?? ids[0], ids);
await page.evaluate((id) => window.__dino.watch(id, -1.2, 0.18, 9, 0.25), eater);
for (let f = 0; f < 24; f++) { await page.evaluate(() => window.__dino.step(5)); await page.screenshot({ path: `${OUT}/close_${String(f).padStart(2, '0')}.png` }); }
await page.evaluate(() => window.__dino.watch(null));
for (let f = 0; f < 40; f++) await page.evaluate(() => window.__dino.step(30));
const bites = await page.evaluate(() => window.__dino.biteLog());
const foods = await page.evaluate(() => window.__dino.foods());
const ds = bites.map((b) => b.dist).sort((a, b) => a - b);
console.log('bites', bites.length, 'median', ds[Math.floor(ds.length / 2)], 'max', ds[ds.length - 1], 'by', JSON.stringify(bites.reduce((m, b) => { m[b.dino] = (m[b.dino] || 0) + 1; return m; }, {})));
console.log('foods left', JSON.stringify(foods));
console.log('overlaps', JSON.stringify(await page.evaluate(() => window.__dino.overlaps())));
console.log('errors', errors.length, errors.slice(0, 3));
fs.writeFileSync(`${OUT}/bites.json`, JSON.stringify(bites, null, 1));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
