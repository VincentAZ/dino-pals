// Real mobile input and startup regressions. Run after npm run build:
//   node tests/mobile.mjs       (CASES=input or CASES=game to narrow a failure)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { chromium, webkit, devices } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'tests/shots/mobile');
await fs.mkdir(OUT, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Preview startup timeout')), 20000);
  server.stdout.on('data', data => {
    const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  });
  server.once('error', reject);
  server.stderr.on('data', data => process.stderr.write(data));
});
const inputSource = ts.transpileModule(await fs.readFile(path.join(ROOT, 'src/input/touch.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const inputModule = 'data:text/javascript;base64,' + Buffer.from(inputSource).toString('base64');

async function inputChecks(browser, name) {
  const context = await browser.newContext({ ...devices['iPad Pro 11'], deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.route('**/input', route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width,initial-scale=1"><canvas style="position:fixed;inset:0;width:100%;height:100%;touch-action:none"></canvas>' }));
    await page.goto(BASE + '/input');
    await page.evaluate(async url => {
      const { TouchInput } = await import(url);
      const canvas = document.querySelector('canvas');
      window.events = [];
      window.input = new TouchInput(canvas, {
        onTap: (x, y) => events.push(['tap', x, y]),
        onDrag: (x, y) => events.push(['drag', x, y]),
        onPinch: s => events.push(['pinch', s]),
        onHold: () => events.push(['hold']), onHoldEnd: () => events.push(['end']),
      });
      window.pointer = (type, id = 1, x = 100, y = 100) => canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: 'touch', button: 0, clientX: x, clientY: y,
        isPrimary: id === 1, bubbles: true, cancelable: true,
      }));
    }, inputModule);
    const events = () => page.evaluate(() => { const result = events; window.events = []; return result; });
    await page.touchscreen.tap(100, 100);
    assert.equal((await events()).filter(e => e[0] === 'tap').length, 1, 'one real tap activates once');
    await page.evaluate(() => { pointer('pointerdown'); pointer('pointercancel'); });
    assert.deepEqual(await events(), [], 'pointercancel must not become a tap');
    await page.evaluate(() => {
      pointer('pointerdown'); pointer('pointerdown', 2, 160);
      pointer('pointermove', 2, 200); pointer('pointerup', 2, 200); pointer('pointerup');
    });
    const pinch = await events();
    assert(pinch.some(e => e[0] === 'pinch'), 'pinch changes zoom');
    assert(!pinch.some(e => e[0] === 'tap'), 'lifting the last finger after pinching must not tap');
    await page.evaluate(() => {
      pointer('pointerdown'); pointer('pointerdown', 2, 160); pointer('pointerdown', 3, 200);
      pointer('pointermove', 3, 240); pointer('pointerup', 3, 240); pointer('pointerup', 2, 160); pointer('pointerup');
    });
    assert(!(await events()).some(e => e[0] === 'tap' || e[0] === 'drag'), 'palm input must not tap or orbit');
    await page.evaluate(() => { pointer('pointerdown'); pointer('pointerup', 1, 140); });
    assert.deepEqual(await events(), [], 'release outside tap tolerance must not tap');
    await page.evaluate(() => pointer('pointerdown'));
    await page.waitForTimeout(550);
    await page.evaluate(() => pointer('pointercancel'));
    assert.deepEqual((await events()).map(e => e[0]), ['hold', 'end'], 'cancellation ends a hold exactly once');
    for (const reason of ['blur', 'hidden', 'capture', 'disabled']) {
      await page.evaluate(reason => {
        pointer('pointerdown');
        if (reason === 'blur') window.dispatchEvent(new Event('blur'));
        if (reason === 'hidden') {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange')); delete document.hidden;
        }
        if (reason === 'capture') pointer('lostpointercapture');
        if (reason === 'disabled') { input.enabled = false; input.enabled = true; }
      }, reason);
      await page.waitForTimeout(550);
      await page.evaluate(() => pointer('pointerup'));
      assert.deepEqual(await events(), [], `${reason} clears pending gestures and hold timers`);
      await page.touchscreen.tap(100, 100);
      assert.equal((await events()).filter(e => e[0] === 'tap').length, 1, `tap recovers after ${reason}`);
    }
    console.log('PASS', name, 'tap / cancel / pinch / palm / hold / capture / background recovery');
  } finally { await context.close(); }
}

async function gameChecks(browser, name, device, blocked = false) {
  const context = await browser.newContext({ ...device, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    if (blocked) await page.addInitScript(() => {
      // Safari can leave these permission promises pending indefinitely. Neither
      // sound nor fullscreen is allowed to gate installation of game controls.
      AudioContext.prototype.resume = function () { return new Promise(() => {}); };
      Element.prototype.requestFullscreen = function () { return new Promise(() => {}); };
    });
    await page.goto(BASE + '/?q=low');
    await page.waitForSelector('#splash');
    const size = page.viewportSize();
    await page.touchscreen.tap(size.width / 2, size.height / 2);
    await page.waitForFunction(() => window.__dino?.ready, null, { timeout: 30000 });
    await page.waitForSelector('#splash', { state: 'detached' });
    if (!blocked) await page.waitForFunction(() => __dino.stats().audioState === 'running');
    // Freeze the simulation to keep camera/animals stable between touch down/up.
    await page.evaluate(() => {
      __dino.pause(true); __dino.teleport(0, 0); __dino.setView(0, 0.35, 7);
      // Clear the ground target: the herd can legitimately intercept a tap.
      __dino.dinos.forEach((d, i) => __dino.command(d.id, { place: [300 + i * 15, 300, 0], stop: true }));
      __dino.step(1);
    });
    const p0 = await page.evaluate(() => __dino.stats().player);
    await page.touchscreen.tap(size.width * 0.5, size.height * 0.5);
    await page.evaluate(() => __dino.step(60));
    const p1 = await page.evaluate(() => __dino.stats().player);
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) <= 0.2) {
      console.log('tap diagnostic', name, p0, p1, await page.evaluate(() => ({ tapped: __dino.lastTapped, view: __dino.view(), width: innerWidth, height: innerHeight, element: document.elementFromPoint(innerWidth * 0.5, innerHeight * 0.5)?.outerHTML.slice(0, 150) })));
      await page.screenshot({ path: path.join(OUT, `${name}-tap-failed.png`) });
    }
    assert(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.2, `${name}: real ground tap moves explorer`);
    const view = await page.evaluate(() => __dino.view());
    await page.mouse.move(size.width * 0.5, size.height * 0.4);
    await page.mouse.down(); await page.mouse.move(size.width * 0.7, size.height * 0.4, { steps: 5 }); await page.mouse.up();
    assert.notEqual((await page.evaluate(() => __dino.view())).yaw, view.yaw, 'drag orbits camera');
    await page.locator('#btn-food').tap();
    assert((await page.evaluate(() => __dino.foods())).length > 0, 'real food button drops fruit');
    const hour = await page.evaluate(() => __dino.stats().hours);
    await page.locator('#btn-magic').tap();
    await page.evaluate(() => __dino.step(90));
    assert.notEqual(await page.evaluate(() => __dino.stats().hours), hour, 'real magic button changes time');
    const dino = await page.evaluate(() => {
      const a = __dino, d = a.dinos.find(d => d.species === 'trex' && !d.baby);
      a.teleport(0, 0); a.setView(0, 0.18, 7);
      a.command(d.id, { place: [0, -12, Math.PI / 2], stop: true }); a.step(1);
      return { id: d.id, point: a.screenOf(d.id) };
    });
    assert(dino.point, 'dinosaur projects onto the screen');
    await page.touchscreen.tap(...dino.point);
    assert.equal(await page.evaluate(() => __dino.lastTapped), dino.id, 'real tap reaches the dinosaur action');
    // Desktop Chromium's fullscreen window cannot be resized by the driver;
    // exiting here simulates the dimensions that a device rotation supplies.
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await page.setViewportSize({ width: size.height, height: size.width });
    await page.waitForTimeout(250);
    const canvas = await page.locator('#app canvas').boundingBox();
    assert.equal(canvas.width, size.height); assert.equal(canvas.height, size.width);
    const info = await page.locator('#btn-info').boundingBox();
    await page.mouse.move(info.x + info.width / 2, info.y + info.height / 2);
    await page.mouse.down(); await page.waitForTimeout(2100); await page.mouse.up();
    await page.waitForSelector('#credits');
    if (name.startsWith('chromium')) {
      const cdp = await context.newCDPSession(page);
      const panel = await page.locator('#credits .panel').boundingBox();
      const x = panel.x + panel.width / 2, y = panel.y + panel.height * 0.8;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * panel.height * 0.07 }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(250);
      assert(await page.locator('#credits .panel').evaluate(el => el.scrollTop > 0), 'parent panel scrolls with a real finger swipe');
    }
    await page.locator('#credits-close').tap();
    await page.waitForSelector('#credits', { state: 'detached' });
    assert.deepEqual(await page.evaluate(() => __dino.errors), []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(OUT, `${name}${blocked ? '-blocked' : ''}.png`) });
    console.log('PASS', name, blocked ? 'startup despite pending permissions' : 'startup', '/ real taps / HUD / orbit / rotation / credits');
  } finally { await context.close(); }
}

try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-gl=angle', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-features=Vulkan'] } : {}) });
    try {
      if (process.env.CASES !== 'game') await inputChecks(browser, name);
      if (process.env.CASES !== 'input') {
        await gameChecks(browser, name + '-phone', devices['iPhone SE']);
        if (name === 'chromium') await gameChecks(browser, name + '-android', devices['Pixel 7']);
        await gameChecks(browser, name + '-ipad', devices['iPad Pro 11 landscape'], true);
      }
    } finally { await browser.close(); }
  }
  console.log('MOBILE PASSED');
} finally { server.kill(); }
