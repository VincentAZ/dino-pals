// Canopy card generation: replaces millions of geometric leaf triangles with a
// few hundred textured leaf-cluster cards (crossed quads), plus a composed
// RGBA cluster texture built from the leaf atlas + alpha map.
import sharp from 'sharp';

/** Connected components of the alpha mask → sprite rectangles (in pixels). */
async function findSprites(alphaBuf, maxSprites = 40) {
  const { data, info } = await sharp(alphaBuf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = y * w + x;
    if (seen[i] || data[i] < 100) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    let minx = x, maxx = x, miny = y, maxy = y, n = 0;
    while (sp) {
      const j = stack[--sp]; const jx = j % w, jy = (j / w) | 0; n++;
      if (jx < minx) minx = jx; if (jx > maxx) maxx = jx; if (jy < miny) miny = jy; if (jy > maxy) maxy = jy;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] || data[k] < 100) continue;
        const kx = k % w; if (Math.abs(kx - jx) > 1) continue;
        seen[k] = 1; stack[sp++] = k;
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (n < 400 || bw < 24 || bh < 24) continue;
    // reject bark strips / solid atlas blocks: high fill ratio + elongated or very large
    const fill = (n * 4) / (bw * bh); // sampled every 2nd pixel on both axes
    const aspect = Math.max(bw / bh, bh / bw);
    if (fill > 0.7 && (aspect > 2.5 || (n * 4) > 0.03 * w * h)) continue;
    out.push({ x: minx, y: miny, w: bw, h: bh, n });
  }
  out.sort((a, b) => b.n - a.n);
  return out.slice(0, maxSprites);
}

/** Builds a 512x512 RGBA webp of a leaf cluster from the atlas diffuse + alpha. */
export async function buildCardTexture(diffBuf, alphaBuf, opts, rnd) {
  const size = opts.size ?? 512;
  const meta = await sharp(diffBuf).metadata();
  const alpha = await sharp(alphaBuf).greyscale().resize(meta.width, meta.height).raw().toBuffer();
  const rgb = await sharp(diffBuf).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(meta.width * meta.height * 4);
  for (let i = 0; i < meta.width * meta.height; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
  const leafImg = sharp(rgba, { raw: { width: meta.width, height: meta.height, channels: 4 } }).png();
  const sprites = await findSprites(alphaBuf, opts.maxSprites ?? 24);
  if (!sprites.length) sprites.push({ x: 0, y: 0, w: meta.width, h: meta.height, n: 1 });
  const base = await leafImg.toBuffer();
  const layers = [];
  const copies = opts.copies ?? 28;
  const [smin, smax] = opts.copyScale ?? [0.28, 0.42];
  for (let i = 0; i < copies; i++) {
    const sp = sprites[Math.floor(rnd() * sprites.length)];
    const scale = (smin + rnd() * (smax - smin)) * size / Math.max(sp.w, sp.h);
    const cw = Math.max(8, Math.round(sp.w * scale)), ch = Math.max(8, Math.round(sp.h * scale));
    const ang = Math.round(rnd() * 360);
    const buf = await sharp(base).extract({ left: sp.x, top: sp.y, width: sp.w, height: sp.h }).resize(cw, ch).rotate(ang, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const rm = await sharp(buf).metadata();
    // place within a disc so the card silhouette reads as a clump
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * size * (opts.discRadius ?? 0.34);
    const left = Math.round(size / 2 + Math.cos(a) * r - rm.width / 2), top = Math.round(size / 2 + Math.sin(a) * r - rm.height / 2);
    // sharp requires the layer to be inside the canvas: clip by extracting the visible part
    const l0 = Math.max(0, left), t0 = Math.max(0, top), r0 = Math.min(size, left + rm.width), b0 = Math.min(size, top + rm.height);
    if (r0 - l0 < 4 || b0 - t0 < 4) continue;
    const clipped = await sharp(buf).extract({ left: l0 - left, top: t0 - top, width: r0 - l0, height: b0 - t0 }).png().toBuffer();
    layers.push({ input: clipped, left: l0, top: t0 });
  }
  let img = sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png();
  // premultiplied edge bleed: dilate colour into transparent pixels so mipmaps don't darken
  const raw = await img.raw().toBuffer();
  const px = new Uint8Array(raw);
  for (let pass = 0; pass < 3; pass++) {
    const src = Uint8Array.from(px);
    for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
      const i = (y * size + x) * 4;
      if (src[i + 3] > 8) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const o of [-4, 4, -size * 4, size * 4]) { const j = i + o; if (src[j + 3] > 8) { r += src[j]; g += src[j + 1]; b += src[j + 2]; n++; } }
      if (n) { px[i] = r / n; px[i + 1] = g / n; px[i + 2] = b / n; }
    }
  }
  return sharp(px, { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 88, alphaQuality: 90 }).toBuffer();
}

/** Triangle centroids of a primitive (sampled). */
function centroids(prim, maxN = 200000) {
  const idx = prim.getIndices().getArray(); const pos = prim.getAttribute('POSITION').getArray();
  const n = idx.length / 3; const stride = Math.max(1, Math.floor(n / maxN));
  const out = [];
  for (let t = 0; t < n; t += stride) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    out.push((pos[a] + pos[b] + pos[c]) / 3, (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3);
  }
  return out;
}

/** Replaces the primitive's geometry with crossed leaf-cluster cards. Returns card count. */
export function canopyCards(doc, prim, targetCards, material, rnd, sizeMul = 1) {
  const pts = centroids(prim);
  const N = pts.length / 3;
  if (N < 4) return 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) { const v = pts[i * 3 + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  const ext = [max[0] - min[0] + 1e-6, max[1] - min[1] + 1e-6, max[2] - min[2] + 1e-6];
  const maxExt = Math.max(...ext);
  const center = [(min[0] + max[0]) / 2, min[1] + ext[1] * 0.45, (min[2] + max[2]) / 2];
  // choose a grid resolution giving ~1.3x the target occupied voxels
  let G = 3, cells = new Map();
  for (; G < 64; G++) {
    cells = new Map();
    const cs = maxExt / G;
    for (let i = 0; i < N; i++) {
      const gx = Math.floor((pts[i * 3] - min[0]) / cs), gy = Math.floor((pts[i * 3 + 1] - min[1]) / cs), gz = Math.floor((pts[i * 3 + 2] - min[2]) / cs);
      const key = (gx * 4096 + gy) * 4096 + gz;
      let c = cells.get(key); if (!c) { c = { n: 0, x: 0, y: 0, z: 0 }; cells.set(key, c); }
      c.n++; c.x += pts[i * 3]; c.y += pts[i * 3 + 1]; c.z += pts[i * 3 + 2];
    }
    if (cells.size >= targetCards * 1.3) break;
  }
  const cs = maxExt / G;
  const list = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, targetCards);
  const half = cs * 0.95 * sizeMul;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  let v = 0;
  const radius = Math.hypot(ext[0], ext[2]) * 0.5 + 1e-6;
  for (const c of list) {
    const cx = c.x / c.n, cy = c.y / c.n, cz = c.z / c.n;
    let nx = cx - center[0], ny = (cy - center[1]) * 0.8 + half * 0.5, nz = cz - center[2];
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    // shade: inner/lower cards darker, outer/upper cards lit
    const outward = Math.min(1, Math.hypot(cx - center[0], cz - center[2]) / radius);
    const up = (cy - min[1]) / ext[1];
    const shade = 0.45 + 0.35 * outward + 0.3 * up;
    const yaw = rnd() * Math.PI;
    for (let q = 0; q < 2; q++) {
      const a = yaw + q * Math.PI / 2;
      const rx = Math.cos(a), rz = Math.sin(a);
      const tilt = (rnd() - 0.5) * 0.7;
      const ux = -rz * Math.sin(tilt), uy = Math.cos(tilt), uz = rx * Math.sin(tilt);
      const h = half * (0.85 + rnd() * 0.3);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (const [sx, sy] of corners) {
        pos.push(cx + rx * h * sx + ux * h * sy, cy + uy * h * sy, cz + rz * h * sx + uz * h * sy);
        nor.push(nx, ny, nz);
        uv.push(sx > 0 ? 1 : 0, sy > 0 ? 0 : 1);
        const s2 = Math.min(1.1, shade * (sy > 0 ? 1.08 : 0.88));
        col.push(s2, s2, s2);
      }
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      v += 4;
    }
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const mk = (arr, type, comp) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const posAcc = mk(new Float32Array(pos), 'VEC3'), norAcc = mk(new Float32Array(nor), 'VEC3'), uvAcc = mk(new Float32Array(uv), 'VEC2'), colAcc = mk(new Float32Array(col), 'VEC3');
  const idxAcc = mk(v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 'SCALAR');
  for (const sem of prim.listSemantics()) { const old = prim.getAttribute(sem); prim.setAttribute(sem, null); if (old) old.dispose(); }
  const oldIdx = prim.getIndices(); prim.setIndices(idxAcc); if (oldIdx) oldIdx.dispose();
  prim.setAttribute('POSITION', posAcc).setAttribute('NORMAL', norAcc).setAttribute('TEXCOORD_0', uvAcc).setAttribute('COLOR_0', colAcc);
  prim.setMaterial(material);
  return list.length;
}
