// Every request for a data file under /assets (models, textures, audio, json) must carry ?v=<content hash>,
// because /assets is served as immutable. Vite's own hashed bundles (index-XXXX.js etc.) are exempt.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const publicFiles = new Set(); const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else publicFiles.add('/' + path.relative(path.join(ROOT, 'public'), p).split(path.sep).join('/')); } }; walk(path.join(ROOT, 'public', 'assets'));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
const versioned = [], bare = [];
page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol !== 'http:' || !u.pathname.startsWith('/assets/')) return; if (!publicFiles.has(u.pathname)) return; (u.searchParams.get('v') ? versioned : bare).push(u.pathname); });
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.evaluate(() => { window.__dino.food(); window.__dino.teleportBiome('jungle'); });
await page.waitForTimeout(6000);
console.log('versioned data requests', versioned.length, 'bare', bare.length, bare.slice(0, 10));
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
const ok = bare.length === 0 && versioned.length > 20 && errors.length === 0;
console.log(ok ? 'CACHEBUST PASSED' : 'CACHEBUST FAILED'); process.exit(ok ? 0 : 1);
