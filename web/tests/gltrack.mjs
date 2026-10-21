// Shared GPU texture-memory tally (wraps WebGL2 upload entry points). Use with context.addInitScript(GL_TRACK).
// Tally GPU texture allocations by wrapping the WebGL2 entry points.
export const GL_TRACK = () => {
  const P = WebGL2RenderingContext.prototype;
  const sizes = new Map(); const bound = new Map(); let unit = 0;
  const bpp = (fmt, type) => {
    // internal formats (sized) or format+type
    const map = { 0x8058: 4, 0x8C43: 4, 0x881A: 8, 0x8814: 16, 0x822E: 4, 0x8229: 1, 0x822B: 2, 0x8230: 8, 0x822F: 2, 0x81A6: 4, 0x8CAC: 4, 0x88F0: 4, 0x8D48: 4, 0x8C3A: 4, 0x8C3D: 4,
      // compressed: BPTC, S3TC, ETC2, ASTC 4x4 (bytes per texel)
      0x8E8C: 1, 0x8E8D: 1, 0x83F3: 1, 0x8C4F: 1, 0x83F1: 0.5, 0x8C4C: 0.5, 0x9278: 1, 0x9279: 1, 0x9274: 0.5, 0x9275: 0.5, 0x93B0: 1, 0x93D0: 1 };
    if (map[fmt]) return map[fmt];
    if (fmt === 0x1908) return type === 0x1406 ? 16 : type === 0x140B ? 8 : 4; // RGBA
    if (fmt === 0x1907) return type === 0x1406 ? 12 : 3; // RGB
    if (fmt === 0x1903) return type === 0x1406 ? 4 : 1; // RED
    return 4;
  };
  const key = (target) => `${unit}:${target === 0x8C1A ? 'arr' : target === 0x806F ? '3d' : target >= 0x8515 && target <= 0x851A ? 'cube' : '2d'}`;
  let desc = '';
  const add = (target, level, bytes) => {
    const tex = bound.get(key(target)); if (!tex) return;
    let s = sizes.get(tex); if (!s) { s = { levels: new Map(), mip: false }; sizes.set(tex, s); }
    const face = target >= 0x8515 && target <= 0x851A ? target : 0;
    s.levels.set(`${face}:${level}`, bytes);
    if (level === 0 || s.levels.size === 1) s.desc = desc;
  };
  const oAct = P.activeTexture; P.activeTexture = function (u) { unit = u - 0x84C0; return oAct.call(this, u); };
  const oBind = P.bindTexture; P.bindTexture = function (t, tex) { bound.set(key(t), tex); return oBind.call(this, t, tex); };
  const oDel = P.deleteTexture; P.deleteTexture = function (tex) { sizes.delete(tex); return oDel.call(this, tex); };
  const oT2 = P.texImage2D; P.texImage2D = function (...a) {
    const [target, level, ifmt] = a;
    let w, h, fmt, type;
    if (a.length >= 8) { w = a[3]; h = a[4]; fmt = a[6]; type = a[7]; } else { const src = a[5]; w = src.width || src.videoWidth || 0; h = src.height || src.videoHeight || 0; fmt = a[3]; type = a[4]; }
    desc = `2d ${w}x${h} f${ifmt.toString(16)}`; add(target, level, w * h * bpp(ifmt, type));
    return oT2.apply(this, a);
  };
  const oT3 = P.texImage3D; P.texImage3D = function (...a) { const [target, level, ifmt, w, h, d] = a; desc = `3d ${w}x${h}x${d} f${ifmt.toString(16)}`; add(target, level, w * h * d * bpp(ifmt, a[8])); return oT3.apply(this, a); };
  const oS2 = P.texStorage2D; P.texStorage2D = function (target, levels, ifmt, w, h) {
    let tot = 0, ww = w, hh = h; for (let l = 0; l < levels; l++) { tot += ww * hh * bpp(ifmt); ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1); }
    const faces = target === 0x8513 ? 6 : 1; desc = `s2 ${w}x${h} L${levels} f${ifmt.toString(16)}`; add(target === 0x8513 ? 0x8513 : target, 0, tot * faces); return oS2.call(this, target, levels, ifmt, w, h);
  };
  const oS3 = P.texStorage3D; P.texStorage3D = function (target, levels, ifmt, w, h, d) {
    let tot = 0, ww = w, hh = h; for (let l = 0; l < levels; l++) { tot += ww * hh * d * bpp(ifmt); ww = Math.max(1, ww >> 1); hh = Math.max(1, hh >> 1); }
    desc = `s3 ${w}x${h}x${d} L${levels} f${ifmt.toString(16)}`; add(target, 0, tot); return oS3.call(this, target, levels, ifmt, w, h, d);
  };
  const oC2 = P.compressedTexImage2D; P.compressedTexImage2D = function (...a) { add(a[0], a[1], a[6]?.byteLength ?? 0); return oC2.apply(this, a); };
  const oGM = P.generateMipmap; P.generateMipmap = function (target) { const tex = bound.get(key(target)); const s = tex && sizes.get(tex); if (s) s.mip = true; return oGM.call(this, target); };
  window.__texList = () => { const h = {}; for (const s of sizes.values()) { let b = 0; for (const v of s.levels.values()) b += v; const k = s.desc + (s.mip ? ' mip' : ''); h[k] = h[k] || [0, 0]; h[k][0]++; h[k][1] += b / 1048576; } return Object.entries(h).sort((a, b) => b[1][1] - a[1][1]).map(([k, v]) => `${k}: n=${v[0]} ${v[1].toFixed(1)}MB`); };
  window.__texMB = () => { let tot = 0; for (const s of sizes.values()) { let b = 0; for (const v of s.levels.values()) b += v; tot += s.mip && s.levels.size === 1 ? b * 4 / 3 : b; } return +(tot / 1048576).toFixed(1); };
};
