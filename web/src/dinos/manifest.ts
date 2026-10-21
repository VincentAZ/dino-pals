// Dinosaur manifest types + loader (tolerates a missing/invalid manifest).
import type { BiomeId } from '../world/biomes.ts';

export type DinoKind = 'land' | 'air' | 'water';
export type Diet = 'carnivore' | 'herbivore' | 'piscivore';
export type Voice = 'bigTheropod' | 'sauropod' | 'ceratopsian' | 'raptor' | 'pterosaur' | 'marine' | 'chirp';
export type ClipName = 'idle' | 'walk' | 'roar' | 'eat' | 'fly' | 'swim';

export interface Species {
  id: string; name: string; sayName: string; kind: DinoKind; diet: Diet;
  lengthM: number; heightM: number; speed: number; voice: Voice;
  biomes: BiomeId[]; count: number; file: string;
  clips: Partial<Record<ClipName, string>>;
  attribution: { title: string; author: string; license: string; url: string };
}
export interface Manifest { species: Species[] }

export const PLACEHOLDER_IDS = ['trex', 'triceratops', 'stegosaurus', 'paluxysaurus', 'velociraptor', 'sauropelta', 'ankylosaurus', 'iguanodon', 'ornithocheirus', 'spinosaurus', 'carnotaurus', 'allosaurus', 'pachycephalosaurus', 'pistosaurus', 'mosasaurus'];

function sanitize(raw: unknown): Species[] {
  const out: Species[] = [];
  const list = (raw as { species?: unknown[] })?.species;
  if (!Array.isArray(list)) return out;
  for (const s of list as Partial<Species>[]) {
    if (!s || typeof s.id !== 'string') continue;
    out.push({
      id: s.id, name: s.name ?? s.id, sayName: s.sayName ?? s.name ?? s.id,
      kind: (['land', 'air', 'water'] as DinoKind[]).includes(s.kind as DinoKind) ? (s.kind as DinoKind) : 'land',
      diet: (['carnivore', 'herbivore', 'piscivore'] as Diet[]).includes(s.diet as Diet) ? (s.diet as Diet) : 'herbivore',
      lengthM: Number(s.lengthM) || 5, heightM: Number(s.heightM) || 2, speed: Number(s.speed) || 1.2,
      voice: (s.voice as Voice) ?? 'ceratopsian',
      biomes: Array.isArray(s.biomes) && s.biomes.length ? (s.biomes as BiomeId[]) : ['meadow'],
      count: Math.max(1, Math.min(6, Number(s.count) || 2)), file: s.file ?? `${s.id}.glb`,
      clips: s.clips ?? {}, attribution: s.attribution ?? { title: s.name ?? s.id, author: '', license: '', url: '' },
    });
  }
  return out;
}

export async function loadManifest(url = '/assets/dinos/manifest.json'): Promise<Species[]> {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    const list = sanitize(await res.json());
    if (list.length) return list;
  } catch (e) {
    console.warn('manifest load failed, using built-in defaults', e);
  }
  return PLACEHOLDER_IDS.map((id) => ({
    id, name: id, sayName: id, kind: id === 'ornithocheirus' ? 'air' : id === 'pistosaurus' || id === 'mosasaurus' ? 'water' : 'land',
    diet: 'herbivore', lengthM: 6, heightM: 2.5, speed: 1.2, voice: 'ceratopsian', biomes: ['meadow'], count: 2, file: `${id}.glb`, clips: {},
    attribution: { title: id, author: '', license: '', url: '' },
  }));
}
