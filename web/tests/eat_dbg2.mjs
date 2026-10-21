import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready);
const SP = process.argv[2] || 'stegosaurus';
const id = await page.evaluate((sp) => { const a = window.__dino; a.pause(true); const d = a.dinos.find((x) => x.species === sp); a.command(d.id, { place: [-20, -40, 0], stop: true }); return d.id; }, SP);
for (let i = 0; i < 100; i++) { const ok = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (ok) break; await page.waitForTimeout(60); }
// make it eat by the "second tap" path (triggerAction eat) through tapAt twice is hard; call command: place then use tap API via screen
await page.evaluate((id) => { const a = window.__dino; a.teleport(-20, -30); a.lookAt(-20, -40); a.step(5); }, id);
const xy = await page.evaluate((id) => window.__dino.screenOf(id), id);
console.log('tap1', await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), xy));
await page.evaluate(() => window.__dino.step(80));
console.log('tap2', await page.evaluate(([x, y]) => window.__dino.tapAt(x, y), xy));
for (let i = 0; i < 14; i++) console.log(JSON.stringify(await page.evaluate((id) => { const a = window.__dino; a.step(9); const p = a.probeDino(id); return { clip: p.clip, state: p.state, st: p.stateTime, reachW: p.reachW, snoutY: p.snoutWorldY }; }, id)));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
