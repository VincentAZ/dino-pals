// Renders tests/viewer.html (via the Vite dev server) for a species list.
//   node tests/viewer.mjs "fir_tree_01,pine_tree_01" out.png [lod] [yaw]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [species = 'island_tree_01', out = path.join(ROOT, 'tests', 'shots', 'viewer.png'), lod = '0', yaw = '0'] = process.argv.slice(2);
const PORT = 6600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }); setTimeout(() => rej(new Error('dev timeout')), 30000); });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 800 } })).newPage();
page.on('pageerror', (e) => console.log('pageerror', String(e)));
await page.goto(`http://localhost:${PORT}/tests/viewer.html?species=${species}&lod=${lod}&yaw=${yaw}`);
await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
await page.screenshot({ path: out });
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
console.log(out);
