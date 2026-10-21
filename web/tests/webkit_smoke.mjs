// WebKit (Safari engine) smoke: load, start, run 20 s, tap a dinosaur, drop food; report JS errors and GL info.
import { webkit, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('127.0.0.1')) res(); }));
const browser = await webkit.launch({ headless: true, env: { ...process.env } });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [], warns = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 400)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); if (m.type() === 'warning') warns.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/?q=low`, { waitUntil: 'load' });
const gl = await page.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); if (!g) return 'NO WEBGL2'; const d = g.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); });
console.log('webgl2:', gl, '| UA:', await page.evaluate(() => navigator.userAgent.slice(0, 120)));
await page.waitForSelector('#splash', { timeout: 30000 }); await page.waitForTimeout(300);
await page.touchscreen.tap(590, 410);
const ok = await page.waitForFunction(() => window.__dino && window.__dino.ready, null, { timeout: 120000 }).then(() => true).catch(() => false);
console.log('ready:', ok);
if (ok) {
  await page.waitForTimeout(20000);
  const s = await page.evaluate(() => { const a = window.__dino; const st = a.stats(); return { fps: st.fps, tris: st.triangles, dinos: st.dinos, audio: a.audioStats(), veg: st.vegLoaded }; });
  console.log('stats:', JSON.stringify(s));
  const tap = await page.evaluate(() => { const a = window.__dino; const d = a.dinos.find((x) => x.real && x.awake); if (!d) return 'no dino'; const xy = a.screenOf(d.id); return xy ? a.tapAt(xy[0], xy[1]) : 'offscreen'; });
  console.log('tap:', tap);
  await page.evaluate(() => window.__dino.food());
  await page.waitForTimeout(8000);
  await page.screenshot({ path: ROOT + '/tests/shots/webkit.png' });
}
console.log('errors:', errors.length); for (const e of errors.slice(0, 12)) console.log('  ', e);
console.log('warnings:', warns.length); for (const w of [...new Set(warns)].slice(0, 6)) console.log('  ', w);
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
