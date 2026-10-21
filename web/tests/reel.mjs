// Demo reel at 30 fps (stepped, so every frame is exact): walking, turning, a parent with its baby,
// feeding from the child's camera, tap → roar → stomp. Frames → H.264 MP4 with ffmpeg.
//   node tests/reel.mjs [out.mp4]
import { chromium, devices } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const ROOT = '/home/vincent/Repos/dinos/web';
const OUTMP4 = process.argv[2] || '/home/vincent/Repos/dinos/demo/dino-pals-reel.mp4';
const FR = ROOT + '/tests/shots/reel'; fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
fs.mkdirSync(OUTMP4.replace(/\/[^/]*$/, ''), { recursive: true });
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const W = 1180, H = 820;
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: W, height: H }, deviceScaleFactor: 1.5, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(W / 2, H / 2);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(2000);
await page.evaluate(() => { const a = window.__dino; a.setTime(10.5); a.pause(true); });
let n = 0;
const film = async (frames) => { for (let f = 0; f < frames; f++) { await page.evaluate(() => window.__dino.step(1, 1 / 30)); await page.screenshot({ path: `${FR}/f${String(n++).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 90 }); } };
const clear = (keep) => page.evaluate((keep) => { const a = window.__dino; let k = 0; for (const d of a.dinos) if (!keep.includes(d.id) && Math.hypot(d.x, d.z) < 140) a.command(d.id, { place: [300 + 30 * (k++), 300, 0], stop: true }); }, keep);
const idOf = (sp, baby = false) => page.evaluate(([sp, baby]) => window.__dino.dinos.find((d) => d.species === sp && !!d.baby === baby)?.id, [sp, baby]);
const ready = async (ids) => { for (let i = 0; i < 200; i++) { const ok = await page.evaluate((ids) => ids.every((id) => window.__dino.dinos.find((d) => d.id === id).real), ids); if (ok) return; await page.evaluate(() => window.__dino.step(3)); await page.waitForTimeout(50); } };
const yAt = (id) => page.evaluate((id) => window.__dino.dinos.find((d) => d.id === id).y, id);

// A. T. rex walks past
let rex = await idOf('trex'); await clear([rex]);
await page.evaluate((id) => { const a = window.__dino; a.teleport(-10, -10); a.command(id, { place: [-26, -26, Math.PI / 2], stop: true }); }, rex); await ready([rex]);
await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [-26, -26, Math.PI / 2], stop: true }); a.step(20); a.command(id, { walkTo: [12, -26] }); }, rex);
let y = await yAt(rex); await page.evaluate(([id, y]) => window.__dino.director([-10, y + 2.2, -15.5], id, [0, 0, 0], 0.55), [rex, y]);
await film(210);
// B. Triceratops turns around (fixed camera)
let tri = await idOf('triceratops'); await clear([tri]);
await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [-14, -26, Math.PI / 2], stop: true }); }, tri); await ready([tri]);
await page.evaluate((id) => { const a = window.__dino; a.command(id, { place: [-14, -26, Math.PI / 2], stop: true }); a.step(20); a.command(id, { face: [-40, -26] }); }, tri);
y = await yAt(tri); await page.evaluate(([id, y]) => window.__dino.director([-6, y + 2.2, -35], id, [0, 0, 0], 0.5), [tri, y]);
await film(165);
// C. Sauropod with its baby
const pal = await idOf('paluxysaurus'), palB = await idOf('paluxysaurus', true); await clear([pal, palB]);
await page.evaluate(([id, b]) => { const a = window.__dino; a.command(id, { place: [-45, -18, Math.PI / 2], stop: true }); if (b) a.command(b, { place: [-50, -24, Math.PI / 2], stop: true }); }, [pal, palB]); await ready([pal]);
await page.evaluate(([id, b]) => { const a = window.__dino; a.command(id, { place: [-45, -18, Math.PI / 2], stop: true }); if (b) { a.command(b, { place: [-50, -24, Math.PI / 2], stop: true }); a.command(b, { release: true }); } a.step(20); a.command(id, { walkTo: [10, -18] }); }, [pal, palB]);
y = await yAt(pal); await page.evaluate(([id, y]) => window.__dino.director([-16, y + 3.5, -40], id, [0, 0, 0], 0.4), [pal, y]);
await film(240);
// D. Feeding, from the child's camera
await page.evaluate(() => window.__dino.director(null));
const ste = await idOf('stegosaurus'); await clear([tri, ste]);
await page.evaluate(([t, s]) => { const a = window.__dino; a.teleport(0, 0); a.setView(0, 0.3, 5.5); a.command(t, { place: [7, -15, -0.5], stop: true }); a.command(s, { place: [-8, -14, 0.6], stop: true }); a.command(t, { release: true }); a.command(s, { release: true }); a.step(5); a.food(); }, [tri, ste]);
await film(420);
// E. Tap a T. rex: roar, then stomp
await clear([rex]);
await page.evaluate((id) => { const a = window.__dino; a.teleport(0, 0); a.setView(0, 0.16, 6); a.command(id, { place: [0, -12, 0], stop: true }); a.command(id, { face: [0, 0] }); a.step(30); a.command(id, { release: true }); const xy = a.screenOf(id); if (xy) a.tapAt(xy[0], xy[1]); }, rex);
await film(85);
await page.evaluate((id) => { const a = window.__dino; const xy = a.screenOf(id); if (xy) a.tapAt(xy[0], xy[1]); }, rex);
await film(85);
console.log('frames', n, 'errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', `${FR}/f%04d.jpg`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', '-crf', '23', '-preset', 'slow', '-movflags', '+faststart', OUTMP4]);
console.log('wrote', OUTMP4, (fs.statSync(OUTMP4).size / 1048576).toFixed(1), 'MB');
