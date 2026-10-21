// Collision QA: forest crossing, crowd crossing, and free-running AI; counts body overlaps.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/collide'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
await page.goto(`http://localhost:${PORT}/?q=high`, { waitUntil: 'load' });
await page.waitForSelector('#splash'); await page.waitForTimeout(300);
await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1000);
const report = {};
// ---------------- 1. walk straight at trees: start, target and the straight line pass through a trunk
await page.evaluate(() => { const a = window.__dino; a.setTime(13); a.pause(true); });
const tree = await page.evaluate(() => {
  const a = window.__dino;
  for (const id of ['jacaranda_tree', 'island_tree_02', 'island_tree_01', 'tree_small_02']) { const t = a.vegNear(id); if (t) return { id, t }; }
  return null;
});
console.log('tree', JSON.stringify(tree));
const treeRuns = [];
for (const sp of ['triceratops', 'trex', 'paluxysaurus']) {
  const id = await page.evaluate(([sp, t]) => {
    const a = window.__dino; const me = a.dinos.find((d) => d.species === sp);
    let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x - t[0], d.z - t[2]) < 100) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
    a.command(me.id, { place: [t[0] - 18, t[2] + 0.3, Math.PI / 2], stop: true });
    return me.id;
  }, [sp, tree.t]);
  for (let i = 0; i < 80; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
  await page.evaluate(([id, t]) => { const a = window.__dino; a.command(id, { place: [t[0] - 18, t[2] + 0.3, Math.PI / 2], stop: true }); a.step(20); a.watch(id, -1.9, 0.75, 22, 0.2); a.command(id, { walkTo: [t[0] + 18, t[2] + 0.3] }); }, [id, tree.t]);
  let bad = 0, worst = 0, minClear = 99;
  for (let f = 0; f < 100; f++) {
    const o = await page.evaluate(([id, t]) => { const a = window.__dino; a.step(6); const l = a.loco(id); return { ...a.overlaps(), d: Math.hypot(l.pos[0] - t[0], l.pos[1] - t[2]) }; }, [id, tree.t]);
    if (o.dinoTree > 0) { bad++; worst = Math.max(worst, o.worst); }
    minClear = Math.min(minClear, o.d);
    if (f % 10 === 0) await page.screenshot({ path: `${OUT}/tree_${sp}_${String(f / 10).padStart(2, '0')}.png` });
  }
  const end = await page.evaluate((id) => window.__dino.loco(id).pos, id);
  treeRuns.push({ sp, bad, worst, minRootToTrunk: +minClear.toFixed(2), end, goal: [tree.t[0] + 18, tree.t[2] + 0.3] });
  console.log('tree', sp, JSON.stringify(treeRuns[treeRuns.length - 1]));
  await page.evaluate((id) => { const a = window.__dino; a.watch(null); a.command(id, { place: [400, 400, 0], stop: true }); }, id);
}
report.trees = treeRuns;
// ---------------- 2. crowd crossing on the meadow
await page.evaluate(() => { const a = window.__dino; a.watch(null); a.teleport(0, 0); a.setView(Math.PI, 0.5, 14); });
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
const crowd = await page.evaluate(() => {
  const a = window.__dino; const sps = ['triceratops', 'stegosaurus', 'iguanodon', 'velociraptor', 'pachycephalosaurus'];
  const ids = []; let k = 0;
  for (const d of a.dinos) if (Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
  sps.forEach((sp, i) => {
    const d = a.dinos.find((x) => x.species === sp && !ids.includes(x.id));
    const ang = (i / sps.length) * Math.PI * 2; const R = 14;
    a.command(d.id, { place: [Math.cos(ang) * R, -30 + Math.sin(ang) * R, Math.atan2(-Math.cos(ang), -Math.sin(ang))], stop: true });
    ids.push(d.id);
  });
  return ids;
});
for (let i = 0; i < 80; i++) { const ok = await page.evaluate((ids) => { const a = window.__dino; a.step(3); return ids.every((id) => a.dinos.find((d) => d.id === id).real); }, crowd); if (ok) break; await page.waitForTimeout(50); }
await page.evaluate((ids) => {
  const a = window.__dino;
  ids.forEach((id, i) => { const ang = (i / ids.length) * Math.PI * 2 + Math.PI; a.command(id, { walkTo: [Math.cos(ang) * 14, -30 + Math.sin(ang) * 14] }); });
  a.setView(Math.PI, 0.9, 30); a.lookAt(0, -30);
}, crowd);
let crowdFrames = 0, crowdWorst = 0;
for (let f = 0; f < 120; f++) {
  const o = await page.evaluate(() => { const a = window.__dino; a.step(6); return a.overlaps(); });
  if (o.dinoDino > 0) { crowdFrames++; crowdWorst = Math.max(crowdWorst, o.worst); }
  if (f % 10 === 0) await page.screenshot({ path: `${OUT}/crowd_${String(f / 10).padStart(2, '0')}.png` });
}
const arrived = await page.evaluate((ids) => ids.map((id) => window.__dino.loco(id).pos), crowd);
report.crowd = { frames: 120, overlapFrames: crowdFrames, worst: crowdWorst, arrived };
console.log('crowd', JSON.stringify(report.crowd));
// ---------------- 3. free run (normal AI everywhere) for 90 s
await page.evaluate(() => { const a = window.__dino; for (const d of a.dinos) a.command(d.id, { release: true }); a.teleport(0, 0); });
let freeFrames = 0, freeBad = 0, freeWorst = 0, treeBad = 0;
for (let f = 0; f < 180; f++) {
  const o = await page.evaluate(() => { const a = window.__dino; a.step(15); return a.overlaps(); });
  freeFrames++; if (o.dinoDino > 0) freeBad++; if (o.dinoTree > 0) treeBad++; freeWorst = Math.max(freeWorst, o.worst);
}
report.free = { samples: freeFrames, dinoDinoSamples: freeBad, dinoTreeSamples: treeBad, worst: freeWorst };
console.log('free', JSON.stringify(report.free));
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, errors }, null, 1));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
