// Procedural placeholder dinosaurs built from primitives, with a tiny
// procedural rig so they walk, roar, eat, fly and swim without any GLB.
import * as THREE from 'three';
import type { Species } from './manifest.ts';
import type { DinoState } from './dino.ts';

interface Look { base: string; spots: string; belly: string; pattern: 'spots' | 'stripes' | 'plain' }
const LOOKS: Record<string, Look> = {
  trex: { base: '#6b7a3c', spots: '#3f4a22', belly: '#c9c08a', pattern: 'stripes' },
  triceratops: { base: '#8a6d4a', spots: '#5a4530', belly: '#d8c7a0', pattern: 'spots' },
  stegosaurus: { base: '#6e8c5a', spots: '#9a4b2e', belly: '#d4d2a0', pattern: 'spots' },
  paluxysaurus: { base: '#8a8a76', spots: '#5f5f4d', belly: '#d9d5c1', pattern: 'plain' },
  velociraptor: { base: '#b36a3c', spots: '#5a2e14', belly: '#f0d9b0', pattern: 'stripes' },
  sauropelta: { base: '#7a6b4a', spots: '#3f3524', belly: '#c9bb95', pattern: 'spots' },
  ankylosaurus: { base: '#5f6b4e', spots: '#303a28', belly: '#bfc39a', pattern: 'spots' },
  iguanodon: { base: '#6f9a5a', spots: '#3e5f33', belly: '#d2dfa8', pattern: 'stripes' },
  ornithocheirus: { base: '#b89a7a', spots: '#7a5a40', belly: '#f2e6d4', pattern: 'plain' },
  spinosaurus: { base: '#4f7a8a', spots: '#c25a3a', belly: '#d9e5e0', pattern: 'stripes' },
  carnotaurus: { base: '#9a3a2e', spots: '#4a1a14', belly: '#e0b89a', pattern: 'spots' },
  allosaurus: { base: '#8a6a3a', spots: '#4a3418', belly: '#e5cfa0', pattern: 'stripes' },
  pachycephalosaurus: { base: '#8a7aa0', spots: '#4e4060', belly: '#dcd3e8', pattern: 'spots' },
  pistosaurus: { base: '#4a6f8a', spots: '#2c4556', belly: '#cfe3ee', pattern: 'spots' },
  mosasaurus: { base: '#3c5a6e', spots: '#20323f', belly: '#c8dbe6', pattern: 'stripes' },
};

const texCache = new Map<string, THREE.CanvasTexture>();
function skinTexture(look: Look): THREE.CanvasTexture {
  const key = `${look.base}${look.spots}${look.pattern}`;
  const hit = texCache.get(key); if (hit) return hit;
  const n = 256; const c = document.createElement('canvas'); c.width = n; c.height = n;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = look.base; ctx.fillRect(0, 0, n, n);
  // mottling
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.08})`;
    const r = 2 + Math.random() * 8; ctx.beginPath(); ctx.arc(Math.random() * n, Math.random() * n, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = look.spots;
  if (look.pattern === 'spots') {
    for (let i = 0; i < 70; i++) { const r = 5 + Math.random() * 14; ctx.beginPath(); ctx.ellipse(Math.random() * n, Math.random() * n, r, r * (0.6 + Math.random() * 0.4), Math.random() * 3, 0, Math.PI * 2); ctx.fill(); }
  } else if (look.pattern === 'stripes') {
    ctx.lineWidth = 7; ctx.strokeStyle = look.spots; ctx.lineCap = 'round';
    for (let i = 0; i < 14; i++) { const x = (i / 14) * n + Math.random() * 8; ctx.beginPath(); ctx.moveTo(x, 10 + Math.random() * 30); ctx.quadraticCurveTo(x + 12, n * 0.4, x - 6, n * 0.75 + Math.random() * 20); ctx.stroke(); }
  }
  // scale texture
  ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
  for (let y = 0; y < n; y += 8) for (let x = 0; x < n; x += 8) { ctx.beginPath(); ctx.arc(x + ((y / 8) % 2) * 4, y, 4, Math.PI, 0); ctx.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

export interface PlaceholderRig {
  root: THREE.Group;
  update: (dt: number, state: DinoState, speedRatio: number, time: number) => void;
}

function mat(look: Look): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: skinTexture(look), roughness: 0.82, metalness: 0, color: 0xffffff });
}

/** Builds a friendly chunky dinosaur. Origin at the ground between the feet, facing +Z. */
export function buildPlaceholder(sp: Species): PlaceholderRig {
  const look = LOOKS[sp.id] ?? { base: '#7a8a5a', spots: '#3a4a2a', belly: '#d0d0a0', pattern: 'spots' as const };
  const m = mat(look);
  const belly = new THREE.MeshStandardMaterial({ color: look.belly, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const root = new THREE.Group();
  const L = sp.lengthM, H = sp.heightM;
  const kind = sp.kind;
  const isBiped = kind === 'land' && (sp.voice === 'bigTheropod' || sp.voice === 'raptor' || sp.voice === 'chirp' || sp.id === 'iguanodon');
  const isSauropod = sp.voice === 'sauropod';
  const bodyLen = kind === 'air' ? L * 0.5 : kind === 'water' ? L * 0.55 : isSauropod ? L * 0.35 : L * 0.42;
  const bodyR = kind === 'air' ? H * 0.28 : Math.min(H * 0.33, bodyLen * 0.3);
  const hipY = kind === 'air' ? H * 0.9 : kind === 'water' ? 0 : H * 0.55;

  const body = new THREE.Group(); body.position.y = hipY; root.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(bodyR, bodyLen - 2 * bodyR, 6, 14), m);
  torso.rotation.x = Math.PI / 2; torso.castShadow = true; body.add(torso);
  const tummy = new THREE.Mesh(new THREE.CapsuleGeometry(bodyR * 0.75, bodyLen * 0.5, 4, 12), belly);
  tummy.rotation.x = Math.PI / 2; tummy.position.y = -bodyR * 0.35; tummy.scale.set(1, 0.6, 1); body.add(tummy);

  // neck + head
  const neckLen = isSauropod ? L * 0.35 : kind === 'water' && sp.id === 'pistosaurus' ? L * 0.3 : bodyR * 1.3;
  const neck = new THREE.Group(); neck.position.set(0, bodyR * 0.4, bodyLen / 2 - bodyR * 0.3); body.add(neck);
  const neckMesh = new THREE.Mesh(new THREE.CapsuleGeometry(bodyR * (isSauropod ? 0.35 : 0.55), neckLen, 4, 10), m);
  neckMesh.position.set(0, neckLen * (isSauropod ? 0.45 : 0.25), neckLen * (isSauropod ? 0.3 : 0.45));
  neckMesh.rotation.x = isSauropod ? -Math.PI / 5 : -Math.PI / 3.2; neckMesh.castShadow = true; neck.add(neckMesh);
  const headSize = isSauropod ? bodyR * 0.5 : sp.voice === 'bigTheropod' ? bodyR * 0.95 : bodyR * 0.75;
  const head = new THREE.Group();
  head.position.set(0, neckLen * (isSauropod ? 0.95 : 0.55), neckLen * (isSauropod ? 0.55 : 0.85)); neck.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(headSize, 14, 10), m); skull.scale.set(0.9, 0.85, 1.25); skull.castShadow = true; head.add(skull);
  const snout = new THREE.Mesh(new THREE.CapsuleGeometry(headSize * 0.55, headSize * 0.9, 4, 10), m);
  snout.rotation.x = Math.PI / 2; snout.position.set(0, -headSize * 0.15, headSize * 1.1); head.add(snout);
  const jaw = new THREE.Group(); jaw.position.set(0, -headSize * 0.35, headSize * 0.3); head.add(jaw);
  const jawMesh = new THREE.Mesh(new THREE.CapsuleGeometry(headSize * 0.42, headSize * 0.9, 3, 8), belly);
  jawMesh.rotation.x = Math.PI / 2; jawMesh.position.set(0, -headSize * 0.1, headSize * 0.7); jaw.add(jawMesh);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(headSize * 0.22, 10, 8), white);
    eye.position.set(s * headSize * 0.55, headSize * 0.25, headSize * 0.55); head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(headSize * 0.11, 8, 6), dark);
    pupil.position.set(s * headSize * 0.62, headSize * 0.27, headSize * 0.72); head.add(pupil);
  }
  // tail
  const tailSegs: THREE.Group[] = [];
  let parent: THREE.Object3D = body; let tr = bodyR * 0.8; const tailLen = (kind === 'air' ? L * 0.25 : L * 0.4) / 3;
  let tz = -bodyLen / 2 + bodyR * 0.4;
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group(); g.position.set(0, 0, tz); parent.add(g);
    const seg = new THREE.Mesh(new THREE.CapsuleGeometry(tr, tailLen, 4, 10), m);
    seg.rotation.x = Math.PI / 2; seg.position.z = -tailLen / 2; seg.castShadow = true; g.add(seg);
    tailSegs.push(g); parent = g; tz = -tailLen; tr *= 0.65;
  }
  if (sp.id === 'ankylosaurus') { const club = new THREE.Mesh(new THREE.SphereGeometry(bodyR * 0.5, 10, 8), dark); club.position.z = -tailLen; parent.add(club); }
  // legs
  const legs: { g: THREE.Group; phase: number; front: boolean }[] = [];
  if (kind === 'land') {
    const legLen = hipY - bodyR * 0.2;
    const legR = isBiped ? bodyR * 0.33 : bodyR * 0.3;
    const legPos: [number, number, number, boolean][] = isBiped
      ? [[-bodyR * 0.7, 0, -bodyLen * 0.1, false], [bodyR * 0.7, 0, -bodyLen * 0.1, false]]
      : [[-bodyR * 0.75, 0, bodyLen * 0.3, true], [bodyR * 0.75, 0, bodyLen * 0.3, true], [-bodyR * 0.75, 0, -bodyLen * 0.3, false], [bodyR * 0.75, 0, -bodyLen * 0.3, false]];
    legPos.forEach(([x, , z, front], i) => {
      const g = new THREE.Group(); g.position.set(x, -bodyR * 0.2, z); body.add(g);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(legR, legLen, 4, 10), m);
      leg.position.y = -legLen / 2; leg.castShadow = true; g.add(leg);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(legR * 1.3, 10, 8), m);
      foot.position.set(0, -legLen - legR * 0.2, legR * 0.5); foot.scale.set(1, 0.5, 1.4); g.add(foot);
      legs.push({ g, phase: (i % 2 === 0 ? 0 : Math.PI) + (front ? 0 : Math.PI * 0.9), front });
    });
    if (isBiped) for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(bodyR * 0.14, bodyR * 0.6, 3, 8), m);
      arm.position.set(s * bodyR * 0.8, bodyR * 0.1, bodyLen * 0.3); arm.rotation.x = -0.9; body.add(arm);
    }
  }
  // species extras
  if (sp.id === 'stegosaurus') for (let i = 0; i < 8; i++) {
    const p = new THREE.Mesh(new THREE.ConeGeometry(bodyR * 0.45, bodyR * 1.2, 4), new THREE.MeshStandardMaterial({ color: '#b05a3a', roughness: 0.8 }));
    p.position.set(((i % 2) - 0.5) * bodyR * 0.4, bodyR * 0.9, bodyLen * 0.45 - i * (bodyLen * 0.13)); p.scale.z = 0.25; p.castShadow = true; body.add(p);
  }
  if (sp.id === 'triceratops') {
    const frill = new THREE.Mesh(new THREE.CylinderGeometry(headSize * 1.6, headSize * 1.6, headSize * 0.2, 16, 1, false, 0, Math.PI), m);
    frill.rotation.set(Math.PI / 2, 0, 0); frill.position.set(0, headSize * 0.6, -headSize * 0.5); head.add(frill);
    for (const s of [-1, 1]) { const horn = new THREE.Mesh(new THREE.ConeGeometry(headSize * 0.16, headSize * 1.3, 8), white); horn.position.set(s * headSize * 0.5, headSize * 0.7, headSize * 0.5); horn.rotation.x = Math.PI / 2.4; head.add(horn); }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(headSize * 0.14, headSize * 0.6, 8), white); nose.position.set(0, headSize * 0.3, headSize * 1.5); nose.rotation.x = Math.PI / 2.6; head.add(nose);
  }
  if (sp.id === 'spinosaurus') {
    const sail = new THREE.Mesh(new THREE.SphereGeometry(bodyLen * 0.45, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#c25a3a', roughness: 0.85, side: THREE.DoubleSide }));
    sail.scale.set(0.08, 1.9, 1); sail.position.y = bodyR * 0.5; sail.castShadow = true; body.add(sail);
  }
  if (sp.id === 'pachycephalosaurus') { const dome = new THREE.Mesh(new THREE.SphereGeometry(headSize * 0.7, 12, 10), new THREE.MeshStandardMaterial({ color: '#6a5a7a', roughness: 0.6 })); dome.position.set(0, headSize * 0.55, -headSize * 0.1); head.add(dome); }
  if (sp.id === 'carnotaurus') for (const s of [-1, 1]) { const h = new THREE.Mesh(new THREE.ConeGeometry(headSize * 0.18, headSize * 0.5, 6), dark); h.position.set(s * headSize * 0.5, headSize * 0.8, headSize * 0.2); head.add(h); }
  if (sp.id === 'sauropelta' || sp.id === 'ankylosaurus') for (let i = 0; i < 12; i++) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(bodyR * 0.14, bodyR * 0.45, 6), dark);
    const side = i % 2 ? 1 : -1; spike.position.set(side * bodyR * 0.8, bodyR * 0.4, bodyLen * 0.4 - Math.floor(i / 2) * bodyLen * 0.16); spike.rotation.z = side * -1.1; body.add(spike);
  }
  // wings / flippers
  const wings: THREE.Group[] = [];
  if (kind === 'air') {
    for (const s of [-1, 1]) {
      const g = new THREE.Group(); g.position.set(s * bodyR * 0.6, bodyR * 0.3, bodyLen * 0.1); body.add(g);
      const span = L * 1.3;
      const wing = new THREE.Mesh(new THREE.BoxGeometry(span, bodyR * 0.12, bodyLen * 0.9), new THREE.MeshStandardMaterial({ color: look.spots, roughness: 0.8, side: THREE.DoubleSide }));
      wing.position.set(s * span / 2, 0, -bodyLen * 0.15); wing.castShadow = true; g.add(wing);
      wings.push(g);
    }
    const crest = new THREE.Mesh(new THREE.ConeGeometry(headSize * 0.35, headSize * 1.2, 6), dark); crest.position.set(0, headSize * 0.5, -headSize * 0.4); crest.rotation.x = -0.6; head.add(crest);
    snout.scale.set(0.6, 0.6, 1.8);
  }
  if (kind === 'water') {
    for (const [sx, sz] of [[-1, 0.25], [1, 0.25], [-1, -0.25], [1, -0.25]]) {
      const g = new THREE.Group(); g.position.set(sx * bodyR * 0.8, -bodyR * 0.2, bodyLen * sz); body.add(g);
      const fl = new THREE.Mesh(new THREE.BoxGeometry(bodyR * 1.6, bodyR * 0.15, bodyR * 0.7), m);
      fl.position.x = sx * bodyR * 0.8; g.add(fl); wings.push(g);
    }
    const fin = new THREE.Mesh(new THREE.BoxGeometry(bodyR * 0.1, bodyR * 0.8, bodyR * 0.8), m); fin.position.set(0, bodyR * 0.8, -bodyLen * 0.3); body.add(fin);
  }

  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = false; } });

  const baseHeadY = head.position.y, baseHeadZ = head.position.z;
  const update = (dt: number, state: DinoState, speedRatio: number, time: number) => {
    void dt;
    const t = time;
    const moving = state === 'walk' || state === 'swim' || state === 'fly' || state === 'stomp';
    const stride = state === 'stomp' ? 6 : 2.2 * Math.sqrt(Math.max(0.5, speedRatio)) * (sp.lengthM < 3 ? 2.2 : sp.lengthM > 12 ? 0.7 : 1.2);
    const amp = moving ? (state === 'stomp' ? 0.9 : 0.55) : 0;
    for (const lg of legs) lg.g.rotation.x = Math.sin(t * stride + lg.phase) * amp;
    body.position.y = hipY + (moving ? Math.abs(Math.sin(t * stride)) * bodyR * (state === 'stomp' ? 0.3 : 0.08) : Math.sin(t * 1.5) * bodyR * 0.02);
    body.rotation.z = moving ? Math.sin(t * stride) * 0.04 : 0;
    for (let i = 0; i < tailSegs.length; i++) tailSegs[i].rotation.y = Math.sin(t * (moving ? stride * 0.5 : 1.2) - i * 0.6) * (0.12 + i * 0.06);
    // head / neck
    let targetNeck = 0, targetJaw = 0, headY = baseHeadY, headZ = baseHeadZ;
    if (state === 'roar') { targetNeck = -0.55; targetJaw = 0.55 + Math.sin(t * 20) * 0.1; }
    else if (state === 'eat') { targetNeck = isSauropod ? 0.9 : 0.75; targetJaw = Math.abs(Math.sin(t * 8)) * 0.3; headY = baseHeadY - neckLen * (isSauropod ? 0.8 : 0.2); }
    else if (state === 'sniff') { targetNeck = 0.5; headY = baseHeadY - neckLen * 0.2; neck.rotation.y = Math.sin(t * 3) * 0.3; }
    else { neck.rotation.y = Math.sin(t * 0.7) * 0.15; targetNeck = Math.sin(t * 1.1) * 0.05; }
    neck.rotation.x += (targetNeck - neck.rotation.x) * 0.12;
    jaw.rotation.x += (targetJaw - jaw.rotation.x) * 0.25;
    head.position.y += (headY - head.position.y) * 0.1; head.position.z += (headZ - head.position.z) * 0.1;
    if (kind === 'air') {
      const flap = state === 'fly' || state === 'flap' ? Math.sin(t * (state === 'flap' ? 9 : 5)) * 0.6 : Math.sin(t * 1.2) * 0.08;
      wings[0].rotation.z = -flap; wings[1].rotation.z = flap;
    }
    if (kind === 'water') {
      for (let i = 0; i < wings.length; i++) wings[i].rotation.z = Math.sin(t * 3 + i * 1.5) * 0.45 * (i % 2 ? -1 : 1);
      body.rotation.y = Math.sin(t * 2) * 0.03;
    }
  };
  return { root, update };
}
