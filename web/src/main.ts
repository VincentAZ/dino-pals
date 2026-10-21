// Dino Pals — entry point. Wires world, dinos, input, audio and UI together.
import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { QUALITY_HIGH, QUALITY_LOW, VERSION, quality, setQuality, type Quality } from './config.ts';
import { Terrain, TerrainWorkers } from './world/terrain.ts';
import { Sky } from './world/sky.ts';
import { Water } from './world/water.ts';
import { Vegetation } from './world/vegetation.ts';
import { Weather } from './world/weather.ts';
import { Grass } from './world/grass.ts';
import { BIOMES, BIOME_IDS, biomeWeights, type BiomeId } from './world/biomes.ts';
import { heightAt, waterAt } from './world/heightmap.ts';
import { loadManifest, type Species } from './dinos/manifest.ts';
import { DinoManager } from './dinos/spawner.ts';
import { facePlayer, secondAction, triggerAction } from './dinos/ai.ts';
import type { Dino, DinoContext, DinoState, Food } from './dinos/dino.ts';
import { Player } from './player/player.ts';
import { TouchInput } from './input/touch.ts';
import { AudioEngine } from './audio/context.ts';
import { playVoice } from './audio/voices.ts';
import { eatCrunch, footstep, pop, sniff, sparkle, splash, thump, wingFlap } from './audio/sfx.ts';
import { Ambience } from './audio/ambience.ts';
import { Music } from './audio/music.ts';
import { showSplash } from './ui/splash.ts';
import { Hud } from './ui/hud.ts';
import { showCredits } from './ui/credits.ts';
import { say } from './speech.ts';

interface DinoApi {
  ready: boolean; version: string;
  stats: () => Record<string, unknown>;
  teleport: (x: number, z: number) => void;
  teleportBiome: (id: BiomeId) => void;
  setTime: (h: number) => void;
  tapAt: (x: number, y: number) => string | null;
  holdAt: (x: number, y: number) => string | null;
  food: () => void; magic: () => void;
  setQuality: (tier: 'high' | 'low') => void;
  screenOf: (id: string) => [number, number] | null;
  lookAt: (x: number, z: number) => void;
  vegNear: (id: string) => [number, number, number] | null;
  setView: (yaw: number, pitch: number, dist: number) => void;
  view: () => { yaw: number; pitch: number; dist: number };
  busy: () => boolean;
  dinos: { id: string; species: string; state: DinoState; x: number; y: number; z: number; real: boolean; awake: boolean }[];
  lastTapped: string | null;
  biomes: Record<string, [number, number]>;
  errors: string[];
}

const params = new URLSearchParams(location.search);
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String((e as PromiseRejectionEvent).reason)));

async function main(): Promise<void> {
  const app = document.getElementById('app')!;
  const forcedQ = params.get('q');
  if (forcedQ === 'low') setQuality({ ...QUALITY_LOW });
  if (forcedQ === 'high') setQuality({ ...QUALITY_HIGH });

  // renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 4000);

  // loaders
  const draco = new DRACOLoader(); draco.setDecoderPath('/draco/'); draco.setDecoderConfig({ type: 'wasm' });
  const gltf = new GLTFLoader(); gltf.setDRACOLoader(draco); gltf.setMeshoptDecoder(MeshoptDecoder);

  // world
  const workers = new TerrainWorkers(2);
  const terrain = new Terrain(workers);
  scene.add(terrain.group);
  const terrainReady = terrain.init();
  const sky = new Sky(renderer, scene, terrain.uniforms.uNoise.value);
  const vegetation = new Vegetation(renderer, gltf);
  scene.add(vegetation.group);
  terrain.onVeg = (key, cx, cz, veg) => vegetation.addChunk(key, cx, cz, veg);
  terrain.onChunkRemoved = (key) => vegetation.removeChunk(key);
  const weather = new Weather(terrain.uniforms.uNoise.value);
  scene.add(weather.group);
  const grass = new Grass();
  scene.add(grass.mesh);
  const player = new Player(camera);
  const dinos = new DinoManager(gltf);
  scene.add(dinos.group);
  let water: Water | null = null;

  // audio
  const audio = new AudioEngine();
  const ambience = new Ambience(audio);
  const music = new Music(audio);

  const speciesList: Species[] = await loadManifest();
  dinos.spawnAll(speciesList);

  // splash (the only screen) — start loading underneath it
  const splashP = showSplash();
  await terrainReady;
  water = new Water(terrain.uniforms.uNoise.value, terrain.heightTexture!);
  scene.add(water.group);
  await splashP;
  await audio.unlock();
  ambience.start(); music.start();
  requestWakeLock();
  try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* not available on iOS */ }

  // ---------- interactions ----------
  const foods: Food[] = [];
  const clock = { t: 0 };
  const camRight = new THREE.Vector3();
  const spatial = (p: THREE.Vector3, maxDist = 140) => {
    const d = p.distanceTo(camera.position);
    camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const rel = p.clone().sub(camera.position);
    const pan = rel.length() > 0.01 ? THREE.MathUtils.clamp(rel.normalize().dot(camRight) * 0.8, -1, 1) : 0;
    return audio.spatial(d, pan, maxDist);
  };
  const ctx: DinoContext = {
    player: player.pos, time: 0, foods,
    onFootstep: (d, big) => {
      const s = spatial(d.root.position, big ? 120 : 50);
      footstep(audio, big, s.gain * (big ? 0.8 : 0.35), s.pan);
      if (big) {
        const w = biomeWeights(d.root.position.x, d.root.position.z);
        weather.puffs.spawn(w.dominant === 'snow' ? 'snowkick' : 'dust', d.root.position.x, d.root.position.y, d.root.position.z, d.state === 'stomp' ? 26 : 10, Math.min(2.2, d.species.lengthM / 6));
      }
    },
    onEvent: (d, ev) => {
      const s = spatial(d.root.position, 220);
      const p = d.root.position;
      switch (ev) {
        case 'roar': playVoice(audio, d.species.voice, s.gain, s.pan, d.species.lengthM); weather.sparkles.spawn('sparkle', p.x, p.y + d.species.heightM * 0.8, p.z, 18); break;
        case 'eat': break;
        case 'bite': { eatCrunch(audio, s.gain * 0.8, s.pan); const sn = d.snoutPos(new THREE.Vector3()); weather.puffs.spawn('leaf', sn.x, sn.y, sn.z, 14); break; }
        case 'finished': { const sn = d.snoutPos(new THREE.Vector3()); weather.puffs.spawn('heart', sn.x, sn.y + 0.8, sn.z, 10); sparkle(audio); break; }
        case 'splash': splash(audio, s.gain, s.pan, d.species.lengthM > 8); weather.puffs.spawn('splash', p.x, Math.max(p.y, 0), p.z, 40, Math.min(3, d.species.lengthM / 5)); break;
        case 'stomp': thump(audio, s.gain, s.pan); break;
        case 'sniff': sniff(audio, s.gain, s.pan); break;
        case 'flap': wingFlap(audio, s.gain, s.pan); break;
      }
    },
  };

  let lastTapped: Dino | null = null, lastTapAt = -99;
  const tapDino = (d: Dino): DinoState => {
    facePlayer(d, player.pos);
    const again = d === lastTapped && clock.t - lastTapAt < 10;
    lastTapped = d; lastTapAt = clock.t; api.lastTapped = d.root.name;
    const state = triggerAction(d, again ? secondAction(d) : 'roar', ctx);
    if (!again) say(d.species.sayName, 350);
    return state;
  };
  const ray = new THREE.Raycaster();
  const tapAt = (x: number, y: number): string | null => {
    const nx = (x / window.innerWidth) * 2 - 1, ny = -(y / window.innerHeight) * 2 + 1;
    const d = dinos.pick(camera, nx, ny, 44, window.innerWidth, window.innerHeight);
    if (d) return tapDino(d);
    ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hit = terrain.raycast(ray.ray.origin, ray.ray.direction, 500);
    if (hit) {
      player.walkTo(hit.x, hit.z);
      const w = waterAt(hit.x, hit.z);
      const y = w.kind !== 'none' ? Math.max(hit.y, w.level) : hit.y;
      weather.sparkles.spawn('sparkle', hit.x, y + 0.1, hit.z, 10);
      pop(audio);
      return 'walk';
    }
    return null;
  };
  const holdAt = (x: number, y: number): string | null => {
    const nx = (x / window.innerWidth) * 2 - 1, ny = -(y / window.innerHeight) * 2 + 1;
    const d = dinos.pick(camera, nx, ny, 44, window.innerWidth, window.innerHeight);
    if (!d) return null;
    d.ai.followUntil = clock.t + 45; d.ai.target = null; d.ai.foodTarget = null;
    facePlayer(d, player.pos);
    weather.sparkles.spawn('heart', d.root.position.x, d.root.position.y + d.species.heightM * 0.9, d.root.position.z, 14);
    const s = spatial(d.root.position, 200); playVoice(audio, d.species.voice, s.gain * 0.6, s.pan, d.species.lengthM * 0.7);
    sparkle(audio);
    return 'follow';
  };

  const fruitMats = [0xe8383a, 0xf28c28, 0x8e44ad, 0xd6c13a].map((c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.18, roughness: 0.45 }));
  const leafMats = [0x3f8a3a, 0x5aa04a, 0x2f7030].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, side: THREE.DoubleSide }));
  let foodProto: THREE.Object3D | null = null;
  gltf.loadAsync('/assets/dinos/food.glb').then((g) => {
    g.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    foodProto = g.scene;
  }).catch(() => { foodProto = null; });
  const dropFood = (): void => {
    // 7 m ahead of the camera, on the ground
    const dir = new THREE.Vector3().subVectors(player.eye, camera.position).setY(0).normalize();
    let px = player.pos.x + dir.x * 7, pz = player.pos.z + dir.z * 7;
    const ob = player.obstacleAt?.(px, pz);
    if (ob) { const dx = px - ob.x, dz = pz - ob.z; const dd = Math.hypot(dx, dz) || 1; px = ob.x + (dx / dd) * (ob.r + 0.8); pz = ob.z + (dz / dd) * (ob.r + 0.8); }
    const w = waterAt(px, pz); const y = w.kind !== 'none' ? Math.max(heightAt(px, pz), w.level) : heightAt(px, pz);
    const g = new THREE.Group(); g.position.set(px, y, pz); g.rotation.y = Math.random() * Math.PI * 2;
    if (foodProto) {
      const pile = foodProto.clone(true); pile.scale.setScalar(2.4); g.add(pile);
      const fruit: THREE.Object3D[] = []; pile.traverse((o) => { if (/^(fruit|stem)/.test(o.name)) fruit.push(o); });
      g.userData.fruit = fruit;
    } else {
    // leaf pile: a low mound of overlapping leaves
    const mound = new THREE.Mesh(new THREE.SphereGeometry(1.0, 18, 10), leafMats[0]); mound.scale.set(1, 0.38, 1); mound.position.y = -0.02; mound.castShadow = true; g.add(mound);
    for (let i = 0; i < 26; i++) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.3), leafMats[i % 3]);
      const a = Math.random() * Math.PI * 2, r = Math.random() * 1.05;
      leaf.position.set(Math.cos(a) * r, 0.02 + (1 - r) * 0.34 + Math.random() * 0.06, Math.sin(a) * r);
      leaf.rotation.set(-0.9 + Math.random() * 0.5, a + Math.random(), (Math.random() - 0.5) * 0.6); g.add(leaf);
    }
    // fruit sitting on the pile
    for (let i = 0; i < 14; i++) {
      const rad = 0.13 + Math.random() * 0.09;
      const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 12, 10), fruitMats[i % fruitMats.length]);
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.75;
      m.position.set(Math.cos(a) * r, 0.36 * Math.sqrt(Math.max(0, 1 - r * r)) + rad * 0.6, Math.sin(a) * r); m.castShadow = true; g.add(m);
    }
    }
    scene.add(g);
    const food: Food = { pos: new THREE.Vector3(px, y, pz), amount: 1, mesh: g };
    foods.push(food);
    weather.sparkles.spawn('sparkle', px, y + 0.3, pz, 24);
    pop(audio); sparkle(audio);
    if (foods.length > 4) { const old = foods.shift()!; old.amount = 0; scene.remove(old.mesh); }
  };

  const MAGIC_TIMES = [6.3, 12, 19.7, 23.2];
  let magicTarget: number | null = null;
  const magic = (): void => {
    const h = sky.hours;
    const next = MAGIC_TIMES.find((t) => t > h + 0.5) ?? MAGIC_TIMES[0];
    magicTarget = next;
    weather.sparkles.spawn('sparkle', player.pos.x, player.pos.y + 1, player.pos.z, 60);
    sparkle(audio);
  };

  const hud = new Hud({ onFood: dropFood, onMagic: magic, onInfo: () => showCredits(speciesList, () => player.teleport(0, 0)) });
  const input = new TouchInput(renderer.domElement, {
    onTap: (x, y) => { tapAt(x, y); },
    onDrag: (dx, dy) => player.orbit(dx, dy),
    onPinch: (s) => player.zoom(s),
    onHold: (x, y) => { holdAt(x, y); },
  });
  void input;
  player.obstacleAt = (x, z) => vegetation.obstacleAt(x, z);
  player.onStep = () => {
    const w = waterAt(player.pos.x, player.pos.z);
    if (w.kind !== 'none' && w.level > heightAt(player.pos.x, player.pos.z)) { splash(audio, 0.25, 0); weather.puffs.spawn('splash', player.pos.x, w.level, player.pos.z, 6, 0.5); }
    else footstep(audio, false, 0.18, 0);
  };

  // ---------- quality probe & loop ----------
  const api: DinoApi = {
    ready: false, version: VERSION, errors, lastTapped: null,
    stats: () => ({
      fps: Math.round(fps), frameMs: +frameMs.toFixed(2), triangles: renderer.info.render.triangles, calls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, terrain: terrain.stats, dinos: dinos.stats,
      vegLoaded: vegetation.loadedCount, veg: vegetation.stats, light: grass.material.uniforms.uLight.value.toArray().map((v: number) => +v.toFixed(2)), grassSample: Array.from(grass.sample()), hours: +sky.hours.toFixed(2), quality: quality.tier, pixelRatio: renderer.getPixelRatio(),
      player: { x: +player.pos.x.toFixed(1), y: +player.pos.y.toFixed(1), z: +player.pos.z.toFixed(1), biome: biomeWeights(player.pos.x, player.pos.z).dominant },
    }),
    teleport: (x, z) => player.teleport(x, z),
    teleportBiome: (id) => { const b = BIOMES[id]; if (!b) return; player.teleport(b.anchor[0], b.anchor[1]); player.yaw = Math.atan2(player.pos.x - b.focus[0], player.pos.z - b.focus[1]); player.pitch = id === 'volcano' ? 0.04 : 0.2; player.snapCamera(); dinos.attract(id, player.pos, clock.t); },
    setTime: (h) => { sky.setTime(h); magicTarget = null; },
    tapAt, holdAt, food: dropFood, magic,
    setQuality: (tier) => applyQuality(tier === 'low' ? { ...QUALITY_LOW } : { ...QUALITY_HIGH }),
    vegNear: (id) => vegetation.nearest(id, player.pos.x, player.pos.z),
    lookAt: (x, z) => { player.yaw = Math.atan2(player.pos.x - x, player.pos.z - z); player.snapCamera(); },
    view: () => ({ yaw: player.yaw, pitch: player.pitch, dist: player.dist }),
    setView: (yaw, pitch, dist) => { player.yaw = yaw; player.pitch = pitch; player.dist = dist; player.snapCamera(); },
    screenOf: (id) => {
      const d = dinos.dinos.find((x) => x.root.name === id || x.species.id === id);
      if (!d) return null;
      const v = d.root.position.clone(); v.y += d.species.heightM * 0.5; v.project(camera);
      if (v.z > 1) return null;
      return [((v.x + 1) / 2) * window.innerWidth, ((1 - v.y) / 2) * window.innerHeight];
    },
    busy: () => workers.inFlight > 0 || vegetation.loadedCount < vegetation.species.size || dinos.dinos.some((d) => d.loading),
    get dinos() { return dinos.dinos.map((d) => ({ id: d.root.name, species: d.species.id, state: d.state, x: +d.root.position.x.toFixed(1), y: +d.root.position.y.toFixed(1), z: +d.root.position.z.toFixed(1), real: d.real, awake: d.awake })); },
    biomes: Object.fromEntries(BIOME_IDS.map((id) => [id, BIOMES[id].anchor])),
  };
  (window as unknown as { __dino: DinoApi }).__dino = api;

  const applyQuality = (q: Quality): void => {
    setQuality(q);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    sky.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
  };

  let fps = 60, frameMs = 16; let probeT = 0, probeFrames = 0, probeAcc = 0, probed = !!forcedQ;
  let last = performance.now();
  let running = true; let raf = 0;
  const biomeW = new Float32Array(BIOME_IDS.length);
  const camDir = new THREE.Vector3();
  const shadowCenter = new THREE.Vector3();

  const frame = (): void => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const rawDt = (now - last) / 1000; last = now;
    const dt = Math.min(rawDt, 0.05);
    frameMs += (rawDt * 1000 - frameMs) * 0.05; fps = 1000 / Math.max(frameMs, 1);
    clock.t += dt; ctx.time = clock.t;
    // quality probe during the first seconds
    if (!probed && api.ready) {
      probeT += rawDt; probeFrames++; probeAcc += rawDt;
      if (probeT > 3) { probed = true; const avg = (probeAcc / probeFrames) * 1000; if (avg > 21) applyQuality({ ...QUALITY_LOW }); }
    }
    if (magicTarget !== null) {
      let diff = magicTarget - sky.hours; if (diff < 0) diff += 24;
      sky.speed = 140;
      if (diff < 0.25 || diff > 23.5) { sky.setTime(magicTarget); sky.speed = 1; magicTarget = null; }
    }
    player.update(dt);
    camera.getWorldDirection(camDir);
    shadowCenter.copy(player.pos).addScaledVector(camDir, 25);
    biomeWeights(player.pos.x, player.pos.z, biomeW);
    sky.update(dt, player.pos.x, player.pos.z, scene, player.pos, camDir);
    terrain.update(player.pos.x, player.pos.z, clock.t);
    terrain.uniforms.uLavaGlow.value = 0.7 + 0.5 * sky.state.night;
    water?.update(dt, sky.state, player.pos.x, player.pos.z);
    // near-neutral foliage/grass light: sun + whitened hemisphere
    const light = new THREE.Color().copy(sky.sun.color).multiplyScalar(0.55 * sky.sun.intensity / 3.2).add(sky.hemi.color.clone().lerp(new THREE.Color(1, 1, 1), 0.6).multiplyScalar(0.5 * sky.hemi.intensity));
    vegetation.update(dt, light, player.pos);
    grass.update(dt, player.pos.x, player.pos.z, light, sky.state.night > 0.5 ? sky.state.moonDir : sky.state.sunDir);
    weather.update(dt, camera.position, player.pos, biomeW, sky.state, renderer.getPixelRatio());
    dinos.update(dt, ctx, shadowCenter, camera);
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      if (f.amount <= 0) { scene.remove(f.mesh); foods.splice(i, 1); continue; }
      // the pile visibly shrinks and fruit disappears as it is eaten
      const k = 0.3 + 0.7 * f.amount; f.mesh.scale.set(k, 0.45 + 0.55 * f.amount, k);
      const fruit = f.mesh.userData.fruit as THREE.Object3D[] | undefined;
      if (fruit) { const keep = Math.ceil(f.amount * fruit.length); fruit.forEach((o, j) => { o.visible = j < keep; }); }
    }
    ambience.update(dt, biomeW, sky.state.night, weather.rainAmount);
    music.update(sky.state.night);
    hud.setLoading(vegetation.loadedCount < vegetation.species.size || dinos.stats.real + dinos.dinos.filter((d) => d.loaded).length < dinos.dinos.length);
    renderer.render(scene, camera);
  };

  const onResize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { running = false; cancelAnimationFrame(raf); audio.suspend(); }
    else { if (!running) { running = true; last = performance.now(); frame(); } audio.resume(); requestWakeLock(); }
  });

  player.teleport(0, 0);
  player.yaw = Math.atan2(player.pos.x - BIOMES.meadow.focus[0], player.pos.z - BIOMES.meadow.focus[1]); player.snapCamera();
  api.ready = true;
  frame();
}

let wakeLock: { release: () => Promise<void> } | null = null;
async function requestWakeLock(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (nav.wakeLock && !wakeLock) wakeLock = await nav.wakeLock.request('screen');
  } catch { wakeLock = null; }
}

main().catch((e) => { console.error(e); errors.push(String(e)); });
