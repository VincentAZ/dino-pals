import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  for (const a of doc.getRoot().listAnimations()) {
    if (a.getName() !== 'eat') continue;
    for (const ch of a.listChannels()) {
      if (ch.getTargetNode().getName() !== 'neck1' || ch.getTargetPath() !== 'rotation') continue;
      const s = ch.getSampler(); const t = s.getInput().getArray(); const v = s.getOutput().getArray();
      console.log(f.split('/').pop(), s.getInterpolation(), 'keys', t.length, 'times', Array.from(t).filter((_, i) => i % 6 === 0).map((x) => x.toFixed(2)).join(','));
      console.log('   x', Array.from(v).filter((_, i) => i % 4 === 0).filter((_, i) => i % 6 === 0).map((x) => x.toFixed(3)).join(','));
    }
  }
}
