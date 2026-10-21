// Rapid repeated taps on one dinosaur (what a toddler actually does): count restarts and sounds.
import { chromium, devices } from 'playwright';
import { spawn } from 'node:child_process';
const ROOT = '/home/vincent/Repos/dinos/web';
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(590, 410);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
for (const sp of (process.env.SP || 'trex,triceratops,velociraptor').split(',')) {
  const id = await page.evaluate((sp) => {
    const a = window.__dino; a.pause(true); a.setTime(13); a.teleport(0, 0); a.setView(0, 0.2, 7);
    const me = a.dinos.find((d) => d.species === sp && !d.baby);
    let k = 0; for (const d of a.dinos) if (d.id !== me.id && Math.hypot(d.x, d.z) < 120) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true });
    a.command(me.id, { place: [0, -16, 0], stop: true }); return me.id;
  }, sp);
  for (let i = 0; i < 100; i++) { const r = await page.evaluate((id) => { const a = window.__dino; a.step(3); return a.dinos.find((d) => d.id === id).real; }, id); if (r) break; await page.waitForTimeout(50); }
  await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [0, -16, 0], stop: true }); a.command(id, { release: true }); a.step(30); }, id);
  // 12 taps, one every 0.25 s of game time, then 6 s to settle
  const log = await page.evaluate((id) => {
    const a = window.__dino; const out = []; const plays0 = JSON.stringify(a.audioStats().plays);
    const sounds = () => Object.values(a.audioStats().plays).reduce((s, v) => s + v, 0);
    const s0 = sounds();
    for (let t = 0; t < 12; t++) { const xy = a.screenOf(id); const r = xy ? a.tapAt(xy[0], xy[1]) : 'offscreen'; const l = a.loco(id); out.push(`${r}:${l.state}@${l.ph}`); a.step(8, 1 / 30); }
    const mid = sounds() - s0;
    const states = []; for (let t = 0; t < 30; t++) { a.step(6, 1 / 30); const l = a.loco(id); states.push(`${l.state}@${l.ph}`); }
    return { taps: out, voicesDuringSpam: mid, after: states.filter((_, i) => i % 3 === 0), plays0 };
  }, id);
  console.log(sp, JSON.stringify(log));
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
