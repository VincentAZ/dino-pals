import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready);
const sps = ['trex','triceratops','stegosaurus','paluxysaurus','velociraptor','sauropelta','ankylosaurus','iguanodon','spinosaurus','carnotaurus','allosaurus','pachycephalosaurus'];
await page.evaluate((sps) => { const a = window.__dino; a.pause(true); sps.forEach((sp, i) => { const d = a.dinos.find((x) => x.species === sp); a.command(d.id, { place: [-60 + i * 12, -60, 0], stop: true }); }); }, sps);
for (let i = 0; i < 200; i++) { const ok = await page.evaluate((sps) => { const a = window.__dino; a.step(3); return sps.every((sp) => a.dinos.find((d) => d.species === sp).real); }, sps); if (ok) break; await page.waitForTimeout(80); }
for (const sp of sps) console.log(sp, JSON.stringify(await page.evaluate((sp) => window.__dino.probeDino(window.__dino.dinos.find((d) => d.species === sp).id), sp)));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
