// Cache-busting for the unhashed data files in public/assets (models, textures, audio, json).
// They are served as immutable (vercel.json), so every URL carries its file's content hash: a new deploy
// re-downloads exactly the files that changed, and an iPad never keeps a stale model or manifest.
import * as THREE from 'three';

declare const __ASSET_HASHES__: Record<string, string>;
const HASHES: Record<string, string> = typeof __ASSET_HASHES__ !== 'undefined' ? __ASSET_HASHES__ : {};

export function versioned(url: string): string {
  if (typeof url !== 'string' || !url.startsWith('/assets/') || url.includes('?')) return url;
  const h = HASHES[url];
  return h ? `${url}?v=${h}` : url;
}

let installed = false;
/** Route every three.js loader and every fetch() of /assets/... through the versioned URL. */
export function installAssetVersioning(): void {
  if (installed) return; installed = true;
  THREE.DefaultLoadingManager.setURLModifier(versioned);
  const f = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => f(typeof input === 'string' ? versioned(input) : input, init)) as typeof window.fetch;
}
