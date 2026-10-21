// Loop-seam check: for every looping clip (idle, walk, fly, swim), compare each channel's first and last
// keyframe. A big difference means the animation snaps when it wraps around.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const LOOPS = new Set(['idle', 'walk', 'fly', 'swim']);
for (const f of fs.readdirSync('public/assets/dinos').filter((f) => f.endsWith('.glb') && f !== 'food.glb')) {
  const doc = await io.read('public/assets/dinos/' + f);
  const bad = [];
  for (const anim of doc.getRoot().listAnimations()) {
    if (!LOOPS.has(anim.getName())) continue;
    for (const ch of anim.listChannels()) {
      const smp = ch.getSampler(); const out = smp.getOutput(); const n = out.getCount(); if (n < 2) continue;
      const a = out.getElement(0, []), b = out.getElement(n - 1, []);
      let d;
      if (ch.getTargetPath() === 'rotation') { const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]); d = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI; if (d > 1.0) bad.push(`${anim.getName()}:${ch.getTargetNode()?.getName()}.rot ${d.toFixed(1)}deg`); }
      else if (ch.getTargetPath() === 'translation') { d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); if (d > 0.01) bad.push(`${anim.getName()}:${ch.getTargetNode()?.getName()}.pos ${(d * 100).toFixed(1)}cm`); }
    }
  }
  console.log(f.padEnd(26), bad.length ? bad.slice(0, 8).join(' | ') + (bad.length > 8 ? ` (+${bad.length - 8})` : '') : 'ok');
}
