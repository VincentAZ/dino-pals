// Headless smoke test: serves dist with vite preview, drives the app on iPad
// viewports, takes screenshots into tests/shots/, and asserts no console errors.
//   node tests/smoke.mjs [--swiftshader]
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'tests', 'shots');
const PORT = 4173 + Math.floor(Math.random() * 500);
const swift = process.argv.includes('--swiftshader');
await fs.mkdir(SHOTS, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); server.stderr.on('data', (d) => process.stderr.write(d)); setTimeout(() => rej(new Error('preview start timeout')), 20000); });
const urlFor = (q) => `http://localhost:${PORT}/?q=${q}`;

const gpuArgs = swift
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-features=Vulkan'];
const browser = await chromium.launch({ headless: true, args: [...gpuArgs, '--autoplay-policy=no-user-gesture-required'] });
const results = { errors: [], shots: [], stats: {} };
let failed = false;
const assert = (cond, msg) => { if (!cond) { failed = true; console.error('ASSERT FAILED:', msg); } else console.log('ok -', msg); };

async function run(viewport, label, full, tier = 'high') {
  const url = urlFor(tier);
  const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const errors = []; const consoleLog = [];
  page.on('console', (m) => { consoleLog.push(`[${m.type()}] ${m.text()}`); if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('#splash', { timeout: 20000 });
  await page.screenshot({ path: path.join(SHOTS, `${label}-00-splash.png`) });
  await page.waitForTimeout(500);
  await page.touchscreen.tap(viewport.width / 2, viewport.height / 2);
  await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 60000 });
  const settle = async (ms = 1500, max = 25000) => {
    const t0 = Date.now();
    await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: max }).catch(() => {});
    await page.waitForTimeout(ms + Math.max(0, 0 * (Date.now() - t0)));
  };
  const shot = async (name) => { const p = path.join(SHOTS, `${label}-${name}.png`); await page.screenshot({ path: p }); results.shots.push(p); console.log('shot', p); };
  const stats = async () => page.evaluate(() => window.__dino.stats());
  await settle(3000, 40000);
  await shot('01-start');
  results.stats[`${label}-start`] = await stats();
  console.log('stats', JSON.stringify(results.stats[`${label}-start`]));
  if (full) {
    for (const [i, b] of ['jungle', 'volcano', 'beach', 'swamp', 'snow', 'canyon', 'lake'].entries()) {
      await page.evaluate((id) => window.__dino.teleportBiome(id), b);
      await settle(2000);
      await shot(`02-${i}-${b}`);
      results.stats[`${label}-${b}`] = await stats();
      const err = await page.evaluate(() => window.__dino.errors);
      assert(err.length === 0, `no runtime errors after ${b}`);
    }
    await page.evaluate(() => window.__dino.teleportBiome('meadow'));
    await settle(1500);
    for (const h of [6, 13, 20, 1]) {
      await page.evaluate((h) => window.__dino.setTime(h), h);
      await page.waitForTimeout(1200);
      await shot(`03-time-${String(h).padStart(2, '0')}`);
    }
    await page.evaluate(() => window.__dino.setTime(10));
    await page.waitForTimeout(600);
    // tap a dinosaur: teleport next to the nearest awake land dino and look at it
    const target = await page.evaluate(() => {
      const list = window.__dino.dinos.filter((d) => d.species !== 'ornithocheirus' && d.species !== 'pistosaurus' && d.species !== 'mosasaurus');
      const d = list.reduce((a, b) => (Math.hypot(a.x, a.z) < Math.hypot(b.x, b.z) ? a : b));
      window.__dino.teleport(d.x + 9, d.z + 9);
      window.__dino.lookAt(d.x, d.z);
      return d.id;
    });
    await settle(1500);
    const sc = await page.evaluate((id) => window.__dino.screenOf(id), target);
    assert(sc && sc[0] > 0 && sc[0] < viewport.width && sc[1] > 0 && sc[1] < viewport.height, `dino ${target} is on screen at ${JSON.stringify(sc)}`);
    const state = await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), sc ?? [viewport.width / 2, viewport.height / 2]);
    assert(state === 'roar', `tapAt returned roar (got ${state})`);
    await page.waitForTimeout(400);
    const tappedId = await page.evaluate(() => window.__dino.lastTapped);
    const dstate = await page.evaluate((id) => window.__dino.dinos.find((d) => d.id === id)?.state, tappedId);
    assert(dstate === 'roar', `tapped dino ${tappedId} state is roar (got ${dstate})`);
    await shot('04-tap-roar');
    await page.waitForTimeout(2800);
    const sc2 = await page.evaluate((id) => window.__dino.screenOf(id), target);
    const state2 = await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), sc2 ?? sc);
    console.log('second action:', state2);
    await page.waitForTimeout(600);
    await shot('05-tap-second');
    await page.evaluate(() => window.__dino.food());
    await page.waitForTimeout(1200);
    await shot('06-food');
    await page.evaluate(() => window.__dino.magic());
    await page.waitForTimeout(2500);
    await shot('07-magic');
    // hold on a dinosaur -> follow
    const sc3 = await page.evaluate((id) => window.__dino.screenOf(id), target);
    const hold = await page.evaluate(([x, y]) => window.__dino.holdAt(x, y), sc3 ?? sc ?? [viewport.width / 2, viewport.height / 2]);
    assert(hold === 'follow', `holdAt returned follow (got ${hold})`);
    // real pointer gestures: drag to orbit, then tap on the ground to walk
    const v0 = await page.evaluate(() => window.__dino.view());
    await page.mouse.move(viewport.width * 0.5, viewport.height * 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) { await page.mouse.move(viewport.width * 0.5 + i * 25, viewport.height * 0.5, { steps: 2 }); }
    await page.mouse.up();
    await page.waitForTimeout(300);
    const v1 = await page.evaluate(() => window.__dino.view());
    assert(Math.abs(v1.yaw - v0.yaw) > 0.2, `drag orbits the camera (yaw ${v0.yaw.toFixed(2)} -> ${v1.yaw.toFixed(2)})`);
    const p0 = await page.evaluate(() => window.__dino.stats().player);
    // find a ground spot (not a dinosaur) along the lower part of the screen and tap it with a real touch
    let walkPt = null;
    // (a dinosaur may legitimately stand in front of the camera: search more of the lower screen)
    outer: for (const fy of [0.8, 0.9, 0.7]) for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) { const r = await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), [viewport.width * fx, viewport.height * fy]); if (r === 'walk') { walkPt = fx; break outer; } }
    assert(walkPt !== null, `found a ground tap spot (${walkPt})`);
    await page.evaluate(() => window.__dino.teleport(window.__dino.stats().player.x, window.__dino.stats().player.z));
    await page.touchscreen.tap(viewport.width * (walkPt ?? 0.5), viewport.height * 0.8);
    await page.waitForTimeout(1500);
    const p1 = await page.evaluate(() => window.__dino.stats().player);
    assert(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.5, `tap on the ground walks the explorer (${p0.x},${p0.z} -> ${p1.x},${p1.z})`);
    await shot('08-walk');
  } else if (tier === 'low') {
    for (const [i, b] of ['jungle', 'volcano'].entries()) { await page.evaluate((id) => window.__dino.teleportBiome(id), b); await settle(2000); await shot(`02-${i}-${b}`); }
  } else {
    await page.evaluate(() => window.__dino.food());
    await page.waitForTimeout(1000);
    await shot('02-food');
  }
  await fs.writeFile(path.join(SHOTS, `${label}-console.log`), consoleLog.join('\n'));
  results.stats[`${label}-end`] = await stats();
  console.log('final stats', JSON.stringify(results.stats[`${label}-end`]));
  const runtimeErrors = await page.evaluate(() => window.__dino.errors);
  const allErrors = [...errors, ...runtimeErrors];
  assert(allErrors.length === 0, `zero console/runtime errors (${label})` + (allErrors.length ? `\n${allErrors.join('\n')}` : ''));
  results.errors.push(...allErrors);
  await ctx.close();
}

try {
  await run({ width: 1180, height: 820 }, 'land', true);
  await run({ width: 820, height: 1180 }, 'port', false);
  await run({ width: 1180, height: 820 }, 'low', false, 'low');
} catch (e) { failed = true; console.error(e); }
await browser.close();
try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
await fs.writeFile(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
console.log(failed ? 'SMOKE: FAILED' : 'SMOKE: PASSED');
process.exit(failed ? 1 : 0);
