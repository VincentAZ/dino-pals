// Vegetation close-ups: for each species, find the nearest placed instance
// from a biome anchor and photograph it from several distances (LOD0 / LOD1 /
// impostor ranges).
//   node tests/treeqa.mjs [--tag t1] [--tier high] [--species island_tree_01,jacaranda_tree] [--dists 9,30,80,160]
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const TAG = opt('tag', 'trees');
const TIER = opt('tier', 'high');
const SPECIES = opt('species', 'island_tree_01,tree_small_02,jacaranda_tree,shrub_02').split(',');
const DISTS = opt('dists', '9,30,80,160').split(',').map(Number);
const HOURS = Number(opt('hours', '10'));
const HOME = { island_tree_01: 'jungle', island_tree_02: 'jungle', island_tree_03: 'jungle', tree_small_02: 'jungle', jacaranda_tree: 'meadow', fir_tree_01: 'snow', pine_tree_01: 'snow', quiver_tree_01: 'canyon', dead_quiver_trunk: 'swamp', fern_02: 'jungle', shrub_01: 'jungle', shrub_02: 'canyon', shrub_03: 'jungle', shrub_04: 'canyon', searsia_lucida: 'canyon', wild_rooibos_bush: 'canyon', nettle_plant: 'jungle', weed_plant_02: 'swamp', pine_sapling_medium: 'snow', flower_gazania: 'meadow', flower_ursinia: 'meadow', boulder_01: 'canyon', rock_07: 'volcano', rock_face_01: 'volcano', moon_rock_03: 'volcano' };
const OUT = path.join(ROOT, 'tests', 'shots', 'env', TAG);
await fs.mkdir(OUT, { recursive: true });
const PORT = 5900 + Math.floor(Math.random() * 600);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${PORT}/?q=${TIER}`, { waitUntil: 'load' });
await page.waitForSelector('#splash'); await page.waitForTimeout(400); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
const settle = async (ms = 2500) => { await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 40000 }).catch(() => {}); await page.waitForTimeout(ms); };
await settle(3000);
for (const sp of SPECIES) {
  await page.evaluate(() => window.__dino.pause(false));
  await page.evaluate((b) => window.__dino.teleportBiome(b), HOME[sp] ?? 'meadow');
  await settle(2500);
  const pos = await page.evaluate((id) => { const a = window.__dino; return a.vegNear(id); }, sp);
  if (!pos) { console.log(sp, 'not found'); continue; }
  for (const d of DISTS) {
    await page.evaluate(([p, d]) => { const a = window.__dino; a.pause(false); const ang = 0.6; a.teleport(p[0] + Math.sin(ang) * d, p[2] + Math.cos(ang) * d); a.lookAt(p[0], p[2]); a.setView(a.view().yaw, d < 15 ? 0.12 : 0.08, 4); }, [pos, d]);
    await settle(1800);
    await page.evaluate((h) => { const a = window.__dino; a.setTime(h); a.pause(true); a.step(2); }, HOURS);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `${TIER}-${sp}-${String(d).padStart(3, '0')}.png`) });
  }
  console.log(sp, 'at', pos.map((v) => v.toFixed(0)).join(','));
}
if (errors.length) console.log('ERRORS', errors);
await browser.close();
try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
