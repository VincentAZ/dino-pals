#!/bin/bash
# Runs the whole cast through the pipeline, 4 at a time. Usage: blender/run_all.sh <glb_dir> [--preview]
set -u
G=$1; shift
cd "$(dirname "$0")/.."
declare -A M=( [trex]=a3384b11 [triceratops]=cb7bad2c [stegosaurus]=b2545ed6 [paluxysaurus]=afb6b5c7 [velociraptor]=b227da6c [sauropelta]=da2bc6ed [ankylosaurus]=163daf7c [iguanodon]=2dae61d1 [ornithocheirus]=02d6ca0e [spinosaurus]=4f2332ee [carnotaurus]=548c9a05 [allosaurus]=6c5142e0 [pachycephalosaurus]=74034987 [pistosaurus]=77366757 [mosasaurus]=6c343575 )
for sp in "${!M[@]}"; do echo "$sp $(ls $G/${M[$sp]}*.glb)"; done | xargs -P 4 -L 1 bash -c 'timeout 1200 blender -b --python blender/dino_pipeline.py -- $0 $1 blender/out '"$*"' > blender/out/$0.log 2>&1; echo "$0 exit $?"'
