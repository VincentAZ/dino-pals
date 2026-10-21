// Splash screen in landscape and portrait (after the hero image has loaded).
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');   // web/ (this script lives in web/tests or web/scripts)
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist'] });
for (const [name, w, h] of [['land', 1180, 820], ['port', 820, 1180]]) {
  const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
  await page.goto(`http://localhost:${PORT}/`); await page.waitForSelector('#splash.ready', { timeout: 20000 }); await page.waitForTimeout(1200);
  await page.screenshot({ path: `${ROOT}/tests/shots/splash-${name}.png` });
}
console.log('ok');
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
