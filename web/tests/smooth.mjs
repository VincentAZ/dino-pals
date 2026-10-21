// Motion smoothness: sample every land dinosaur near the explorer every frame (dt 1/30) during free
// behaviour and flag pops: body acceleration, turn-rate acceleration, head (snout) jerks.
//   SECS=20 node tests/smooth.mjs
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const SECS = +(process.env.SECS || 20);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 900, height: 600 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(450, 300);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(2000);
const scenario = process.env.SCEN || 'free';
const data = await page.evaluate(async ([SECS, scenario]) => {
  const a = window.__dino; a.setTime(13); a.pause(true); a.step(30);
  if (scenario === 'food') a.food();
  const out = {}; const N = SECS * 30;
  for (let f = 0; f < N; f++) {
    a.step(1, 1 / 30);
    if (scenario === 'taps' && f % 90 === 45) { for (const d of a.dinos.filter((x) => x.real && !x.baby)) { const p = a.screenOf(d.id); if (p && p[0] > 0 && p[0] < innerWidth && p[1] > 0 && p[1] < innerHeight) { a.tapAt(p[0], p[1]); break; } } }
    for (const s of a.motionSample()) { (out[s[0]] ??= []).push(s.slice(1)); }
    if (f % 60 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}, [SECS, scenario]);
const dt = 1 / 30; const rows = [];
for (const [id, arr] of Object.entries(data)) {
  if (arr.length < 10) continue;
  let maxAcc = 0, maxAlpha = 0, maxHeadJerk = 0, maxHeadV = 0, maxHipV = 0, atHip = 0, at = [0, 0, 0, 0];
  for (let i = 2; i < arr.length; i++) {
    const [t0, x0, z0, h0, sx0, sy0, sz0] = arr[i - 2], [t1, x1, z1, h1, sx1, sy1, sz1] = arr[i - 1], [t2, x2, z2, h2, sx2, sy2, sz2] = arr[i];
    if (t2 - t0 > 2.5 * dt) continue;   // gap (culled / not animated)
    const ax = (x2 - 2 * x1 + x0) / dt / dt, az = (z2 - 2 * z1 + z0) / dt / dt; const acc = Math.hypot(ax, az);
    const w = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
    const alpha = Math.abs(w(h1, h2) - w(h0, h1)) / dt / dt;
    // head motion relative to the body: remove root motion
    const hx0 = sx0 - x0, hz0 = sz0 - z0, hx1 = sx1 - x1, hz1 = sz1 - z1, hx2 = sx2 - x2, hz2 = sz2 - z2;
    const hv = Math.hypot(hx2 - hx1, sy2 - sy1, hz2 - hz1) / dt;
    const hj = Math.hypot(hx2 - 2 * hx1 + hx0, sy2 - 2 * sy1 + sy0, hz2 - 2 * hz1 + hz0) / dt / dt;
    const hipV = Math.abs(arr[i][9] + arr[i][8] - arr[i - 1][9] - arr[i - 1][8]) / dt;   // hip height (world) speed
    if (hipV > maxHipV) { maxHipV = hipV; atHip = i; }
    if (acc > maxAcc) { maxAcc = acc; at[0] = i; } if (alpha > maxAlpha) { maxAlpha = alpha; at[1] = i; }
    if (hj > maxHeadJerk) { maxHeadJerk = hj; at[2] = i; } if (hv > maxHeadV) { maxHeadV = hv; at[3] = i; }
  }
  let maxSide = 0;
  for (let i = 1; i < arr.length; i++) { if (arr[i][0] - arr[i - 1][0] > 1.5 * dt) continue; const dx = arr[i][1] - arr[i - 1][1], dz = arr[i][2] - arr[i - 1][2], c = Math.cos(arr[i][3]), s = Math.sin(arr[i][3]); maxSide = Math.max(maxSide, Math.abs(dx * c - dz * s) / dt); }
  // perceptual acceleration: velocity averaged over 100 ms windows (a one-frame, 1 cm hiccup is invisible)
  let maxAccW = 0, atW = 0;
  for (let i = 6; i < arr.length; i++) {
    if (arr[i][0] - arr[i - 6][0] > 6.5 * dt) continue;
    const v1x = (arr[i][1] - arr[i - 3][1]) / (3 * dt), v1z = (arr[i][2] - arr[i - 3][2]) / (3 * dt);
    const v0x = (arr[i - 3][1] - arr[i - 6][1]) / (3 * dt), v0z = (arr[i - 3][2] - arr[i - 6][2]) / (3 * dt);
    const aw = Math.hypot(v1x - v0x, v1z - v0z) / (3 * dt);
    if (aw > maxAccW) { maxAccW = aw; atW = i; }
  }
  rows.push({ id, accW: +maxAccW.toFixed(1), atW: +(atW / 30).toFixed(1), side: +maxSide.toFixed(2), n: arr.length, maxAcc: +maxAcc.toFixed(1), atAcc: +(at[0] / 30).toFixed(1), maxAlpha: +maxAlpha.toFixed(1), atAlpha: +(at[1] / 30).toFixed(1), headAcc: +maxHeadJerk.toFixed(1), atHead: +(at[2] / 30).toFixed(1), headV: +maxHeadV.toFixed(2), hipV: +maxHipV.toFixed(2), atHip: +(atHip / 30).toFixed(1), state: arr[at[2]]?.[7] });
}
rows.sort((a, b) => b.hipV - a.hipV);
for (const r of rows) console.log(JSON.stringify(r));
fs.writeFileSync(ROOT + '/tests/shots/smooth.json', JSON.stringify(data));
console.log('errors', errors.length, errors.slice(0, 3));
// pass/fail: no jolts (body acceleration), no hip dips, no sideways sliding
const worst = { accW: Math.max(...rows.map((r) => r.accW)), acc: Math.max(...rows.map((r) => r.maxAcc)), hip: Math.max(...rows.map((r) => r.hipV)), side: Math.max(...rows.map((r) => r.side)) };
const ok = worst.accW < 4 && worst.hip < 2.5 && worst.side < 0.8 && errors.length === 0;
console.log('worst', JSON.stringify(worst), ok ? 'SMOOTH PASSED' : 'SMOOTH FAILED');
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
process.exit(ok ? 0 : 1);
