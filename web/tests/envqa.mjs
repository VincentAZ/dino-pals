// Environment QA: renders a fixed set of views (start, grass close-up, every
// biome, volcano from the meadow and from its slope, four times of day) for the
// high and low tier, records stats() and an estimate of GPU texture memory.
//   node tests/envqa.mjs [--tag after] [--tiers high,low] [--only start,grass]
// Shots: tests/shots/env/<tag>/<tier>-<view>.png, summary in <tag>/stats.json
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const TAG = opt('tag', 'after');
const TIERS = opt('tiers', 'high,low').split(',');
const ONLY = opt('only', null)?.split(',') ?? null;
const OUT = opt('out', null) ? path.resolve(opt('out', null)) : path.join(ROOT, 'tests', 'shots', 'env', TAG);
await fs.mkdir(OUT, { recursive: true });
const PORT = 5200 + Math.floor(Math.random() * 600);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('preview timeout')), 20000); });

// Tally GPU texture allocations by wrapping the WebGL2 entry points.
const GL_TRACK = () => {
  const P = WebGL2RenderingContext.prototype;
  const sizes = new Map(); const bound = new Map(); let unit = 0;
  const bpp = (fmt, type) => {
    // internal formats (sized) or format+type
    const map = { 0x8058: 4, 0x8C43: 4, 0x881A: 8, 0x8814: 16, 0x822E: 4, 0x8229: 1, 0x822B: 2, 0x8230: 8, 0x822F: 2, 0x81A6: 4, 0x8CAC: 4, 0x88F0: 4, 0x8D48: 4, 0x8C3A: 4, 0x8C3D: 4,
      // compressed: BPTC, S3TC, ETC2, ASTC 4x4 (bytes per texel)
      0x8E8C: 1, 0x8E8D: 1, 0x83F3: 1, 0x8C4F: 1, 0x83F1: 0.5, 0x8C4C: 0.5, 0x9278: 1, 0x9279: 1, 0x9274: 0.5, 0x9275: 0.5, 0x93B0: 1, 0x93D0: 1 };
    if (map[fmt]) return map[fmt];
    if (fmt === 0x1908) return type === 0x1406 ? 16 : type === 0x140B ? 8 : 4; // RGBA
    if (fmt === 0x1907) return type === 0x1406 ? 12 : 3; // RGB
    if (fmt === 0x1903) return type === 0x1406 ? 4 : 1; // RED
    return 4;
  };
  const key = (target) => `${unit}:${target === 0x8C1A ? 'arr' : target === 0x806F ? '3d' : target >= 0x8515 && target <= 0x851A ? 'cube' : '2d'}`;
  let desc = '';
  const add = (target, level, bytes) => {
    const tex = bound.get(key(target)); if (!tex) return;
    let s = sizes.get(tex); if (!s) { s = { levels: new Map(), mip: false }; sizes.set(tex, s); }
    const face = target >= 0x8515 && target <= 0x851A ? target : 0;
    s.levels.set(`${face}:${level}`, bytes);
    if (level === 0 || s.levels.size === 1) s.desc = desc;
  };
  const oAct = P.activeTexture; P.activeTexture = function (u) { unit = u - 0x84C0; return oAct.call(this, u); };
  const oBind = P.bindTexture; P.bindTexture = function (t, tex) { bound.set(key(t), tex); return oBind.call(this, t, tex); };
  const oDel = P.deleteTexture; P.deleteTexture = function (tex) { sizes.delete(tex); return oDel.call(this, tex); };
  const oT2 = P.texImage2D; P.texImage2D = function (...a) {
    const [target, level, ifmt] = a;
    let w, h, fmt, type;
    if (a.length >= 8) { w = a[3]; h = a[4]; fmt = a[6]; type = a[7]; } else { const src = a[5]; w = src.width || src.videoWidth || 0; h = src.height || src.videoHeight || 0; fmt = a[3]; type = a[4]; }
    desc = `2d ${w}x${h} f${ifmt.toString(16)}`; add(target, level, w * h * bpp(ifmt, type));
    return oT2.apply(this, a);
  };
  const oT3 = P.texImage3D; P.texImage3D = function (...a) { const [target, level, ifmt, w, h, d] = a; desc = `3d ${w}x${h}x${d} f${ifmt.toString(16)}`; add(target, level, w * h * d * bpp(ifmt, a[8])); return oT3.apply(this, a); };
  const oS2 = P.texStorage2D; P.texStorage2D = function (target, levels, ifmt, w, h) {
    let tot = 0, ww = w, hh = h; for (let l = 0; l < levels; l++) { tot += ww * hh * bpp(ifmt); ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1); }
    const faces = target === 0x8513 ? 6 : 1; desc = `s2 ${w}x${h} L${levels} f${ifmt.toString(16)}`; add(target === 0x8513 ? 0x8513 : target, 0, tot * faces); return oS2.call(this, target, levels, ifmt, w, h);
  };
  const oS3 = P.texStorage3D; P.texStorage3D = function (target, levels, ifmt, w, h, d) {
    let tot = 0, ww = w, hh = h; for (let l = 0; l < levels; l++) { tot += ww * hh * d * bpp(ifmt); ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1); }
    desc = `s3 ${w}x${h}x${d} L${levels} f${ifmt.toString(16)}`; add(target, 0, tot); return oS3.call(this, target, levels, ifmt, w, h, d);
  };
  const oC2 = P.compressedTexImage2D; P.compressedTexImage2D = function (...a) { add(a[0], a[1], a[6]?.byteLength ?? 0); return oC2.apply(this, a); };
  const oGM = P.generateMipmap; P.generateMipmap = function (target) { const tex = bound.get(key(target)); const s = tex && sizes.get(tex); if (s) s.mip = true; return oGM.call(this, target); };
  window.__texList = () => { const h = {}; for (const s of sizes.values()) { let b = 0; for (const v of s.levels.values()) b += v; const k = s.desc + (s.mip ? ' mip' : ''); h[k] = h[k] || [0, 0]; h[k][0]++; h[k][1] += b / 1048576; } return Object.entries(h).sort((a, b) => b[1][1] - a[1][1]).map(([k, v]) => `${k}: n=${v[0]} ${v[1].toFixed(1)}MB`); };
  window.__texMB = () => { let tot = 0; for (const s of sizes.values()) { let b = 0; for (const v of s.levels.values()) b += v; tot += s.mip && s.levels.size === 1 ? b * 4 / 3 : b; } return +(tot / 1048576).toFixed(1); };
};

const VIEWS = [
  { name: 'start', js: '' },
  { name: 'grass', js: 'window.__dino.setView(window.__dino.view().yaw, 0.35, 3)' },
  { name: 'grass2', js: 'window.__dino.teleport(-30, 40); window.__dino.lookAt(-30, 0); window.__dino.setView(window.__dino.view().yaw, 0.28, 4)' },
  { name: 'jungle', js: "window.__dino.teleportBiome('jungle')" },
  { name: 'volcano-meadow', js: 'window.__dino.teleport(0, -60); window.__dino.lookAt(20, -520); window.__dino.setView(window.__dino.view().yaw, 0.06, 7)' },
  { name: 'volcano-slope', js: 'window.__dino.teleport(-53, -437.7); window.__dino.lookAt(-119.6, -363); window.__dino.setView(window.__dino.view().yaw, 0.25, 9)' },
  { name: 'volcano-crater', js: 'window.__dino.teleport(20, -497); window.__dino.lookAt(20, -520); window.__dino.setView(window.__dino.view().yaw, 0.55, 13)' },
  { name: 'volcano-biome', js: "window.__dino.teleportBiome('volcano')" },
  { name: 'swamp', js: "window.__dino.teleportBiome('swamp')" },
  { name: 'canyon', js: "window.__dino.teleportBiome('canyon')" },
  { name: 'beach', js: "window.__dino.teleportBiome('beach')" },
  { name: 'snow', js: "window.__dino.teleportBiome('snow')" },
  { name: 'lake', js: "window.__dino.teleportBiome('lake')" },
  { name: 'trees', js: 'window.__dino.teleport(40, 60); window.__dino.lookAt(120, 60); window.__dino.setView(window.__dino.view().yaw, 0.1, 6)' },
  { name: 'time-06', js: "window.__dino.teleportBiome('meadow')", hours: 6.3 },
  { name: 'time-13', js: "window.__dino.teleportBiome('meadow')", hours: 13 },
  { name: 'time-20', js: "window.__dino.teleportBiome('meadow')", hours: 19.6 },
  { name: 'time-01', js: "window.__dino.teleportBiome('meadow')", hours: 1 },
];

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
const summary = {};
for (const tier of TIERS) {
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript(GL_TRACK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/?q=${tier}${opt('extra', '')}`, { waitUntil: 'load' });
  await page.waitForSelector('#splash', { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.touchscreen.tap(590, 410);
  await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
  const tReady = Date.now() - t0;
  // bytes fetched by the time the world is shown, split by kind
  const initial = await page.evaluate(() => { const out = { total: 0, env: 0, lazyKtx2: 0, dinos: 0, code: 0, other: 0 }; for (const e of performance.getEntriesByType('resource')) { const b = e.encodedBodySize || e.transferSize || 0; out.total += b; if (e.name.endsWith('.ktx2') || e.name.includes('/basis/')) out.lazyKtx2 += b; else if (e.name.includes('/assets/env/')) out.env += b; else if (e.name.includes('/assets/dinos/') || e.name.includes('/draco/')) out.dinos += b; else if (/\.(js|css|wasm)/.test(e.name)) out.code += b; else out.other += b; } for (const k in out) out[k] = +(out[k] / 1048576).toFixed(2); return out; });
  console.log(tier, 'initial MB before world shown', JSON.stringify(initial));
  const settle = async (ms = 2500) => { await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 40000 }).catch(() => {}); await page.waitForTimeout(ms); };
  await settle(3500);
  summary[tier] = { readyMs: tReady, initialMB: initial, views: {} };
  for (const v of VIEWS) {
    if (ONLY && !ONLY.includes(v.name)) continue;
    await page.evaluate(() => { window.__dino.pause(false); window.__dino.setTime(10); });
    if (v.js) { await page.evaluate(v.js); await settle(v.name.startsWith('time') ? 800 : 2500); }
    await page.evaluate((h) => { const a = window.__dino; a.setTime(h); a.pause(true); a.step(2); }, v.hours ?? 10);
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => ({ ...window.__dino.stats(), texMB: window.__texMB ? window.__texMB() : null }));
    summary[tier].views[v.name] = { triangles: st.triangles, calls: st.calls, texMB: st.texMB, textures: st.textures, veg: st.veg?.triangles, terrain: st.terrain?.triangles, grass: st.grassTris };
    await page.screenshot({ path: path.join(OUT, `${tier}-${v.name}.png`) });
    console.log(tier, v.name, JSON.stringify(summary[tier].views[v.name]));
    if (args.includes('--texlist')) console.log((await page.evaluate(() => window.__texList())).join('\n'));
    if (args.includes('--by')) console.log(JSON.stringify(Object.entries(st.veg?.by ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 24)));
    if (v.name === 'start') { await page.evaluate(() => window.__dino.pause(false)); }
  }
  await page.evaluate(() => window.__dino.pause(false));
  summary[tier].texList = await page.evaluate(() => window.__texList());
  summary[tier].errors = [...errors, ...(await page.evaluate(() => window.__dino.errors))];
  if (summary[tier].errors.length) console.log('ERRORS', summary[tier].errors);
  await ctx.close();
}
await fs.writeFile(path.join(OUT, 'stats.json'), JSON.stringify(summary, null, 2));
await browser.close();
try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
console.log('done', OUT);
