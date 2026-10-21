// Screenshots for the README, staged with the director camera. Output: ../docs/media/<name>.jpg
//   node tests/readme_shots.mjs [name,name]
import { chromium, devices } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, '');
const RAW = ROOT + '/tests/shots/readme'; fs.mkdirSync(RAW, { recursive: true });
const OUT = ROOT + '/../docs/media'; fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.argv[2] ? process.argv[2].split(',') : null;
const PORT = 4600 + Math.floor(Math.random() * 300);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((res) => server.stdout.on('data', (d) => { if (String(d).includes('localhost')) res(); }));
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] });
const page = await (await browser.newContext({ ...devices['iPad Pro 11'], viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1.5, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${PORT}/?q=high`); await page.waitForSelector('#splash'); await page.waitForTimeout(300); await page.touchscreen.tap(720, 480);
await page.waitForFunction(() => window.__dino && window.__dino.ready); await page.waitForFunction(() => !window.__dino.busy(), null, { timeout: 90000 }).catch(() => {});
await page.evaluate(() => { window.__dino.pause(true); });

// helpers available to scene code as `h`
await page.addInitScript(() => {});
await page.evaluate(() => {
  window.__h = {
    id: (sp, baby = false) => window.__dino.dinos.find((d) => d.species === sp && !!d.baby === baby)?.id,
    clearAround: (x, z, keep, r = 120) => { const a = window.__dino; let k = 0; for (const d of a.dinos) if (!keep.includes(d.id) && Math.hypot(d.x - x, d.z - z) < r) a.command(d.id, { place: [350 + 25 * (k++), 350, 0], stop: true }); },
    place: (id, x, z, h) => window.__dino.command(id, { place: [x, z, h], stop: true }),
    gy: (x, z) => { const g = window.__dino.ground(x, z); return Math.max(g.h, g.water); },
    tap: (id) => { const a = window.__dino; const xy = a.screenOf(id); if (xy) a.tapAt(xy[0], xy[1]); },
  };
});
const settle = async (need = []) => {
  for (let i = 0; i < 300; i++) {
    const ok = await page.evaluate((need) => { const a = window.__dino; a.step(2); return !a.busy() && need.every((id) => a.dinos.find((d) => d.id === id)?.real); }, need);
    if (ok && i > 10) break; await page.waitForTimeout(80);
  }
};
const SCENES = [
  { name: 'hero', hud: false, setup: `a.setTime(19.0); a.teleport(9,-6);
      const r=h.id('trex'), t=h.id('triceratops'), p=h.id('paluxysaurus'), s=h.id('stegosaurus');
      h.clearAround(0,-20,[r,t,p,s]); h.place(r,-4,-11,1.2); h.place(t,8,-19,-1.3); h.place(p,-16,-34,0.9); h.place(s,15,-31,-0.6); return [r,t,p,s];`,
    shot: `const [r]=ids; a.command(r,{release:true}); h.tap(r); a.step(26); a.clearFx(); a.showFootprints(false); const y=h.gy(2,6); a.director([2,y+1.4,6],null,[0,y+3.2,-30]); a.step(2);` },
  { name: 'trex-roar', hud: false, setup: `a.setTime(10.5); a.teleport(0,0); const r=h.id('trex'); h.clearAround(0,-10,[r]); h.place(r,0,-11,0); return [r];`,
    shot: `const [r]=ids; a.setView(0,0.18,6); a.command(r,{face:[0,0]}); a.step(60); a.command(r,{release:true}); h.tap(r); a.step(30); a.clearFx(); const p=a.headPos(r); const y=h.gy(1.5,-4); a.director([2.6,y+2.2,-4.5],null,[p[0],p[1]-0.6,p[2]]); a.step(1,0);` },
  { name: 'feeding', hud: true, setup: `a.setTime(9.5); a.teleport(0,0); const t=h.id('triceratops'), s=h.id('stegosaurus'); h.clearAround(0,-10,[t,s]); h.place(t,7,-15,-0.5); h.place(s,-8,-14,0.6); return [t,s];`,
    shot: `const [t,s]=ids; a.setView(0,0.32,5.5); a.command(t,{release:true}); a.command(s,{release:true}); a.food(); a.step(330); a.clearFx(); a.step(1,0);` },
  { name: 'snow-forest', hud: false, setup: `a.setTime(11.5); a.teleportBiome('snow'); const p=h.id('pachycephalosaurus'); const b=a.biomes.snow; h.clearAround(b[0],b[1],[p]); return [p];`,
    shot: `const [p]=ids; const pl=a.stats().player; const v=a.view(); h.place(p,pl.x-Math.sin(v.yaw)*9+2,pl.z-Math.cos(v.yaw)*9,v.yaw+Math.PI+0.7); a.step(40); a.clearFx(); a.step(1,0);` },
  { name: 'volcano-night', hud: false, setup: `a.setTime(22.4); a.teleport(0,-60); a.lookAt(20,-520); a.setView(a.view().yaw,0.06,7); const p=h.id('paluxysaurus'); h.clearAround(0,-60,[p],60); h.place(p,-14,-90,2.6); return [p];`,
    shot: `a.clearFx(); a.step(1,0);` },
  { name: 'volcano-dusk', hud: false, setup: `a.setTime(19.2); a.teleportBiome('volcano'); const t=h.id('triceratops'); return [t];`,
    shot: `const [t]=ids; const pl=a.stats().player; const v=a.view(); h.place(t,pl.x-Math.sin(v.yaw)*9+1.5,pl.z-Math.cos(v.yaw)*9,v.yaw+Math.PI+0.9); a.step(40); a.clearFx(); a.setView(v.yaw,0.12,6); a.step(1,0);` },
  { name: 'footprints', hud: false, setup: `a.setTime(16.5); a.teleport(-14,-12); const t=h.id('triceratops'); h.clearAround(-6,-26,[t]); h.place(t,-22,-26,Math.PI/2); return [t];`,
    shot: `const [t]=ids; a.command(t,{walkTo:[8,-26]}); a.step(150); a.watch(t,2.75,0.5,10.5,0.2); a.step(1,0); a.clearFx(); a.step(1,0);` },
  { name: 'drinking', hud: false, setup: `a.setTime(17.2); const t=h.id('triceratops'); const spot={x:-150,z:-6.86,bx:-157,bz:5.26}; a.teleport(spot.bx+6,spot.bz+6); h.clearAround(spot.bx,spot.bz,[t],80); h.place(t,spot.bx,spot.bz,0); window.__spot=spot; return [t];`,
    shot: `const [t]=ids; const spot=window.__spot; a.command(t,{release:true}); a.makeThirsty(t); a.step(160); const ux=spot.x-spot.bx, uz=spot.z-spot.bz, L=Math.hypot(ux,uz); const y=h.gy(spot.x,spot.z); a.clearFx(); a.director([spot.x+ux/L*4+uz/L*3, y+2.4, spot.z+uz/L*4-ux/L*3], t, [0,0,0], 0.35); a.step(1,0); a.clearFx(); a.step(1,0);` },
  { name: 'family', hud: false, setup: `a.setTime(8.2); a.teleport(-6,0); const p=h.id('paluxysaurus'), b=h.id('paluxysaurus',true); h.clearAround(-30,-18,[p,b]); h.place(p,-45,-18,Math.PI/2); h.place(b,-50,-24,Math.PI/2); return [p,b];`,
    shot: `const [p,b]=ids; a.command(b,{release:true}); a.command(p,{walkTo:[-10,-18]}); a.step(150); const pp=a.dinos.find(d=>d.id===p); const y=h.gy(pp.x+6,pp.z-20); a.clearFx(); a.director([pp.x+8,y+3,pp.z-21],p,[0,0,0],0.35); a.step(2); a.clearFx(); a.step(1,0);` },
  { name: 'sea', hud: false, setup: `a.setTime(12.5); a.teleportBiome('beach'); const m=h.id('mosasaurus'); return [m];`,
    shot: `const [m]=ids; a.watch(m,-1.2,0.2,12,0.3); a.step(30); a.clearFx(); a.step(1,0);` },
];
for (const sc of SCENES) {
  if (ONLY && !ONLY.includes(sc.name)) continue;
  await page.evaluate(() => { const a = window.__dino; a.director(null); a.watch(null); a.showFootprints(true); });
  const ids = await page.evaluate((code) => (new Function('a', 'h', code))(window.__dino, window.__h), sc.setup);
  await settle(ids.filter(Boolean));
  await page.evaluate(([code, ids]) => (new Function('a', 'h', 'ids', code))(window.__dino, window.__h, ids), [sc.setup, ids]).catch(() => {});
  await settle(ids.filter(Boolean));
  await page.evaluate(([code, ids]) => (new Function('a', 'h', 'ids', code))(window.__dino, window.__h, ids), [sc.shot, ids]);
  await page.addStyleTag({ content: `#hud{display:${sc.hud ? 'block' : 'none'}!important}` });
  await page.waitForTimeout(500);
  const raw = `${RAW}/${sc.name}.png`;
  await page.screenshot({ path: raw });
  execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${raw}').convert('RGB'); im.resize((1600, round(1600*im.height/im.width)), Image.LANCZOS).save('${OUT}/${sc.name}.jpg', quality=84, optimize=True, progressive=True)`]);
  console.log('shot', sc.name);
}
console.log('errors', errors.length, errors.slice(0, 3));
await browser.close(); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill(); }
