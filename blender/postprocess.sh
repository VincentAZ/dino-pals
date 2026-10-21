#!/bin/bash
# Optimises every exported GLB for the web: dedup/prune, 1K WebP textures, Draco geometry. Output → web/public/assets/dinos/
set -e
cd "$(dirname "$0")/.."
OUT=web/public/assets/dinos; mkdir -p $OUT
for f in blender/out/*.glb; do
  id=$(basename $f .glb)
  npx -y @gltf-transform/cli dedup "$f" /tmp/dp_$id.glb >/dev/null
  npx -y @gltf-transform/cli prune /tmp/dp_$id.glb /tmp/dp_$id.glb >/dev/null
  npx -y @gltf-transform/cli resize --width 1024 --height 1024 /tmp/dp_$id.glb /tmp/dp_$id.glb >/dev/null
  npx -y @gltf-transform/cli draco --method edgebreaker --quantize-position 14 --quantize-normal 10 --quantize-texcoord 12 /tmp/dp_$id.glb $OUT/$id.glb >/dev/null
  printf "%-20s %6.2f MB → %6.2f MB\n" $id $(stat -c %s $f | awk '{print $1/1e6}') $(stat -c %s $OUT/$id.glb | awk '{print $1/1e6}')
  rm -f /tmp/dp_$id.glb
done
