// Recorded animal calls (public domain / CC0, see assets/audio/voices.json) used for dinosaur voices
// and nature ambience. Decoded after the first touch; synthesized sounds remain the fallback.
import type { AudioEngine } from './context.ts';

interface Clip { file: string; dur: number }

export class SampleBank {
  private buffers = new Map<string, AudioBuffer[]>();
  private last = new Map<string, number>();
  ready = false;
  plays: Record<string, number> = {};
  get loaded(): Record<string, number> { const o: Record<string, number> = {}; for (const [k, v] of this.buffers) o[k] = v.length; return o; }
  async load(a: AudioEngine, base = '/assets/audio/'): Promise<void> {
    try {
      const idx = await fetch(base + 'voices.json').then((r) => r.json()) as { voices: Record<string, Clip[]> };
      const jobs: Promise<void>[] = [];
      for (const [voice, clips] of Object.entries(idx.voices)) {
        const list: AudioBuffer[] = []; this.buffers.set(voice, list);
        for (const c of clips) {
          jobs.push(fetch(base + c.file).then((r) => r.arrayBuffer()).then((ab) => new Promise<AudioBuffer>((res, rej) => a.ctx.decodeAudioData(ab, res, rej))).then((b) => { list.push(b); }).catch(() => {}));
        }
      }
      await Promise.all(jobs);
      this.ready = true;
    } catch { this.ready = false; }
  }
  has(kind: string): boolean { return (this.buffers.get(kind)?.length ?? 0) > 0; }
  /** A random clip of this kind, never the same one twice in a row. */
  pick(kind: string): AudioBuffer | null {
    const list = this.buffers.get(kind); if (!list || !list.length) return null;
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === this.last.get(kind)) i = (i + 1) % list.length;
    this.last.set(kind, i);
    return list[i];
  }
  /** Play a clip through gain + pan into `dest`. Returns its duration in seconds (0 if nothing played). */
  play(a: AudioEngine, kind: string, dest: AudioNode, gain: number, pan: number, rate = 1, delay = 0): number {
    const buf = this.pick(kind); if (!buf || !a.unlocked) return 0;
    this.plays[kind] = (this.plays[kind] ?? 0) + 1;
    const ctx = a.ctx, t = ctx.currentTime + 0.01 + delay;
    const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(g); g.connect(p); p.connect(dest); src.start(t);
    return buf.duration / rate;
  }
}

export const samples = new SampleBank();
