// Tiny software rasterizer (z-buffered triangles with perspective-free
// barycentric interpolation) used to bake vegetation textures in node.
// Screen space: x right, y down, pixel centres at +0.5; larger z = nearer.

export class Raster {
  /** @param {number} w @param {number} h @param {number} channels values stored per pixel */
  constructor(w, h, channels) {
    this.w = w; this.h = h; this.ch = channels;
    this.z = new Float32Array(w * h).fill(-Infinity);
    this.buf = new Float32Array(w * h * channels);
    this.cov = new Uint8Array(w * h);
  }

  /**
   * Rasterize one triangle. `frag(b0, b1, b2, out)` fills `out` (length ch) for a
   * covered pixel and returns false to discard it.
   */
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, frag, out) {
    const w = this.w, h = this.h;
    let x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    let y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    if (x0 > x1 || y0 > y1) return;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) return;
    const inv = 1 / area;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const i = y * w + x;
        if (z <= this.z[i]) continue;
        if (frag(w0, w1, w2, out) === false) continue;
        this.z[i] = z; this.cov[i] = 1;
        const o = i * this.ch;
        for (let k = 0; k < this.ch; k++) this.buf[o + k] = out[k];
      }
    }
  }
}

/** Bilinear RGBA sampler over a raw 8-bit image (wraps). Returns floats 0..1 into `out`. */
export function sampler(data, w, h, channels = 4) {
  return (u, v, out) => {
    let x = u * w - 0.5, y = v * h - 0.5;
    x = ((x % w) + w) % w; y = ((y % h) + h) % h;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const x1 = (x0 + 1) % w, y1 = (y0 + 1) % h;
    for (let k = 0; k < channels; k++) {
      const a = data[(y0 * w + x0) * channels + k], b = data[(y0 * w + x1) * channels + k];
      const c = data[(y1 * w + x0) * channels + k], d = data[(y1 * w + x1) * channels + k];
      out[k] = ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) / 255;
    }
    return out;
  };
}
