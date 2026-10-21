// Triangle budget probe: crowd several dinosaurs around the explorer (as taps, food and holds do) and
// report what draws the triangles, from the child's usual camera and a zoomed-out one.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=${process.env.Q || 'high'}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
const r = await page.evaluate(async () => {
  const a = window.__dino; const out = {};
  a.setTime(13);
  for (let i = 0; i < 40; i++) { a.step(2); await new Promise((r) => setTimeout(r, 50)); }
  out.start = a.probeTris();
  // gather: every land adult within 150 m walks up close (what food + roars do)
  a.setView(0, 0.2, 7); out.startView = a.probeTris();
  const land = a.dinos.filter((d) => Math.hypot(d.x, d.z) < 150 && d.y > -1);
  let k = 0; for (const d of land) { const ang = (k++ / land.length) * Math.PI * 2; a.command(d.id, { place: [Math.sin(ang) * 18, Math.cos(ang) * 18, ang + Math.PI], stop: true }); }
  for (let i = 0; i < 60; i++) { a.step(2); await new Promise((r) => setTimeout(r, 50)); }
  a.setView(0, 0.2, 7); out.crowd7 = a.probeTris();
  a.setView(0, 0.45, 16); out.crowd16 = a.probeTris();
  out.n = land.length;
  return out;
});
console.log(JSON.stringify(r, null, 1));
console.log('errors', errors.length);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
