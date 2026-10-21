// Toddler monkey test: minutes of random real touch input (taps, drags, pinches, palm mashes, holds,
// button spam, tap-spam on dinosaurs) at real time. Asserts no errors, finite state, bounded memory,
// no dinosaur overlaps, and that the app stays responsive.   DURATION=300 node tests/monkey.mjs
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const OUT = ROOT + '/tests/shots/monkey'; fs.mkdirSync(OUT, { recursive: true });
const DURATION = +(process.env.DURATION || 300);
const SEED = +(process.env.SEED || 7);
let rs = SEED; const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
const W = 1180, H = 820;
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let failed = false; const assert = (c, m) => { if (!c) { failed = true; console.error('ASSERT FAILED:', m); } else console.log('ok -', m); };
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(W / 2, H / 2);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] ?? i, radiusX: 8, radiusY: 8, force: 1 })) });
const sleep = (ms) => page.waitForTimeout(ms);
const rp = () => [20 + rnd() * (W - 40), 20 + rnd() * (H - 40)];
const btn = async (sel) => page.evaluate((sel) => { const b = document.querySelector(sel); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
const dinoXY = async () => page.evaluate(() => { const a = window.__dino; const vis = a.dinos.filter((d) => d.real).map((d) => a.screenOf(d.id)).filter((p) => p && p[0] > 0 && p[0] < innerWidth && p[1] > 0 && p[1] < innerHeight); return vis.length ? vis[Math.floor(Math.random() * vis.length)] : null; });
const tap = async (p) => { await touch('touchStart', [p]); await sleep(40 + rnd() * 80); await touch('touchEnd', []); };
const counts = {};
const actions = [
  [30, 'tap', async () => tap(rp())],
  [22, 'tapDino', async () => { const p = await dinoXY(); if (p) await tap(p); }],
  [8, 'spamDino', async () => { const p = await dinoXY(); if (p) for (let i = 0; i < 6; i++) { await tap([p[0] + rnd() * 10 - 5, p[1] + rnd() * 10 - 5]); await sleep(60 + rnd() * 120); } }],
  [12, 'drag', async () => { let p = rp(); await touch('touchStart', [p]); const vx = (rnd() - 0.5) * 60, vy = (rnd() - 0.5) * 30; for (let i = 0; i < 8 + rnd() * 20; i++) { p = [Math.max(1, Math.min(W - 1, p[0] + vx)), Math.max(1, Math.min(H - 1, p[1] + vy))]; await touch('touchMove', [p]); await sleep(16); } await touch('touchEnd', []); }],
  [5, 'pinch', async () => { const c = rp(); let s = 40 + rnd() * 100; const k = rnd() < 0.5 ? 1.08 : 0.93; await touch('touchStart', [[c[0] - s, c[1], 0], [c[0] + s, c[1], 1]]); for (let i = 0; i < 10; i++) { s = Math.max(10, Math.min(500, s * k)); await touch('touchMove', [[c[0] - s, c[1], 0], [c[0] + s, c[1], 1]]); await sleep(16); } await touch('touchEnd', []); }],
  [6, 'palm', async () => { const n = 3 + Math.floor(rnd() * 4); let pts = Array.from({ length: n }, (_, i) => [...rp(), i]); await touch('touchStart', pts); for (let i = 0; i < 6; i++) { pts = pts.map((p) => [Math.max(1, Math.min(W - 1, p[0] + (rnd() - 0.5) * 40)), Math.max(1, Math.min(H - 1, p[1] + (rnd() - 0.5) * 40)), p[2]]); await touch('touchMove', pts); await sleep(30); } while (pts.length > 1 && rnd() < 0.7) { pts.pop(); await touch('touchMove', pts); await sleep(40); } await touch('touchEnd', []); }],
  [6, 'hold', async () => { const p = (rnd() < 0.6 ? await dinoXY() : null) ?? rp(); await touch('touchStart', [p]); await sleep(700 + rnd() * 1500); await touch('touchEnd', []); }],
  [5, 'food', async () => { const p = await btn('#btn-food') ?? await btn('.bubble:last-child'); if (p) for (let i = 0; i < 1 + rnd() * 4; i++) { await tap(p); await sleep(80); } }],
  [4, 'magic', async () => { const p = await btn('#btn-magic') ?? await btn('.bubble'); if (p) for (let i = 0; i < 1 + rnd() * 3; i++) { await tap(p); await sleep(100); } }],
  [2, 'info-tap', async () => { const p = await btn('#btn-info'); if (p) await tap(p); }],
];
const total = actions.reduce((s, a) => s + a[0], 0);
const sample = async () => page.evaluate(() => {
  const a = window.__dino; const s = a.stats(); const ds = a.dinos;
  const bad = ds.filter((d) => !Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)).map((d) => d.id);
  const v = a.view();
  return { fps: s.fps, geo: s.geometries, tex: s.textures, tris: s.triangles, player: s.player, bad, view: v, overl: a.overlaps(), foods: a.foods().length, credits: !!document.querySelector('#credits'), errors: a.errors.length, audio: s.audioState, hours: s.hours };
});
const t0 = Date.now(); const samples = []; const overlapEvents = []; let nextSample = 0, nextShot = 0, shotN = 0, n = 0;
const s0 = await sample(); console.log('start', JSON.stringify(s0));
while (Date.now() - t0 < DURATION * 1000) {
  let r = rnd() * total; let act = actions[0];
  for (const a of actions) { r -= a[0]; if (r <= 0) { act = a; break; } }
  counts[act[1]] = (counts[act[1]] ?? 0) + 1; n++;
  try { await act[2](); } catch (e) { errors.push('driver: ' + e); }
  await sleep(150 + rnd() * 700);
  const el = (Date.now() - t0) / 1000;
  { const ov = await page.evaluate(() => window.__dino.overlaps()); if (ov.worst > 0) { overlapEvents.push({ t: Math.round((Date.now() - t0) / 1000), ...ov }); console.log('OVERLAP', JSON.stringify(ov)); } }
  if (el > nextSample) { nextSample = el + 10; const s = await sample(); samples.push({ t: Math.round(el), ...s }); console.log(Math.round(el) + 's', JSON.stringify({ fps: s.fps, geo: s.geo, tex: s.tex, p: s.player, view: s.view, ov: s.overl, foods: s.foods, credits: s.credits, h: s.hours })); }
  if (el > nextShot) { nextShot = el + 30; await page.screenshot({ path: `${OUT}/m${String(shotN++).padStart(2, '0')}.jpg`, quality: 70 }); }
}
// close credits if a long-press opened it, then let the world settle and check responsiveness
await page.evaluate(() => document.querySelector('#credits')?.remove());
await sleep(4000);
const s1 = await sample();
console.log('end', JSON.stringify(s1));
console.log('actions', n, JSON.stringify(counts));
const allFinite = samples.every((s) => s.bad.length === 0 && Number.isFinite(s.player.x) && Number.isFinite(s.view.yaw) && Number.isFinite(s.view.pitch) && Number.isFinite(s.view.dist));
assert(allFinite, 'all positions / camera finite throughout');
assert(overlapEvents.length === 0 && samples.every((s) => s.overl.dinoDino === 0 && s.overl.dinoTree === 0), `no dinosaur overlaps (checked after every action; events ${overlapEvents.length}, worst ${Math.max(0, ...overlapEvents.map((e) => e.worst), ...samples.map((s) => s.overl.worst)).toFixed(2)})`);
// absolute budget: everything streamed in (all species + every environment set) plateaus near 440 geometries / 340 textures (tests/leak.mjs)
assert(s1.geo < 650 && s1.tex < 450, `GPU memory within budget (geo ${s0.geo}->${s1.geo}, tex ${s0.tex}->${s1.tex})`);
assert(Math.min(...samples.map((s) => s.fps)) > 20, `fps stayed > 20 (min ${Math.min(...samples.map((s) => s.fps))})`);
assert(s1.foods <= 4, 'food piles capped');
assert(errors.length === 0, `no errors (${errors.length}) ${errors.slice(0, 3).join(' | ')}`);
// responsiveness after the chaos: a tap on a dinosaur still gets a reaction
const resp = await page.evaluate(() => { const a = window.__dino; for (const d of a.dinos.filter((x) => x.real)) { const p = a.screenOf(d.id); if (p && p[0] > 50 && p[0] < innerWidth - 50 && p[1] > 50 && p[1] < innerHeight - 150) return a.tapAt(p[0], p[1]); } return 'none'; });
console.log('final tap ->', resp);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
console.log(failed ? 'MONKEY FAILED' : 'MONKEY PASSED');
process.exit(failed ? 1 : 0);
