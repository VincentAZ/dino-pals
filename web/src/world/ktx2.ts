// One shared Basis/KTX2 transcoder (worker pool + wasm) for the terrain layers
// and the vegetation models' GPU-compressed textures.
import type * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

let loader: KTX2Loader | null = null;
export function ktx2Loader(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!loader) loader = new KTX2Loader().setTranscoderPath('/basis/').setWorkerLimit(2).detectSupport(renderer);
  return loader;
}
