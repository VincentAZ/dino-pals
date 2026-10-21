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
import { ObstacleGrid } from './world/obstacles.ts';
import { FoodSystem } from './world/food.ts';
import { BIOMES, BIOME_IDS, biomeWeights, type BiomeId } from './world/biomes.ts';
import { heightAt, waterAt } from './world/heightmap.ts';
import { loadManifest, type Species } from './dinos/manifest.ts';
import { DinoManager } from './dinos/spawner.ts';
import { ktx2Loader } from './world/ktx2.ts';
import { installAssetVersioning } from './assets.ts';
import { loadSkinDetail } from './dinos/skin.ts';
import { facePlayer, tapAction } from './dinos/ai.ts';
import { Dino } from './dinos/dino.ts';
import type { DinoContext, DinoState, Food } from './dinos/dino.ts';
import { bodyOf, warmStats, lastPush, aiProf } from './dinos/ai_land.ts';
import { routeStats } from './dinos/path.ts';
import { Player } from './player/player.ts';
import { TouchInput } from './input/touch.ts';
import { AudioEngine } from './audio/context.ts';
import { playVoice } from './audio/voices.ts';
import { eatCrunch, footstep, pop, sniff, snore, sparkle, splash, thump, wingFlap } from './audio/sfx.ts';
import { Zzz } from './dinos/zzz.ts';
import { Ambience } from './audio/ambience.ts';
import { Music } from './audio/music.ts';
import { samples } from './audio/samples.ts';
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
  dinos: { id: string; species: string; state: DinoState; x: number; y: number; z: number; real: boolean; awake: boolean; baby: boolean }[];
  lastTapped: string | null;
  biomes: Record<string, [number, number]>;
  errors: string[];
  // ---- test hooks
  pause: (on: boolean) => void;
  step: (frames: number, dt?: number) => void;
  watch: (id: string | null, az?: number, el?: number, dist?: number, height?: number, head?: boolean) => void;
  command: (id: string, cmd: { walkTo?: [number, number]; face?: [number, number]; stop?: boolean; release?: boolean; place?: [number, number, number] }) => void;
  dropFoodAt: (x: number, z: number) => void;
  loco: (id: string) => Record<string, unknown> | null;
  overlaps: () => { dinoDino: number; dinoTree: number; worst: number };
  probeDino: (id: string) => Record<string, unknown> | null;
  probeVis: (id: string) => Record<string, unknown> | null;
  probeMem: () => Record<string, unknown>;
  probeTris: () => Record<string, number>;
  setDinoCulling: (on: boolean) => void;
  simulateSlow: (ms: number) => void;
  setJawClose: (species: string, deg: number) => void;
  clearFx: () => void;
  headPos: (id: string) => [number, number, number, number] | null;
  motionSample: () => (string | number)[][];
  director: (cam: [number, number, number] | null, targetId?: string | null, lookAt?: [number, number, number], height?: number) => void;
  biteLog: () => { dino: string; dist: number; t: number }[];
  audioStats: () => Record<string, unknown>;
  foods: () => unknown[];
}

const params = new URLSearchParams(location.search);
const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String((e as PromiseRejectionEvent).reason)));

async function main(): Promise<void> {
  installAssetVersioning();   // before anything loads
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
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft was removed in r18x (it mapped to PCF anyway)
  app.appendChild(renderer.domElement);
  // Safari drops WebGL contexts under memory pressure or after long backgrounding. three.js re-uploads
  // everything on restore; if the context does not come back, reload rather than leave a frozen screen.
  let contextLost = false, lostTimer = 0, contextLosses = 0;
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); contextLost = true; contextLosses++;
    lostTimer = window.setTimeout(() => { if (contextLost) location.reload(); }, 4000);
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => { contextLost = false; clearTimeout(lostTimer); });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 4000);

  // loaders
  const draco = new DRACOLoader(); draco.setDecoderPath('/draco/');   // WebAssembly decoder by default
  const gltf = new GLTFLoader(); gltf.setDRACOLoader(draco); gltf.setMeshoptDecoder(MeshoptDecoder);
  gltf.setKTX2Loader(ktx2Loader(renderer));   // dinosaur + food textures stay GPU-compressed (ASTC / ETC2 on iPad)

  // world
  const workers = new TerrainWorkers(2);
  const terrain = new Terrain(workers, renderer);
  scene.add(terrain.group);
  const terrainReady = terrain.init();
  const sky = new Sky(renderer, scene, terrain.uniforms.uNoise.value);
  const vegetation = new Vegetation(renderer, gltf);
  const obstacles = new ObstacleGrid(vegetation);
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

  loadSkinDetail();
  const speciesList: Species[] = await loadManifest();
  dinos.spawnAll(speciesList);

  // splash (the only screen) — start loading underneath it
  const splashP = showSplash();
  await terrainReady;
  water = new Water(terrain.uniforms.uNoise.value, terrain.heightTexture!);
  scene.add(water.group);
  await splashP;
  await audio.unlock();
  void samples.load(audio);
  ambience.start(); music.start();
  requestWakeLock();
  // iOS parks the audio context as "interrupted" after calls, Siri or other apps; the next touch revives it
  const reviveAudio = (): void => { if (audio.ctx.state !== 'running' && !document.hidden) void audio.unlock(); };
  window.addEventListener('pointerdown', reviveAudio, { capture: true, passive: true });
  window.addEventListener('touchend', reviveAudio, { capture: true, passive: true });
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
  const foodSystem = new FoodSystem(scene, gltf, foods);
  const zzz = new Zzz(); scene.add(zzz.group);
  void foodSystem.load();
  const keepClear: [number, number, number][] = [[0, 0, 1.6], [0, 0, 1.4]];
  const biteLog: { dino: string; dist: number; t: number }[] = [];
  const ctx: DinoContext = {
    player: player.pos, eye: player.eye, view: new THREE.Vector3(0, 0, -1), night: 0, time: 0, foods, obstacles, others: dinos.dinos, keepClear,
    onFootstep: (d, big, at, heavy) => {
      const p = at ?? d.root.position;
      const s = spatial(p, big ? 120 : 50);
      footstep(audio, big, s.gain * (big ? 0.8 : 0.3) * (heavy ? 1.4 : 1), s.pan);
      if (heavy) thump(audio, s.gain * 0.8, s.pan);
      if (big || heavy) {
        const w = biomeWeights(p.x, p.z);
        weather.puffs.spawn(w.dominant === 'snow' ? 'snowkick' : 'dust', p.x, p.y, p.z, heavy ? 22 : 7, Math.min(1.6, d.sizeM / 9));
      }
    },
    onEvent: (d, ev, item) => {
      const s = spatial(d.root.position, 220);
      const p = d.root.position;
      switch (ev) {
        case 'roar': playVoice(audio, d.species.voice, s.gain, s.pan, d.sizeM); weather.sparkles.spawn('sparkle', p.x, p.y + d.species.heightM * 0.8, p.z, 18); break;
        case 'eat': break;
        case 'bite': {
          const sn = d.snoutPos(new THREE.Vector3());
          const f = d.ai.foodTarget;
          if (f && f.items.length) {
            const it = foodSystem.bite(d, f, item ?? null, sn);
            if (it) biteLog.push({ dino: d.root.name, dist: +sn.distanceTo(it.pos).toFixed(3), t: +clock.t.toFixed(2), snout: [+sn.x.toFixed(2), +sn.y.toFixed(2), +sn.z.toFixed(2)], item: [+it.pos.x.toFixed(2), +it.pos.y.toFixed(2), +it.pos.z.toFixed(2)], root: [+d.root.position.x.toFixed(2), +d.root.position.z.toFixed(2)], heading: +d.heading.toFixed(2), reach: +d.eatReach.toFixed(2), hasSnout: !!d.loco?.snout, reachW: +(d.loco?.reachWeight ?? -1).toFixed(2), tgt: d.loco?.reachTarget ? [+d.loco.reachTarget.x.toFixed(2), +d.loco.reachTarget.y.toFixed(2), +d.loco.reachTarget.z.toFixed(2)] : null, ph: +d.clipPhase.toFixed(2) } as never);
          }
          eatCrunch(audio, s.gain * 0.9, s.pan);
          weather.puffs.spawn('leaf', sn.x, sn.y, sn.z, 10);
          break;
        }
        case 'chew': eatCrunch(audio, s.gain * 0.3, s.pan); break;
        case 'snore': {
          const near = d.root.position.distanceTo(player.pos) < 45;
          if (near) snore(audio, spatial(d.root.position, 45).gain * 0.7, s.pan, d.sizeM);
          const h = d.snoutPos(new THREE.Vector3()); h.y += 0.3 * d.sizeM * 0.15 + 0.4;
          zzz.spawn(h, Math.min(2.4, 0.9 + d.sizeM * 0.12));
          break;
        }
        case 'yawn': playVoice(audio, d.species.voice, s.gain * 0.35, s.pan, d.sizeM * 1.15); break;
        case 'graze': { const sn = d.snoutPos(new THREE.Vector3()); weather.puffs.spawn('leaf', sn.x, Math.max(sn.y, p.y + 0.2), sn.z, 5); eatCrunch(audio, s.gain * 0.25, s.pan); break; }
        case 'finished': { const sn = d.snoutPos(new THREE.Vector3()); weather.puffs.spawn('heart', sn.x, sn.y + 0.8, sn.z, 10); sparkle(audio); break; }
        case 'splash': splash(audio, s.gain, s.pan, d.species.lengthM > 8); weather.puffs.spawn('splash', p.x, Math.max(p.y, 0), p.z, 40, Math.min(3, d.species.lengthM / 5)); break;
        case 'stomp': thump(audio, s.gain, s.pan); break;
        case 'sniff': sniff(audio, s.gain, s.pan); break;
        case 'flap': wingFlap(audio, s.gain, s.pan); break;
      }
    },
  };

  const tapDino = (d: Dino): DinoState | 'queued' => {
    facePlayer(d, player.pos, clock.t);
    api.lastTapped = d.root.name;
    const fresh = clock.t - d.ai.lastTapAt > 10;
    const state = tapAction(d, ctx);
    if (fresh) say(d.species.sayName, 350);
    if (state === 'queued') {
      // the tap still lands: a little twinkle at the head while the current action plays out
      const h = d.snoutPos(new THREE.Vector3());
      weather.sparkles.spawn('sparkle', h.x, h.y + 0.3, h.z, 6);
    }
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
    d.ai.followUntil = clock.t + 45; d.ai.target = null; d.ai.followSide = 0; d.ai.approachUntil = 0;
    if (d.ai.foodTarget) { d.ai.foodTarget.eaters.delete(d.index); d.ai.foodTarget = null; }
    facePlayer(d, player.pos, clock.t);
    weather.sparkles.spawn('heart', d.root.position.x, d.root.position.y + d.species.heightM * 0.9, d.root.position.z, 14);
    const s = spatial(d.root.position, 200); playVoice(audio, d.species.voice, s.gain * 0.6, s.pan, d.sizeM * 0.85);
    sparkle(audio);
    return 'follow';
  };

  const placeFood = (px: number, pz: number): void => {
    // keep the pile clear of trunks / rocks so dinosaurs can stand all around it
    for (let i = 0; i < 6; i++) {
      const ob = player.obstacleAt?.(px, pz);
      if (!ob) break;
      const dx = px - ob.x, dz = pz - ob.z; const dd = Math.hypot(dx, dz) || 1; px = ob.x + (dx / dd) * (ob.r + 2); pz = ob.z + (dz / dd) * (ob.r + 2);
    }
    const w = waterAt(px, pz); const y = w.kind !== 'none' ? Math.max(heightAt(px, pz), w.level) : heightAt(px, pz);
    foodSystem.drop(px, y, pz);
    weather.sparkles.spawn('sparkle', px, y + 0.4, pz, 24);
    pop(audio); sparkle(audio);
  };
  const dropFood = (): void => {
    // in front of the explorer, on the ground
    const dir = new THREE.Vector3().subVectors(player.eye, camera.position).setY(0).normalize();
    placeFood(player.pos.x + dir.x * 5.5, player.pos.z + dir.z * 5.5);
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
      fps: Math.round(fps), frameMs: +frameMs.toFixed(2), dinoMs: +dinoMs.toFixed(2), dinoMaxMs: +dinoMaxMs.toFixed(2), route: { ...routeStats, warmed: warmStats.cells }, aiProf: Object.fromEntries(Object.entries(aiProf).map(([k, v]) => [k, +v.toFixed(1)])), triangles: renderer.info.render.triangles, calls: renderer.info.render.calls,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, terrain: terrain.stats, dinos: dinos.stats,
      vegLoaded: vegetation.loadedCount, veg: vegetation.stats, grassTris: grass.triangles, light: grass.material.uniforms.uLight.value.toArray().map((v: number) => +v.toFixed(2)), grassSample: Array.from(grass.sample()), hours: +sky.hours.toFixed(2), quality: quality.tier, pixelRatio: renderer.getPixelRatio(),
      contextLosses, audioState: audio.ctx.state, renderScale: +renderScale.toFixed(2),
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
    get dinos() { return dinos.dinos.map((d) => ({ id: d.root.name, species: d.species.id, state: d.state, x: +d.root.position.x.toFixed(1), y: +d.root.position.y.toFixed(1), z: +d.root.position.z.toFixed(1), real: d.real, awake: d.awake, baby: !!d.parent })); },
    biomes: Object.fromEntries(BIOME_IDS.map((id) => [id, BIOMES[id].anchor])),
    pause: (on) => { paused = on; },
    step: (frames, dt = 1 / 30) => { for (let i = 0; i < frames; i++) tick(dt, dt); applyWatch(); renderer.render(scene, camera); },
    watch: (id, az = 1.57, el = 0.12, dist = 14, height = 0.5, head = false) => { watchId = id; Object.assign(watchCfg, { az, el, dist, height, head }); applyWatch(); },
    command: (id, cmd) => {
      const d = dinos.dinos.find((x) => x.root.name === id || x.species.id === id); if (!d) return;
      d.ai.scripted = !cmd.release;
      if (cmd.place) { d.root.position.set(cmd.place[0], heightAt(cmd.place[0], cmd.place[1]), cmd.place[1]); d.heading = cmd.place[2]; d.speed = 0; d.ai.yawVel = 0; d.loco?.resetPlants(); }
      if (cmd.walkTo) { d.ai.target = new THREE.Vector3(cmd.walkTo[0], 0, cmd.walkTo[1]); d.ai.bestDist = Infinity; d.ai.progressAt = clock.t; d.ai.faceTarget = null; d.ai.detour = null; }
      if (cmd.face) { d.ai.target = null; d.ai.faceTarget = new THREE.Vector3(cmd.face[0], 0, cmd.face[1]); d.ai.faceUntil = clock.t + 30; }
      if (cmd.stop) { d.ai.target = null; d.ai.faceTarget = null; }
      if (cmd.release) { d.ai.scripted = false; }
    },
    dropFoodAt: (x, z) => placeFood(x, z),
    loco: (id) => {
      const d = dinos.dinos.find((x) => x.root.name === id || x.species.id === id); if (!d || !d.loco) return null;
      return { ...d.loco.stats, legs: d.loco.legs.length, legLen: +d.loco.legLen.toFixed(2), maxSpeed: +d.loco.maxSpeed.toFixed(2), maxTurn: +d.loco.maxTurnRate.toFixed(2), speed: +d.speed.toFixed(2), gaitSpeed: +d.loco.gaitSpeed.toFixed(2), phase: +d.loco.phase.toFixed(2), cycle: +d.loco.lastCycle.toFixed(2), legsSw: d.loco.legs.map((l) => +l.t.toFixed(2) * (l.swinging ? 1 : -1)), state: d.state, eatReach: +d.eatReach.toFixed(2), heading: +d.heading.toFixed(3), pos: [+d.root.position.x.toFixed(2), +d.root.position.z.toFixed(2)], target: d.ai.target ? [+d.ai.target.x.toFixed(1), +d.ai.target.z.toFixed(1)] : null, detour: d.ai.detour ? [+d.ai.detour.x.toFixed(1), +d.ai.detour.z.toFixed(1)] : null, yawVel: +d.ai.yawVel.toFixed(2), scripted: d.ai.scripted, busy: d.isBusy, animated: d.animated, awake: d.awake, food: !!d.ai.foodTarget, steerSpeed: +d.ai.steerSpeed.toFixed(2), steerDir: +d.ai.steerDir.toFixed(2), route: d.ai.route ? d.ai.route.map((p) => [+p.x.toFixed(1), +p.z.toFixed(1)]) : null, routeIdx: d.ai.routeIdx, blocked: +d.ai.blocked.toFixed(1), real: d.real, follow: d.ai.followUntil > clock.t, face: !!d.ai.faceTarget, standAt: d.ai.standAt ? [+d.ai.standAt.x.toFixed(2), +d.ai.standAt.z.toFixed(2)] : null, standItem: d.ai.standItem ? [+d.ai.standItem.pos.x.toFixed(2), +d.ai.standItem.pos.z.toFixed(2), d.ai.standItem.eaten] : null, biteItem: d.ai.biteItem ? d.ai.biteItem.kind : null, repo: d.ai.repositions, trim: +d.eatTrim.toFixed(2), slot: d.ai.foodTarget?.eaters.get(d.index) ?? null, ph: +d.clipPhase.toFixed(2), progressAge: +(clock.t - d.ai.progressAt).toFixed(1), sniff: !!d.ai.sniffFood };
    },
    overlaps: () => overlapStats(),
    simulateSlow: (ms) => { slowSim = ms; },
    director: (cam, targetId = null, look = [0, 0, 0], height = 0.5) => { director = cam ? { cam, targetId, look, height } : null; watchId = null; dirLook.set(0, 0, 0); applyWatch(); },
    motionSample: () => {
      const out: (string | number)[][] = []; const v = new THREE.Vector3();
      for (const d of dinos.dinos) {
        if (!d.real || !d.animated || d.species.kind !== 'land') continue;
        if (Math.hypot(d.root.position.x - player.pos.x, d.root.position.z - player.pos.z) > 70) continue;
        d.snoutPos(v);
        const L = d.loco as unknown as { bones: Map<string, THREE.Bone>; lookPitch: number; lookYaw: number; reachWeight: number; lookWeight: number };
        const hip = L.bones.get('root'); const hy = hip ? hip.getWorldPosition(new THREE.Vector3()).y - d.root.position.y : 0;
        const lp = lastPush.get(d) ?? [0, 0, ''];
        out.push([d.root.name, +clock.t.toFixed(4), d.root.position.x, d.root.position.z, d.heading, v.x, v.y, v.z, d.state, d.root.position.y, hy, L.lookPitch, L.lookYaw, L.reachWeight, L.lookWeight, lp[0], lp[1], lp[2], d.ai.target ? 1 : 0, d.ai.foodTarget ? 1 : 0, d.ai.followUntil > clock.t ? 1 : 0, d.parent ? 1 : 0]);
      }
      return out;
    },
    headPos: (id) => { const d = dinos.dinos.find((x) => x.root.name === id); if (!d) return null; const v = d.snoutPos(new THREE.Vector3()); return [v.x, v.y, v.z, d.heading]; },
    clearFx: () => { weather.sparkles.clear(); weather.puffs.clear(); },
    setJawClose: (species, deg) => { for (const d of dinos.dinos) if (d.species.id === species && d.loco) d.loco.jawClose = THREE.MathUtils.degToRad(deg); },
    setDinoCulling: (on) => { Dino.cullDinos = on; for (const d of dinos.dinos) d.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = on; }); },
    probeTris: () => {
      // triangles drawn per top-level scene child (including its shadow-pass cost), by hiding each in turn
      const total = (): number => { renderer.render(scene, camera); return renderer.info.render.triangles; };
      const all = total(); const out: Record<string, number> = { all };
      for (const c of scene.children) {
        if (!c.visible) continue;
        c.visible = false; const t = total(); c.visible = true;
        const names = new Map<THREE.Object3D, string>([[terrain.group, 'terrain'], [vegetation.group, 'vegetation'], [weather.group, 'weather'], [grass.mesh, 'grass'], [dinos.group, 'dinos'], [zzz.group, 'zzz']]); if (water) names.set(water.group, 'water');
        const key = names.get(c) ?? ((c.name || c.type) + '#' + c.id);
        if (all - t > 2000) out[key] = all - t;
      }
      const lod = { lod0: 0, lod1: 0, lod0Tris: 0, lod1Tris: 0 };
      for (const d of dinos.dinos) { if (!d.real || !d.root.visible) continue; d.root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh || !m.visible) return; let vis = true; for (let q: THREE.Object3D | null = m; q; q = q.parent) if (!q.visible) vis = false; if (!vis) return; const n = (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; if (/_lod1/.test(m.name)) { lod.lod1++; lod.lod1Tris += n; } else { lod.lod0++; lod.lod0Tris += n; } }); }
      const sm = renderer.shadowMap.enabled;
      renderer.shadowMap.enabled = false; const noSh = total(); dinos.group.visible = false; const noShNoDino = total(); dinos.group.visible = true; renderer.shadowMap.enabled = sm;
      out.noShadowAll = noSh; out.noShadowDinos = noSh - noShNoDino; out.calls = (renderer.render(scene, camera), renderer.info.render.calls);
      // draws per dinosaur mesh in one main pass (shadows off)
      const draws = new Map<string, number>(); const hooks: [THREE.Mesh, THREE.Mesh['onAfterRender']][] = [];
      dinos.group.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; hooks.push([m, m.onAfterRender]); const key = (m.parent?.parent?.parent?.name || '') + '/' + m.name + '/' + (m.geometry.index ? m.geometry.index.count / 3 : 0); m.onAfterRender = () => { draws.set(key, (draws.get(key) ?? 0) + 1); }; });
      renderer.shadowMap.enabled = false; total(); renderer.shadowMap.enabled = sm;
      for (const [m, f] of hooks) m.onAfterRender = f;
      let drawTris = 0; for (const [k, n] of draws) drawTris += +k.split('/').pop()! * n;
      (out as Record<string, unknown>).draws = [...draws.entries()].filter(([k]) => +k.split('/').pop()! > 1000).map(([k, n]) => k + ' x' + n);
      out.drawTris = drawTris;
      const per: [string, number, number][] = [];
      for (const d of dinos.dinos) {
        if (!d.root.visible) continue;
        let own = 0; d.root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh || !m.visible) return; let vis = true; for (let q: THREE.Object3D | null = m; q; q = q.parent) if (!q.visible) vis = false; if (vis) own += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3; });
        d.root.visible = false; const t = total(); d.root.visible = true;
        per.push([d.root.name + (d.parent ? '(baby)' : '') + (d.real ? '' : '[ph]'), all - t, own]);
      }
      per.sort((a, b) => b[1] - a[1]);
      const other: string[] = []; dinos.group.children.forEach((c) => { if (!dinos.dinos.some((d) => d.root === c)) other.push(c.type + ':' + c.name); });
      return { ...out, ...lod, top: per.slice(0, 8) as unknown as number, dinoRoots: per.length, other: other.length } as Record<string, number>;
    },
    probeMem: () => {
      const tex = new Set<THREE.Texture>(), geo = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
      for (const d of dinos.dinos) d.root.traverse((o) => { const m = o as THREE.Mesh; if (!m.isMesh) return; geo.add(m.geometry); for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) { mats.add(mt); for (const v of Object.values(mt)) if ((v as THREE.Texture)?.isTexture) tex.add(v as THREE.Texture); } });
      return { dinoTextures: tex.size, dinoGeometries: geo.size, dinoMaterials: mats.size, placeholders: dinos.dinos.filter((d) => !d.real).length, info: renderer.info.memory };
    },
    probeVis: (id: string) => {
      const d = dinos.dinos.find((x) => x.root.name === id); if (!d) return null;
      const box = new THREE.Box3(); let meshes = 0, visMeshes = 0;
      d.root.updateMatrixWorld(true);
      d.root.traverse((o) => { const m = o as THREE.SkinnedMesh; if (m.isMesh) { meshes++; if (m.visible) visMeshes++; m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld); box.union(bb); } });
      let chainVisible = true; for (let o: THREE.Object3D | null = d.root; o; o = o.parent) if (!o.visible) chainVisible = false;
      return { rootVisible: d.root.visible, chainVisible, meshes, visMeshes, pos: d.root.position.toArray().map((v) => +v.toFixed(1)), box: [box.min.toArray().map((v) => +v.toFixed(1)), box.max.toArray().map((v) => +v.toFixed(1))], scale: d.root.scale.x, modelScale: d.model?.scale.x, real: d.real, animated: d.animated, state: d.state, cam: camera.position.toArray().map((v) => +v.toFixed(1)) };
    },
    probeDino: (id: string) => {
      const d = dinos.dinos.find((x) => x.root.name === id || x.species.id === id); if (!d || !d.loco) return null;
      const v = new THREE.Vector3(); const out: Record<string, unknown> = { eatReach: d.eatReach, eatHeight: d.eatHeight };
      d.root.updateMatrixWorld(true);
      for (const n of ['root', 'head', 'snout', 'jaw', 'neck1', 'spine1']) { const b = d.loco.bones.get(n); if (b) { b.getWorldPosition(v); d.root.worldToLocal(v); out[n] = [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]; } }
      out.bones = [...d.loco.bones.keys()].length;
      const cur = (d as unknown as { current: THREE.AnimationAction | null }).current;
      out.clip = cur ? { name: cur.getClip().name, time: +cur.time.toFixed(2), w: +cur.getEffectiveWeight().toFixed(2), running: cur.isRunning() } : null;
      out.state = d.state; out.stateTime = +d.stateTime.toFixed(2); out.reachW = +d.loco.reachWeight.toFixed(2);
      if (d.loco.snoutWorld(v)) out.snoutWorldY = +(v.y - d.root.position.y).toFixed(2);
      return out;
    },
    biteLog: () => biteLog,
    audioStats: () => ({ ready: samples.ready, loaded: samples.loaded, plays: samples.plays, state: audio.ctx.state }),
    foods: () => foods.map((f) => ({ x: +f.pos.x.toFixed(1), z: +f.pos.z.toFixed(1), amount: +f.amount.toFixed(2), items: f.items.length, eaters: [...f.eaters.keys()] })),
  };
  (window as unknown as { __dino: DinoApi }).__dino = api;
  const overlapStats = (): { dinoDino: number; dinoTree: number; worst: number } => {
    let dd = 0, dt = 0, worst = 0;
    const land = dinos.dinos.filter((d) => d.awake && d.species.kind === 'land');
    const cap = (d: Dino, k = 1): [number, number, number, number, number] => { const b = bodyOf(d); const s = Math.sin(d.heading), c = Math.cos(d.heading); const p = d.root.position; return [p.x - s * b.back, p.z - c * b.back, p.x + s * b.front * k, p.z + c * b.front * k, b.r]; };
    const seg = (px: number, pz: number, ax: number, az: number, bx: number, bz: number): number => { const ex = bx - ax, ez = bz - az; const l2 = ex * ex + ez * ez; const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0; return Math.hypot(px - ax - ex * t, pz - az - ez * t); };
    for (let i = 0; i < land.length; i++) {
      const A = cap(land[i]);
      for (let j = i + 1; j < land.length; j++) {
        const co = !!land[i].ai.foodTarget && land[i].ai.foodTarget === land[j].ai.foodTarget;
        const B = cap(land[j], co ? 0.35 : 1); const A2 = co ? cap(land[i], 0.35) : A;
        const dist = Math.min(seg(A2[0], A2[1], B[0], B[1], B[2], B[3]), seg(A2[2], A2[3], B[0], B[1], B[2], B[3]), seg(B[0], B[1], A2[0], A2[1], A2[2], A2[3]), seg(B[2], B[3], A2[0], A2[1], A2[2], A2[3]));
        const pen = A2[4] + B[4] - dist; if (pen > 0.05) { dd++; worst = Math.max(worst, pen); }
      }
      for (const o of obstacles.near(land[i].root.position.x, land[i].root.position.z, 30, [])) {
        const pen = o.r + A[4] - seg(o.x, o.z, A[0], A[1], A[2], A[3]); if (pen > 0.05) { dt++; worst = Math.max(worst, pen); }
      }
    }
    return { dinoDino: dd, dinoTree: dt, worst: +worst.toFixed(2) };
  };

  // Resolution governor: unknown iPads (and any iPad warming up over a long session) get a steady frame
  // rate by trading sharpness first, then the low tier; it climbs back when frames are comfortably fast.
  const governorOn = !forcedQ || params.has('gov');   // tests that force a tier keep it fixed unless they ask
  let renderScale = 1, govT = 0, govCool = 0, govFastT = 0, slowSim = 0, loadingNow = true, loadQuietT = 0, upgradedAt = -99, upgradeBlockUntil = 0, govEvaluated = false;
  const govFrames: number[] = [];
  const pixelRatioFor = (q: Quality): number => Math.max(0.75, Math.min(window.devicePixelRatio, q.pixelRatio) * renderScale);
  const setScale = (k: number): void => { renderScale = k; renderer.setPixelRatio(pixelRatioFor(quality)); renderer.setSize(window.innerWidth, window.innerHeight); };
  const govern = (rawDt: number): void => {
    if (paused || document.hidden || rawDt > 0.25) return;          // tab switches say nothing about load
    if (loadingNow) { loadQuietT = 0; govFrames.length = 0; govT = 0; return; }
    loadQuietT += rawDt; if (loadQuietT < 3) return;                  // streaming hitches are not the steady state
    govFrames.push(rawDt * 1000); govT += rawDt; govCool -= rawDt;
    if (govT < 2) return;
    govFrames.sort((a, b) => a - b); const med = govFrames[govFrames.length >> 1];   // median: robust to GC / shader-compile spikes
    govFrames.length = 0; govT = 0;
    if (govCool > 0) return;
    const now = clock.t;
    const first = !govEvaluated; govEvaluated = true;
    if (first && med > 30 && quality.tier === 'high') { applyQuality({ ...QUALITY_LOW }); govCool = 4; return; }   // clearly a slow device: straight to low
    if (med > 22) {
      govFastT = 0;
      if (now - upgradedAt < 10) upgradeBlockUntil = now + 90;         // the last upgrade was too much: stay put a while
      if (renderScale > 0.72) { setScale(Math.max(0.7, renderScale - 0.15)); govCool = 3; }
      else if (quality.tier === 'high') { renderScale = 1; applyQuality({ ...QUALITY_LOW }); govCool = 4; }
    } else if (med < 17.8 && renderScale < 1 && now > upgradeBlockUntil) {   // holding vsync (60 Hz): try sharper
      govFastT += 2;
      if (govFastT >= 10) { govFastT = 0; setScale(Math.min(1, renderScale + 0.15)); upgradedAt = now; govCool = 3; }
    } else govFastT = 0;
  };
  const applyQuality = (q: Quality): void => {
    setQuality(q);
    renderer.setPixelRatio(pixelRatioFor(q));
    renderer.setSize(window.innerWidth, window.innerHeight);
    sky.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
    if (sky.sun.shadow.map) { sky.sun.shadow.map.dispose(); sky.sun.shadow.map = null; }
  };

  let fps = 60, frameMs = 16; let dinoMs = 0, dinoMaxMs = 0; 
  let last = performance.now();
  let running = true; let raf = 0;
  const biomeW = new Float32Array(BIOME_IDS.length);
  const camDir = new THREE.Vector3();
  const shadowCenter = new THREE.Vector3();
  const pushBuf = new Float32Array(64); const pushNear: [number, Dino][] = [];

  let paused = false;
  let director: { cam: [number, number, number]; targetId: string | null; look: [number, number, number]; height: number } | null = null; const dirLook = new THREE.Vector3();
  let watchId: string | null = null; const watchCfg = { az: 1.57, el: 0.12, dist: 14, height: 0.5, head: false };
  const frame = (): void => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const rawDt = (now - last) / 1000; last = now;
    frameMs += (rawDt * 1000 - frameMs) * 0.05; fps = 1000 / Math.max(frameMs, 1);
    if (slowSim > 0) { const t = performance.now(); while (performance.now() - t < slowSim) { /* test hook: emulate a slow device */ } }
    if (governorOn && api.ready) govern(rawDt);
    if (!paused) tick(Math.min(rawDt, 0.05), rawDt);
    applyWatch();
    renderer.render(scene, camera);
  };
  const applyWatch = (): void => {
    if (director) {
      // fixed film camera (demo reels): stays put in the world and follows a dinosaur or looks at a point
      const t = new THREE.Vector3(...director.look);
      const d = director.targetId ? dinos.dinos.find((x) => x.root.name === director!.targetId) : null;
      if (d) t.set(d.root.position.x, d.root.position.y + d.species.heightM * d.scale * director.height, d.root.position.z);
      dirLook.lerp(t, dirLook.lengthSq() ? 0.2 : 1);
      camera.position.set(...director.cam); camera.lookAt(dirLook);
      return;
    }
    if (!watchId) return;
    const d = dinos.dinos.find((x) => x.root.name === watchId);
    if (!d) return;
    const p = d.root.position; const a = d.heading + watchCfg.az;
    let tx = p.x, ty = p.y + d.species.heightM * watchCfg.height, tz = p.z;
    if (watchCfg.head) { const h = d.snoutPos(new THREE.Vector3()); tx = h.x; ty = h.y; tz = h.z; }   // frame the head (asset review)
    camera.position.set(tx + Math.sin(a) * Math.cos(watchCfg.el) * watchCfg.dist, ty + Math.sin(watchCfg.el) * watchCfg.dist, tz + Math.cos(a) * Math.cos(watchCfg.el) * watchCfg.dist);
    camera.lookAt(tx, ty, tz);
  };
  const tick = (dt: number, _rawDt: number): void => {
    clock.t += dt; ctx.time = clock.t;
    if (magicTarget !== null) {
      let diff = magicTarget - sky.hours; if (diff < 0) diff += 24;
      sky.speed = 140;
      if (diff < 0.25 || diff > 23.5) { sky.setTime(magicTarget); sky.speed = 1; magicTarget = null; }
    }
    player.update(dt);
    applyWatch();   // test camera (if any) before culling
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
    // grass parts around the explorer, food piles and the nearest dinosaurs
    {
      let n = 0; const P = pushBuf; const add = (x: number, z: number, r: number, k: number): void => { if (n < 16) { P[n * 4] = x; P[n * 4 + 1] = z; P[n * 4 + 2] = r; P[n * 4 + 3] = k; n++; } };
      add(player.pos.x, player.pos.z, 0.55, 0.9);
      for (const f of foods) if (f.amount > 0) add(f.pos.x, f.pos.z, f.radius * 1.1, 1);
      pushNear.length = 0;
      for (const d of dinos.dinos) { if (!d.real || !d.root.visible || d.species.kind !== 'land') continue; const dd = Math.hypot(d.root.position.x - camera.position.x, d.root.position.z - camera.position.z); if (dd < 32) pushNear.push([dd, d]); }
      pushNear.sort((a, b) => a[0] - b[0]);
      for (const [, d] of pushNear) {
        if (n > 14) break;
        const b = bodyOf(d); const sx = Math.sin(d.heading), cz = Math.cos(d.heading); const p = d.root.position; const r = b.r * 1.15 + 0.15;
        add(p.x + sx * b.front * 0.55, p.z + cz * b.front * 0.55, r, 0.85);
        add(p.x - sx * b.back * 0.45, p.z - cz * b.back * 0.45, r, 0.85);
      }
      grass.setPushers(P, n);
    }
    grass.update(dt, player.pos.x, player.pos.z, light, sky.state.night > 0.5 ? sky.state.moonDir : sky.state.sunDir);
    weather.update(dt, camera.position, player.pos, biomeW, sky.state, renderer.getPixelRatio());
    obstacles.update(clock.t);
    keepClear[0][0] = player.pos.x; keepClear[0][1] = player.pos.z;
    keepClear[1][0] = camera.position.x; keepClear[1][1] = camera.position.z;
    ctx.night = sky.state.night;
    ctx.view.copy(camDir).setY(0); if (ctx.view.lengthSq() < 1e-6) ctx.view.set(0, 0, -1); ctx.view.normalize();
    const tD = performance.now();
    dinos.update(dt, ctx, shadowCenter, camera);
    const dMs = performance.now() - tD; dinoMs += (dMs - dinoMs) * 0.05; dinoMaxMs = Math.max(dinoMaxMs * 0.995, dMs);
    foodSystem.update(dt);
    zzz.update(dt);
    ambience.update(dt, biomeW, sky.state.night, weather.rainAmount);
    music.update(sky.state.night);
    loadingNow = vegetation.loadedCount < vegetation.species.size || dinos.dinos.some((d) => d.loading);   // something near the child is still arriving
    hud.setLoading(loadingNow);
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
    if (nav.wakeLock && !wakeLock) {
      const lock = await nav.wakeLock.request('screen') as { release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void };
      wakeLock = lock;
      lock.addEventListener?.('release', () => { if (wakeLock === lock) wakeLock = null; });   // the OS drops it when the page hides
    }
  } catch { wakeLock = null; }
}

main().catch((e) => { console.error(e); errors.push(String(e)); });
