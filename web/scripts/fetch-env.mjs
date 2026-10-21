// Fetches CC0 environment assets from Poly Haven and converts them into lean
// GLBs (meshopt + WebP, 2 LODs as root nodes "LOD0"/"LOD1") and WebP ground
// textures. Output: public/assets/env/. Re-runnable; skips finished assets.
//
//   node scripts/fetch-env.mjs [--force] [--only name,name]
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, flatten, join, weld, simplify, simplifyPrimitive, meshopt, textureCompress, resample, cloneDocument, mergeDocuments,
} from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { buildCardTexture, canopyCards } from './canopy.mjs';
import { extractLeaves, crownOf, pickLeaves, writeLeafQuads, keepLimbs } from './foliage.mjs';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { encodeToKTX2 } from 'ktx2-encoder';

const ktxDecoder = async (buf) => { const { data, info } = await sharp(Buffer.from(buf)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: info.width, height: info.height, data: new Uint8Array(data) }; };
/** ETC1S/Basis KTX2 (sRGB, mipmapped) of an RGBA raw image: transcodes to ASTC / ETC2 / BC7 on the GPU. */
async function writeKtx2(rgba, size, file, srgb = true) {
  const png = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const out = await encodeToKTX2(new Uint8Array(png), { isUASTC: false, qualityLevel: 220, compressionLevel: 2, generateMipmap: true, isKTX2File: true, isPerceptual: srgb, isSetKTX2SRGBTransferFunc: srgb, imageDecoder: ktxDecoder });
  await fs.writeFile(file, out);
}

function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'assets', 'env');
const TMP = path.join(os.tmpdir(), 'dino-polyhaven');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1].split(',') : null; })();

/** @type {Record<string, {kind:'tree'|'plant'|'rock', tris:number, lod1:number, tex:number, leafTex?:number}>} */
const MODELS = {
  fir_tree_01: { kind: 'tree', tris: 8000, lod1: 1000, tex: 512, leafTex: 512, canopy: { key: 'twig', cards0: 700, cards1: 160, copies: 8, copyScale: [0.3, 0.5], maxSprites: 12, sizeMul: 0.8, discRadius: 0.3, tint: [0.85, 0.9, 0.8] } },
  pine_tree_01: { kind: 'tree', tris: 8000, lod1: 1000, tex: 512, leafTex: 512, canopy: { key: 'twig', cards0: 700, cards1: 160, copies: 14, copyScale: [0.3, 0.5], maxSprites: 12, sizeMul: 0.8, discRadius: 0.36, tint: [0.85, 0.9, 0.8] } },
  island_tree_01: { kind: 'tree', tris: 7200, lod1: 1600, tex: 512, leafTex: 512, foliage: { leaves0: 2600, leaves1: 620, limbs: 30000, cover: 0.95 } },
  island_tree_02: { kind: 'tree', tris: 7200, lod1: 1600, tex: 512, leafTex: 512, foliage: { leaves0: 2600, leaves1: 620, limbs: 30000, cover: 0.95 } },
  island_tree_03: { kind: 'tree', tris: 7200, lod1: 1600, tex: 512, leafTex: 512, foliage: { leaves0: 2600, leaves1: 620, limbs: 30000, cover: 0.95 } },
  jacaranda_tree: { kind: 'tree', tris: 22000, lod1: 3600, tex: 512, leafTex: 512, foliage: { leaves0: 8000, leaves1: 1500, limbs: 60000, cover: 0.55 } },
  tree_small_02: { kind: 'tree', tris: 5800, lod1: 1300, tex: 512, leafTex: 512, foliage: { leaves0: 1900, leaves1: 480, limbs: 20000, cover: 0.9 } },
  dead_tree_trunk: { kind: 'tree', tris: 5000, lod1: 900, tex: 512 },
  dead_tree_trunk_02: { kind: 'tree', tris: 5000, lod1: 900, tex: 512 },
  quiver_tree_01: { kind: 'tree', tris: 8000, lod1: 1000, tex: 512, leafTex: 512 },
  dead_quiver_trunk: { kind: 'tree', tris: 5000, lod1: 1000, tex: 512 },
  tree_stump_01: { kind: 'rock', tris: 1500, lod1: 300, tex: 512 },
  pine_sapling_medium: { kind: 'plant', tris: 2500, lod1: 600, tex: 512, norTex: 256, leafTex: 512, canopy: { key: 'twig', cards0: 160, cards1: 50, copies: 12, copyScale: [0.3, 0.5], maxSprites: 12, sizeMul: 0.85, tint: [0.85, 0.9, 0.8] } },
  searsia_lucida: { kind: 'plant', tris: 2000, lod1: 500, tex: 512, norTex: 256, leafTex: 512 },
  fern_02: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  shrub_01: { kind: 'plant', tris: 2400, lod1: 600, tex: 512, leafTex: 512, foliage: { leaves0: 1100, leaves1: 260, limbs: 0, cover: 0.85, leafMat: 'shrub' } },
  shrub_02: { kind: 'plant', tris: 1400, lod1: 500, tex: 512, leafTex: 512, foliage: { leaves0: 260, leaves1: 90, limbs: 0, cover: 0.9, leafMat: 'shrub' } },
  shrub_03: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  shrub_04: { kind: 'plant', tris: 1000, lod1: 300, tex: 512, leafTex: 512, foliage: { leaves0: 420, leaves1: 120, limbs: 0, cover: 0.9, leafMat: 'shrub' } },
  nettle_plant: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  weed_plant_02: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  wild_rooibos_bush: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  flower_gazania: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  flower_ursinia: { kind: 'plant', tris: 1500, lod1: 400, tex: 512, norTex: 256, leafTex: 512 },
  boulder_01: { kind: 'rock', tris: 3500, lod1: 700, tex: 512 },
  rock_07: { kind: 'rock', tris: 1500, lod1: 300, tex: 512 },
  rock_09: { kind: 'rock', tris: 1500, lod1: 300, tex: 512 },
  rock_moss_set_01: { kind: 'rock', tris: 2500, lod1: 500, tex: 512 },
  namaqualand_boulder_02: { kind: 'rock', tris: 1500, lod1: 300, tex: 512 },
  moon_rock_03: { kind: 'rock', tris: 1500, lod1: 300, tex: 512 },
  rock_face_01: { kind: 'rock', tris: 3000, lod1: 600, tex: 512 },
};

// Ground layers (order = GROUND_LAYERS in src/world/biomes.ts) + the near-camera detail texture.
const TEXTURES = [
  'grass_ground', 'aerial_grass_rock', 'forest_floor', 'forest_leaves_02', 'aerial_sand', 'damp_beach_sand',
  'brown_mud_03', 'cracked_red_ground', 'dark_rock', 'dry_riverbed_rock', 'snow_02', 'aerial_rocks_02',
  'rock_ground_02', 'cliff_side', 'brown_mud_leaves_01', 'floor_pebbles_01',
];

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'dino-pals-fetch' } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function download(url, dest) {
  try { const st = await fs.stat(dest); if (st.size > 0) return; } catch {}
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'dino-pals-fetch' } });
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) { if (attempt === 3) throw e; await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); }
  }
}

/** Foliage cards (alpha-masked quads): keep a random subset and enlarge the survivors
 *  so the canopy stays dense. Returns the number of triangles after thinning. */
function thinCards(doc, targetTris, scaleUp, rnd) {
  let total = 0, cardTris = 0;
  const cardPrims = [];
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices(); if (!idx) continue;
    const n = idx.getCount() / 3; total += n;
    const mat = prim.getMaterial();
    if (mat && mat.getAlphaMode() !== 'OPAQUE') { cardPrims.push(prim); cardTris += n; }
  }
  if (!cardPrims.length || cardTris <= targetTris) return { total, thinned: false };
  const keep = targetTris / cardTris;
  for (const prim of cardPrims) {
    const idxAcc = prim.getIndices(); const posAcc = prim.getAttribute('POSITION');
    const idx = Array.from(idxAcc.getArray()); const pos = Float32Array.from(posAcc.getArray());
    const out = [];
    const scaled = new Set();
    let t = 0;
    while (t < idx.length) {
      // a card = two triangles sharing an edge; otherwise handle a single triangle
      const a = idx.slice(t, t + 3), b = idx.slice(t + 3, t + 6);
      const sharedCount = b.length === 3 ? a.filter((v) => b.includes(v)).length : 0;
      const span = sharedCount >= 2 ? 6 : 3;
      if (rnd() <= keep) {
        const vs = new Set(idx.slice(t, t + span)); const cx = [0, 0, 0];
        for (const v of vs) { cx[0] += pos[v * 3]; cx[1] += pos[v * 3 + 1]; cx[2] += pos[v * 3 + 2]; }
        for (let k = 0; k < 3; k++) cx[k] /= vs.size;
        for (const v of vs) { if (scaled.has(v)) continue; scaled.add(v); for (let k = 0; k < 3; k++) pos[v * 3 + k] = cx[k] + (pos[v * 3 + k] - cx[k]) * scaleUp; }
        for (let k = t; k < Math.min(t + span, idx.length); k++) out.push(idx[k]);
      }
      t += span;
    }
    posAcc.setArray(pos);
    if (out.length === 0) { prim.dispose(); continue; }
    idxAcc.setArray(posAcc.getCount() > 65535 ? new Uint32Array(out) : new Uint16Array(out));
  }
  for (const mesh of doc.getRoot().listMeshes()) if (!mesh.listPrimitives().length) mesh.dispose();
  let after = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) { const i = prim.getIndices(); if (i) after += i.getCount() / 3; }
  return { total: after, thinned: true };
}

async function simplifyTo(doc, target, startError = 0.02) {
  // simplify only opaque primitives (foliage cards are thinned separately by thinCards)
  const opaquePrims = () => { const out = []; for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const mat = p.getMaterial(); if ((!mat || mat.getAlphaMode() === 'OPAQUE') && p.getIndices()) out.push(p); } return out; };
  const triCount = (p) => p.getIndices().getCount() / 3;
  const cardTris = () => countTris(doc) - opaquePrims().reduce((n, p) => n + triCount(p), 0);
  const budget = Math.max(200, target - cardTris());
  for (const error of [startError, 0.05, 0.12, 0.3]) {
    const prims = opaquePrims(); const tris = prims.reduce((n, p) => n + triCount(p), 0);
    if (tris <= budget * 1.08) return;
    const ratio = Math.min(1, budget / tris);
    for (const p of prims) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio, error, lockBorder: false });
  }
  // topology-blocked meshes: fall back to the sloppy (vertex-clustering) simplifier per primitive
  const prims = opaquePrims(); const total = prims.reduce((n, p) => n + triCount(p), 0);
  if (total <= budget * 1.08) return;
  for (const prim of prims) {
    const idxAcc = prim.getIndices(); const posAcc = prim.getAttribute('POSITION');
    const idx = new Uint32Array(idxAcc.getArray());
    const pos = new Float32Array(posAcc.getArray());
    const share = (idx.length / 3) / total;
    const targetIdx = Math.max(3, Math.floor(budget * share)) * 3;
    if (idx.length <= targetIdx) continue;
    const [res] = MeshoptSimplifier.simplifySloppy(idx, pos, 3, null, targetIdx, 1.0);
    idxAcc.setArray(posAcc.getCount() > 65535 ? new Uint32Array(res) : new Uint16Array(res));
  }
  await doc.transform(weld(), prune());
}

function countTris(doc) {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const idx = p.getIndices(); const pos = p.getAttribute('POSITION');
    n += (idx ? idx.getCount() : pos.getCount()) / 3;
  }
  return n;
}

async function processModel(name, cfg, io, credits) {
  const outFile = path.join(OUT, `${name}.glb`);
  if (!FORCE) { try { await fs.stat(outFile); console.log(`skip ${name}`); return; } catch {} }
  const info = await fetchJson(`https://api.polyhaven.com/files/${name}`);
  const g = info.gltf?.['1k']?.gltf; if (!g) throw new Error(`${name}: no 1k gltf`);
  const dir = path.join(TMP, name);
  const gltfPath = path.join(dir, `${name}.gltf`);
  await download(g.url, gltfPath);
  const includes = Object.entries(g.include || {});
  await Promise.all(includes.map(([rel, f]) => download(f.url, path.join(dir, rel))));
  const meta = await fetchJson(`https://api.polyhaven.com/info/${name}`).catch(() => ({}));
  credits[name] = { type: 'model', name: meta.name || name, authors: meta.authors || {}, license: 'CC0', url: `https://polyhaven.com/a/${name}` };

  const doc = await io.read(gltfPath);
  const before = countTris(doc);
  await doc.transform(dedup(), prune());
  // Poly Haven ships MASK/BLEND leaf materials with RGB-only JPGs: pack the asset's alpha map into the diffuse.
  for (const mat of doc.getRoot().listMaterials()) {
    if (mat.getAlphaMode() === 'OPAQUE') continue;
    const tex = mat.getBaseColorTexture(); if (!tex) continue;
    const meta = await sharp(Buffer.from(tex.getImage())).metadata();
    if (meta.hasAlpha) continue;
    const uri = tex.getURI() || '';
    const m = /_(?:([a-z0-9_]+?)_)?diff_1k\.(?:jpg|png)$/i.exec(uri.replace(`${name}`, ''));
    const sub = m && m[1] ? m[1] : null;
    const alphaKey = sub ? `${sub}_alpha` : (info.Alpha ? 'Alpha' : 'alpha');
    const alphaUrl = info[alphaKey]?.['1k']?.jpg?.url ?? info[alphaKey]?.['1k']?.png?.url;
    if (!alphaUrl) { console.warn(`${name}: no alpha map for ${uri} (${alphaKey}); forcing opaque`); mat.setAlphaMode('OPAQUE'); continue; }
    const alphaPath = path.join(dir, 'textures', `${name}_${alphaKey}_1k.jpg`);
    await download(alphaUrl, alphaPath);
    const rgb = await sharp(Buffer.from(tex.getImage())).removeAlpha().raw().toBuffer();
    const a = await sharp(alphaPath).greyscale().resize(meta.width, meta.height).raw().toBuffer();
    const rgba = Buffer.alloc(meta.width * meta.height * 4);
    for (let i = 0; i < meta.width * meta.height; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = a[i]; }
    const png = await sharp(rgba, { raw: { width: meta.width, height: meta.height, channels: 4 } }).png().toBuffer();
    tex.setImage(new Uint8Array(png)).setMimeType('image/png').setURI(uri.replace(/\.jpg$/i, '.png'));
    mat.setAlphaMode('MASK').setAlphaCutoff(0.5);
  }
  // Poly Haven sets: each root node is a variant. Keep up to 6 (largest first).
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const variantInfo = scene.listChildren().map((n) => { const b = getBounds(n); return { b, h: b.max[1] - b.min[1], w: Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) }; });
  variantInfo.sort((x, y) => (y.h * y.w) - (x.h * x.w));
  const keep = variantInfo.slice(0, 6).filter((v) => v.h > 0.01);
  await doc.transform(flatten());
  // assign every mesh node to the variant whose (world) footprint contains its centroid
  const groups = keep.map(() => []);
  for (const c of scene.listChildren()) {
    if (!c.getMesh()) { c.dispose(); continue; }
    const cb = getBounds(c); const ccx = (cb.min[0] + cb.max[0]) / 2, ccz = (cb.min[2] + cb.max[2]) / 2;
    let best = -1, bd = 1e9;
    for (let i = 0; i < keep.length; i++) {
      const v = keep[i];
      const inside = ccx >= v.b.min[0] - 1e-3 && ccx <= v.b.max[0] + 1e-3 && ccz >= v.b.min[2] - 1e-3 && ccz <= v.b.max[2] + 1e-3;
      const dist = Math.hypot(ccx - (v.b.min[0] + v.b.max[0]) / 2, ccz - (v.b.min[2] + v.b.max[2]) / 2) + (inside ? 0 : 1e6);
      if (dist < bd) { bd = dist; best = i; }
    }
    if (best < 0 || bd >= 1e6) { c.dispose(); continue; }
    groups[best].push(c);
  }
  const lod0Nodes = [];
  for (let i = 0; i < keep.length; i++) {
    if (!groups[i].length) continue;
    const v = keep[i];
    const vn = doc.createNode(`V${lod0Nodes.length}_LOD0`);
    const cx = (v.b.min[0] + v.b.max[0]) / 2, cz = (v.b.min[2] + v.b.max[2]) / 2, cy = v.b.min[1];
    for (const c of groups[i]) { scene.removeChild(c); vn.addChild(c); }
    vn.setTranslation([-cx, -cy, -cz]);
    scene.addChild(vn); lod0Nodes.push(vn);
  }
  await doc.transform(join({ keepNamed: false }), weld());
  // join() merges meshes inside each V*_LOD0 group (it keeps separate parents separate)
  const nvar = Math.max(1, lod0Nodes.length * 0.6);
  const rnd0 = mulberry(1234);
  let canopyMat = null, cardCount = 0;
  // real-leaf foliage: one fitted quad per modelled leaf, outer-weighted subset, bent normals + crown AO
  const leafSets = [];
  const leafRx = new RegExp(cfg.foliage?.leafMat ?? 'leaf|leaves|frond', 'i');
  const isLeafMat = (mat) => mat && (mat.getAlphaMode() !== 'OPAQUE' || /^canopy_/.test(mat.getName()) === false && cfg.foliage?.leafMat) && leafRx.test(mat.getName());
  if (cfg.foliage) {
    const f = cfg.foliage;
    const sets = [];
    for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (isLeafMat(mat)) { const leaves = extractLeaves(prim); if (leaves.length > 8) sets.push({ prim, leaves, crown: crownOf(leaves) }); }
      else if (mat && mat.getAlphaMode() === 'OPAQUE' && /branch|twig/i.test(mat.getName())) keepLimbs(prim, f.limbs);
    }
    const maxLeaves = Math.max(1, ...sets.map((x) => x.leaves.length));
    for (const set of sets) {
      const share = Math.sqrt(set.leaves.length / maxLeaves);
      set.n0 = Math.min(set.leaves.length, Math.round(f.leaves0 * share)); set.n1 = Math.min(set.leaves.length, Math.round(f.leaves1 * share));
      set.s0 = Math.min(5, Math.max(1, Math.sqrt(set.leaves.length / set.n0) * f.cover));
      set.s1 = Math.min(9, Math.max(1, Math.sqrt(set.leaves.length / set.n1) * f.cover * 1.08));
      cardCount += writeLeafQuads(doc, set.prim, pickLeaves(set.leaves, set.crown, set.n0, rnd0), set.crown, set.s0);
      leafSets.push(set);
    }
    for (const mat of doc.getRoot().listMaterials()) if (isLeafMat(mat)) { mat.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null).setDoubleSided(true).setAlphaMode('MASK').setAlphaCutoff(0.5).setRoughnessFactor(0.85).setMetallicFactor(0); }
    for (const mat of doc.getRoot().listMaterials()) if (!isLeafMat(mat)) { mat.setOcclusionTexture(null).setMetallicRoughnessTexture(null).setRoughnessFactor(0.9).setMetallicFactor(0); }
    await doc.transform(prune());
    console.log(`${name}: foliage ${sets.map((x) => `${x.leaves.length}->${x.n0}/${x.n1} x${x.s0.toFixed(1)}/${x.s1.toFixed(1)}`).join(' ')}`);
  }
  if (cfg.canopy) {
    // download the alpha map, compose a cluster texture, swap leaf geometry for cards
    const alphaUrl = info[`${cfg.canopy.key}_alpha`]?.['1k']?.jpg?.url;
    const diffRel = Object.keys(g.include || {}).find((k) => k.includes(`${cfg.canopy.key}_diff`));
    if (alphaUrl && diffRel) {
      const alphaPath = path.join(dir, 'textures', `${name}_${cfg.canopy.key}_alpha_1k.jpg`);
      await download(alphaUrl, alphaPath);
      const webp = await buildCardTexture(await fs.readFile(path.join(dir, diffRel)), await fs.readFile(alphaPath), cfg.canopy, mulberry(7));
      doc.createExtension(EXTTextureWebP).setRequired(true);
      const tex = doc.createTexture(`canopy_${name}`).setImage(new Uint8Array(webp)).setMimeType('image/webp').setURI(`canopy_${name}.webp`);
      canopyMat = doc.createMaterial(`canopy_${name}`).setBaseColorTexture(tex).setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(0.9);
      if (cfg.canopy.tint) canopyMat.setBaseColorFactor([...cfg.canopy.tint, 1]);
      for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial();
        const leafy = mat && mat !== canopyMat && (mat.getAlphaMode() !== 'OPAQUE' || /twig|leaf|leaves|needle|foliage/i.test(mat.getName()));
        if (leafy) cardCount += canopyCards(doc, prim, cfg.canopy.cards0, canopyMat, rnd0, cfg.canopy.sizeMul ?? 1.0);
      }
      await doc.transform(prune());
    }
  }
  if (!canopyMat && !cfg.foliage) thinCards(doc, cfg.tris * nvar * 0.75, 1.6, rnd0);
  await simplifyTo(doc, cfg.tris * nvar);
  const lod0Tris = countTris(doc);
  const lodDoc = cloneDocument(doc);
  if (canopyMat) {
    const rnd1 = mulberry(99);
    const lodMat = lodDoc.getRoot().listMaterials().find((m) => m.getName() === `canopy_${name}`);
    for (const mesh of lodDoc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
      if (prim.getMaterial() === lodMat) canopyCards(lodDoc, prim, cfg.canopy.cards1, lodMat, rnd1, 1.7 * (cfg.canopy.sizeMul ?? 1.0));
    }
    await lodDoc.transform(prune());
  } else if (cfg.foliage) {
    const rnd1 = mulberry(99); let k = 0;
    for (const mesh of lodDoc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
      if (!isLeafMat(prim.getMaterial()) || k >= leafSets.length) continue;
      const set = leafSets[k++];
      writeLeafQuads(lodDoc, prim, pickLeaves(set.leaves, set.crown, set.n1, rnd1, 1.6), set.crown, set.s1);
    }
    await lodDoc.transform(prune());
  } else thinCards(lodDoc, cfg.lod1 * nvar * 0.8, 1.9, mulberry(99));
  await simplifyTo(lodDoc, cfg.lod1 * nvar, 0.08);
  const lod1Tris = countTris(lodDoc);
  for (const s2 of lodDoc.getRoot().listScenes()) for (const n of s2.listChildren()) n.setName(n.getName().replace('LOD0', 'LOD1'));
  mergeDocuments(doc, lodDoc);
  const scenes = doc.getRoot().listScenes();
  const [main, ...rest] = scenes;
  for (const s2 of rest) { for (const c of s2.listChildren()) main.addChild(c); s2.dispose(); }
  doc.getRoot().setDefaultScene(main);
  const buffers = doc.getRoot().listBuffers();
  for (const acc of doc.getRoot().listAccessors()) acc.setBuffer(buffers[0]);
  for (const b of buffers.slice(1)) b.dispose();
  await doc.transform(dedup(), prune());
  for (const tex of doc.getRoot().listTextures()) {
    const uri = tex.getURI() || tex.getName();
    if (/disp|displacement/i.test(uri)) tex.dispose();
  }
  await doc.transform(prune());
  // texture diet: no ARM maps (constant roughness), smaller normals on small plants
  for (const mat of doc.getRoot().listMaterials()) {
    mat.setOcclusionTexture(null).setMetallicRoughnessTexture(null).setMetallicFactor(0);
    if (!cfg.foliage) mat.setRoughnessFactor(cfg.kind === 'rock' ? 0.85 : 0.9);
  }
  await doc.transform(prune());
  const leafRe = /twig|leaf|leaves|needle|branch|plant|grass|flower|fern|frond|shrub|bush|nettle|weed|card|sapling|searsia/i;
  for (const tex of doc.getRoot().listTextures()) {
    const uri = tex.getURI() || tex.getName();
    if (uri.startsWith('canopy_')) continue;
    const isLeaf = cfg.leafTex && leafRe.test(uri);
    const isNor = /nor_gl|normal|_nor/i.test(uri);
    const size = isNor && cfg.norTex ? cfg.norTex : isLeaf ? cfg.leafTex : cfg.tex;
    const isNormal = /nor_gl|normal/i.test(uri);
    await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: isNormal ? 90 : 82, pattern: new RegExp(path.basename(uri).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }));
  }
  await doc.transform(prune(), resample());
  let bin;
  try {
    const packed = cloneDocument(doc);
    await packed.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    bin = await io.writeBinary(packed);
  } catch (e) {
    console.warn(`${name}: meshopt failed (${e.message}), writing uncompressed`);
    bin = await io.writeBinary(doc);
  }
  await fs.writeFile(outFile, bin);
  console.log(`${name}: ${before}→${lod0Tris}/${lod1Tris} tris, ${lod0Nodes.length} variants, ${cardCount} cards, ${(bin.byteLength / 1024).toFixed(0)} KB`);
}

/** Packs a Poly Haven texture set into two maps per ground layer:
 *  A (sRGB): albedo RGB + height in alpha, at 1024 (high tier) and 512 (low tier);
 *  B (linear, 512): R roughness, G normal.y, B ambient occlusion, A normal.x
 *  (normal components in G and A survive WebP's chroma subsampling). */
async function processTexture(name, credits) {
  const outDir = path.join(OUT, 'ground');
  await fs.mkdir(outDir, { recursive: true });
  const done = path.join(outDir, `${name}_b_512.webp`);
  if (!FORCE) { try { await fs.stat(done); console.log(`skip ${name}`); return; } catch {} }
  const info = await fetchJson(`https://api.polyhaven.com/files/${name}`);
  const meta = await fetchJson(`https://api.polyhaven.com/info/${name}`).catch(() => ({}));
  credits[name] = { type: 'texture', name: meta.name || name, authors: meta.authors || {}, license: 'CC0', url: `https://polyhaven.com/a/${name}` };
  const dir = path.join(TMP, 'tex2', name);
  const get = async (key, res) => { const url = info[key]?.[res]?.jpg?.url ?? info[key]?.['1k']?.jpg?.url; if (!url) return null; const f = path.join(dir, `${key}_${res}.jpg`); await download(url, f); return f; };
  const diff = await get('Diffuse', '2k'), nor = await get('nor_gl', '1k'), arm = await get('arm', '1k'), disp = await get('Displacement', '1k');
  if (!diff || !nor) throw new Error(`${name}: missing maps`);
  const raw = async (f, size, channels) => { const { data } = await sharp(f).resize(size, size, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const out = Buffer.alloc(size * size * channels); const c = data.length / (size * size); for (let i = 0; i < size * size; i++) for (let k = 0; k < channels; k++) out[i * channels + k] = data[i * c + Math.min(k, c - 1)]; return out; };
  for (const size of name === 'floor_pebbles_01' ? [512] : [1024, 512]) {
    const rgb = await raw(diff, size, 3);
    let h = disp ? await raw(disp, size, 1) : Buffer.alloc(size * size, 128);
    // stretch the height to the full 0..255 range (per texture) for height-blending
    let lo = 255, hi = 0; for (const v of h) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = Math.max(1, hi - lo);
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = Math.round(((h[i] - lo) / span) * 255); }
    // 1024: KTX2 (compressed on the GPU, streamed after start-up); 512: WebP for the first frames and the low tier
    if (size > 512) await writeKtx2(rgba, size, path.join(outDir, `${name}_a_${size}.ktx2`));
    else await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 84, alphaQuality: 45, effort: 6 }).toFile(path.join(outDir, `${name}_a_${size}.webp`));
  }
  {
    const size = 512;
    const n = await raw(nor, size, 3); const a = arm ? await raw(arm, size, 3) : null;
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      rgba[i * 4] = a ? a[i * 3 + 1] : 230; rgba[i * 4 + 1] = n[i * 3 + 1]; rgba[i * 4 + 2] = a ? a[i * 3] : 255; rgba[i * 4 + 3] = n[i * 3];
    }
    await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 78, alphaQuality: 70, smartSubsample: true, effort: 6 }).toFile(done);
  }
  console.log(`texture ${name} ok`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': (await import('meshoptimizer')).MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
  const creditsPath = path.join(OUT, 'credits.json');
  let credits = {};
  try { credits = JSON.parse(await fs.readFile(creditsPath, 'utf8')).assets || {}; } catch {}
  const queue = [];
  for (const [name, cfg] of Object.entries(MODELS)) if (!ONLY || ONLY.includes(name)) queue.push(() => processModel(name, cfg, io, credits).catch(e => console.error(`FAILED ${name}:`, e.stack)));
  for (const name of TEXTURES) if (!ONLY || ONLY.includes(name)) queue.push(() => processTexture(name, credits).catch(e => console.error(`FAILED ${name}:`, e.stack)));
  // modest concurrency: downloads overlap, CPU work is serialized-ish
  const workers = Array.from({ length: 3 }, async () => { while (queue.length) await queue.shift()(); });
  await Promise.all(workers);
  await fs.writeFile(creditsPath, JSON.stringify({
    source: 'Poly Haven (https://polyhaven.com)', license: 'CC0 1.0 Universal', assets: credits,
  }, null, 2));
  console.log('credits written');
}
main().catch(e => { console.error(e); process.exit(1); });
