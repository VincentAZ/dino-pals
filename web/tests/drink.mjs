// Drinking: put a Triceratops near shallow water, make it thirsty, and film it walking to the edge and drinking.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUT = ROOT + '/tests/shots/drink'; fs.mkdirSync(OUT, { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
const sp = process.env.SP || 'triceratops';
// shallow lake / pool edge with dry ground next to it
const spot = await page.evaluate(() => { const a = window.__dino; for (const [cx, cz] of [a.biomes.lake, a.biomes.swamp]) for (let r = 0; r < 260; r += 4) for (let k = 0; k < 36; k++) { const ang = k / 36 * Math.PI * 2; const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r; const g = a.ground(x, z); if (g.water < 0 || g.kind === 'sea') continue; const dep = g.water - g.h; if (dep < 0.05 || dep > 0.25) continue; const ux = -Math.cos(ang), uz = -Math.sin(ang); const d2 = a.ground(x - ux * 14, z - uz * 14); if (d2.water < 0 && d2.h > 0.4) return { x, z, bx: x - ux * 14, bz: z - uz * 14 }; } return null; });
console.log('spot', JSON.stringify(spot));
const id = await page.evaluate(([spot, sp]) => { const a = window.__dino; a.pause(true); a.setTime(11); a.teleport(spot.bx + 6, spot.bz + 6); const me = a.dinos.find((d) => d.species === sp && !d.baby); let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x - spot.bx, d.z - spot.bz) < 80) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true }); a.command(me.id, { place: [spot.bx, spot.bz, 0], stop: true }); return me.id; }, [spot, sp]);
for (let i = 0; i < 150; i++) { const r = await page.evaluate((id) => { window.__dino.step(3); return window.__dino.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
await page.evaluate(([id, spot]) => { const a = window.__dino; a.command(id, { place: [spot.bx, spot.bz, 0], stop: true }); a.step(10); a.command(id, { release: true }); a.makeThirsty(id); a.watch(id, -1.3, 0.3, 11, 0.3); }, [id, spot]);
const log = [];
for (let f = 0; f < 10; f++) { await page.evaluate(() => window.__dino.step(45)); await page.screenshot({ path: `${OUT}/${sp}_${f}.png` }); log.push(await page.evaluate((id) => { const l = window.__dino.loco(id); return `${l.state}@${l.pos}`; }, id)); }
console.log(log.join(' | '));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
