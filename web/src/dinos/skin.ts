// Close-up skin detail: a tiling reptile-scale normal map blended (UDN) into each dinosaur's own
// normal map at a real-world scale measured per species (UV density from the Blender pipeline),
// fading out with distance. Keeps 1K source textures looking crisp at the child's viewing distance.
import * as THREE from 'three';

let detail: THREE.Texture | null = null;
const pending: { value: number }[] = [];
const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
flat.needsUpdate = true;

export function loadSkinDetail(url = '/assets/dinos/detail/scales_n.webp'): void {
  new THREE.TextureLoader().load(url, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    detail = t;
    for (const u of pending) u.value = (u as unknown as { target: number }).target;
    pending.length = 0;
  });
}

const SKIP = /eye|cornea|teeth|tooth|tongue|gum|claw|nail|horn/i;

/** Add scale detail to every skin material of a loaded dinosaur. `uvPerM` = UV units per metre. */
export function applySkinDetail(model: THREE.Object3D, lengthM: number, uvPerM: number | undefined): void {
  if (!uvPerM || uvPerM <= 0) return;
  const scale = THREE.MathUtils.clamp(0.0045 * lengthM, 0.015, 0.07);   // size of one scale (m)
  const tileM = scale * 22;                                                // the texture holds 22 scales across
  const repeat = 1 / (tileM * uvPerM);
  const fade = THREE.MathUtils.clamp(lengthM * 2.5, 12, 30);
  const seen = new Set<THREE.Material>();
  model.traverse((o) => {
    const m = o as THREE.Mesh; if (!m.isMesh) return;
    for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
      if (!mat || seen.has(mat) || !mat.isMeshStandardMaterial || SKIP.test(mat.name) || !mat.map) continue;
      seen.add(mat);
      if (!mat.normalMap) { mat.normalMap = flat; mat.normalMapType = THREE.TangentSpaceNormalMap; }
      const boost = Number(new URLSearchParams(location.search).get('skin') ?? '1') || 1;
      const strength = { value: 0, target: 0.55 * boost };
      if (detail) strength.value = strength.target; else pending.push(strength);
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uDetailN = { get value() { return detail ?? flat; } } as unknown as THREE.IUniform;
        sh.uniforms.uDetailRep = { value: repeat };
        sh.uniforms.uDetailStr = strength;
        sh.uniforms.uDetailFade = { value: fade };
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uDetailN; uniform float uDetailRep; uniform float uDetailStr; uniform float uDetailFade;')
          .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps)
          .replace('mapN.xy *= normalScale;', `mapN.xy *= normalScale;
  {
    vec3 dN = texture2D( uDetailN, vNormalMapUv * uDetailRep ).xyz * 2.0 - 1.0;
    float df = uDetailStr * ( 1.0 - smoothstep( uDetailFade * 0.35, uDetailFade, length( vViewPosition ) ) );
    mapN = normalize( vec3( mapN.xy + dN.xy * df, mapN.z ) );
  }`);
      };
      mat.customProgramCacheKey = () => 'dino-skin-detail';
      mat.needsUpdate = true;
    }
  });
}
