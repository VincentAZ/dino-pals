// GPU texture memory with every dinosaur species and the food pile loaded, plus the start view.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import { GL_TRACK } from './gltrack.mjs';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const ctx = await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await ctx.addInitScript(GL_TRACK);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
let bytes = 0; const byUrl = new Map(); page.on('response', async (r) => { if (r.url().startsWith('blob:') || r.url().startsWith('data:')) return; try { const b = await r.body(); bytes += b.length; const u = new URL(r.url()).pathname; byUrl.set(u, (byUrl.get(u) ?? 0) + b.length); } catch { /* */ } });
await page.goto(`http://localhost:${PORT}/?q=${process.env.Q || 'high'}`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(3000);
const start = await page.evaluate(() => ({ tex: window.__texMB(), list: window.__texList().slice(0, 8) }));
const startBytes = bytes;
const startTop = [...byUrl.entries()].sort((a, b) => b[1] - a[1]);
const groups = {}; for (const [u, n] of startTop) { const g = u.split('/').slice(0, 4).join('/'); groups[g] = (groups[g] ?? 0) + n; }
console.log('start downloads by folder (MB):', JSON.stringify(Object.fromEntries(Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 1048576).toFixed(1)]))));
console.log('largest:', startTop.slice(0, 12).map(([u, n]) => u + ' ' + (n / 1048576).toFixed(2)).join(' | '));
// bring every species close so all load, and drop food
await page.evaluate(async () => {
  const a = window.__dino; a.food();
  const seen = new Set(); let k = 0;
  for (const d of a.dinos) { if (seen.has(d.species)) continue; seen.add(d.species); const ang = (k++ / 16) * Math.PI * 2; a.command(d.id, { place: [Math.sin(ang) * 30, Math.cos(ang) * 30, 0], stop: true }); }
});
await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(4000);
const all = await page.evaluate(() => ({ tex: window.__texMB(), list: window.__texList().slice(0, 12), real: window.__dino.dinos.filter((d) => d.real).length, mem: window.__dino.probeMem() }));
console.log('start view: GPU textures', start.tex, 'MB, downloaded', (startBytes / 1048576).toFixed(1), 'MB');
console.log('all species + food: GPU textures', all.tex, 'MB, downloaded', (bytes / 1048576).toFixed(1), 'MB, real dinos', all.real, 'dino textures', all.mem.dinoTextures);
for (const l of all.list) console.log('   ', l);
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
