// Close-up environment QA for the conifers and the volcano near field:
// conifers of the snow biome photographed from the explorer's camera with the
// camera ~2, 5 and 20 m from the crown (plus dusk / dawn and a forest view across
// the LOD0 / LOD1 / impostor hand-overs), and the volcano's slopes at walking
// scale at noon and at dusk.
//   node tests/env2qa.mjs [--out dir] [--tier high] [--only name,name] [--extra '&ktx=0']
// Shots: <out>/<tier>-<view>.png (default tests/shots/env2/after)
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(opt('out', path.join(ROOT, 'tests', 'shots', 'env2', 'after')));
const TIERS = opt('tier', 'high').split(',');
const ONLY = opt('only', null)?.split(',') ?? null;
await fs.mkdir(OUT, { recursive: true });
const PORT = 6500 + Math.floor(Math.random() * 600);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });

// crown radius (m) at camera height, used to put the camera d metres outside the needles
const CROWN = { fir_tree_01: 2.6, pine_tree_01: 3.0, pine_sapling_medium: 1.6, fir_sapling_medium: 1.8 };
const conifer = (sp, d, hours, pitch = 0.1, tag = '') => ({ name: `${sp}-${String(d).padStart(2, '0')}m${tag}`, sp, d, hours, pitch });
const VIEWS = [
  conifer('fir_tree_01', 2, 13), conifer('fir_tree_01', 5, 13), conifer('fir_tree_01', 20, 13),
  conifer('fir_tree_01', 5, 19.6, 0.1, '-dusk'), conifer('fir_tree_01', 5, 6.6, 0.1, '-dawn'), conifer('fir_tree_01', 1, 13, 0.02, '-under'),
  conifer('pine_tree_01', 2, 13), conifer('pine_tree_01', 5, 13), conifer('pine_tree_01', 20, 13), conifer('pine_tree_01', 5, 19.6, 0.1, '-dusk'),
  conifer('pine_sapling_medium', 2, 13), conifer('pine_sapling_medium', 5, 13), conifer('pine_sapling_medium', 20, 13),
  conifer('fir_sapling_medium', 2, 13), conifer('fir_sapling_medium', 5, 13), conifer('fir_sapling_medium', 20, 13), conifer('fir_sapling_medium', 5, 19.6, 0.1, '-dusk'),
  // forest stands across the LOD hand-overs (70 m LOD0 -> LOD1, 150 m -> impostor)
  { name: 'snow-forest-noon', biome: 'snow', js: "window.__dino.teleport(-470, -360); window.__dino.lookAt(-410, -460); window.__dino.setView(window.__dino.view().yaw, 0.12, 7)", hours: 13 },
  { name: 'snow-forest-dusk', biome: 'snow', js: "window.__dino.teleport(-470, -360); window.__dino.lookAt(-410, -460); window.__dino.setView(window.__dino.view().yaw, 0.12, 7)", hours: 19.6 },
  { name: 'snow-forest-far', biome: 'snow', js: "window.__dino.teleport(-300, -300); window.__dino.lookAt(-410, -430); window.__dino.setView(window.__dino.view().yaw, 0.1, 7)", hours: 13 },
  { name: 'snow-forest-far-dawn', biome: 'snow', js: "window.__dino.teleport(-300, -300); window.__dino.lookAt(-410, -430); window.__dino.setView(window.__dino.view().yaw, 0.1, 7)", hours: 6.6 },
  // volcano near field: lower ash slope, mid slope by a lava channel, upper slope, gully above a channel
  ...[[13, 'noon'], [19.6, 'dusk']].flatMap(([h, t]) => [
    { name: `volc-lower-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-202.8, -386); window.__dino.lookAt(-150, -420); window.__dino.setView(window.__dino.view().yaw, 0.32, 3.2)', hours: h },
    { name: `volc-lower2-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-201, -317); window.__dino.lookAt(-150, -380); window.__dino.setView(window.__dino.view().yaw, 0.22, 4)', hours: h },
    { name: `volc-feet-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-120, -400); window.__dino.lookAt(-60, -450); window.__dino.setView(window.__dino.view().yaw, 0.7, 2.6)', hours: h },
    { name: `volc-cone-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-130, -395); window.__dino.lookAt(20, -520); window.__dino.setView(window.__dino.view().yaw, 0.18, 4.5)', hours: h },
    { name: `volc-lava-bank-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-24.9, -376.3); window.__dino.lookAt(-36.9, -381.2); window.__dino.setView(window.__dino.view().yaw, 0.3, 3.5)', hours: h },
    { name: `volc-lava-above-${t}`, biome: 'volcano', js: 'window.__dino.teleport(60.4, -313.6); window.__dino.lookAt(49.5, -312.1); window.__dino.setView(window.__dino.view().yaw, 0.35, 4)', hours: h },
    { name: `volc-slope-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-53, -437.7); window.__dino.lookAt(-119.6, -363); window.__dino.setView(window.__dino.view().yaw, 0.3, 3.2)', hours: h },
    { name: `volc-upper-${t}`, biome: 'volcano', js: 'window.__dino.teleport(-69.1, -507.3); window.__dino.lookAt(20, -520); window.__dino.setView(window.__dino.view().yaw, 0.35, 3.2)', hours: h },
  ]),
];

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
const results = {};
for (const tier of TIERS) {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/?q=${tier}${opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForSelector('#splash'); await page.waitForTimeout(400); await page.touchscreen.tap(590, 410);
  await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
  const settle = async (ms = 2500) => { await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 40000 }).catch(() => {}); await page.waitForTimeout(ms); };
  await settle(3000);
  let biome = null; const found = {};
  for (const v of VIEWS) {
    if (ONLY && !ONLY.some((o) => v.name.includes(o))) continue;
    await page.evaluate(() => { window.__dino.pause(false); window.__dino.setTime(12); });
    const want = v.sp ? 'snow' : v.biome;
    if (want !== biome) { await page.evaluate((b) => window.__dino.teleportBiome(b), want); await settle(3000); biome = want; }
    if (v.sp) {
      if (!found[v.sp]) {
        await page.evaluate((b) => window.__dino.teleportBiome(b), 'snow'); await settle(800);
        found[v.sp] = await page.evaluate((id) => window.__dino.vegNear(id), v.sp);
      }
      const p = found[v.sp]; if (!p) { console.log(v.sp, 'not found'); continue; }
      await page.evaluate(([p, d, R, pitch]) => {
        const a = window.__dino; const ang = 0.6; const boom = d < 4 ? 2.4 : d < 10 ? 4 : 7;
        const D = R + d; const off = Math.max(0.6, D - boom * Math.cos(pitch));
        a.teleport(p[0] + Math.sin(ang) * off, p[2] + Math.cos(ang) * off); a.lookAt(p[0], p[2]); a.setView(a.view().yaw, pitch, boom);
      }, [p, v.d, CROWN[v.sp], v.pitch]);
      await settle(2200);
    } else { await page.evaluate(v.js); await settle(2200); }
    await page.evaluate((h) => { const a = window.__dino; a.setTime(h); a.pause(true); a.step(2); }, v.hours);
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => { const s = window.__dino.stats(); return { triangles: s.triangles, calls: s.calls, veg: s.veg?.triangles, by: s.veg?.by }; });
    if (!args.includes("--by")) delete st.by; else st.by = Object.entries(st.by ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 14);
    results[`${tier}-${v.name}`] = st;
    await page.screenshot({ path: path.join(OUT, `${tier}-${v.name}.png`) });
    console.log(tier, v.name, JSON.stringify(st));
  }
  if (errors.length) console.log('ERRORS', errors);
  results[`${tier}-errors`] = errors;
  await ctx.close();
}
await fs.writeFile(path.join(OUT, 'stats.json'), JSON.stringify(results, null, 2));
await browser.close();
try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
console.log('done', OUT);
