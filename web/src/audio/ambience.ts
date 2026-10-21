// Per-biome ambient beds crossfaded by player position + time of day.
import type { AudioEngine } from './context.ts';
import { BIOME_IDS } from '../world/biomes.ts';

interface Bed { gain: GainNode; tick?: (dt: number, level: number, night: number) => void }

export class Ambience {
  private a: AudioEngine;
  private beds: Partial<Record<string, Bed>> = {};
  private started = false;
  private timers: Record<string, number> = {};
  constructor(a: AudioEngine) { this.a = a; }

  start(): void {
    if (this.started) return; this.started = true;
    const ctx = this.a.ctx;
    const bed = (name: string, build: (out: GainNode) => Bed['tick']) => {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(this.a.ambience);
      const tick = build(g);
      this.beds[name] = { gain: g, tick };
    };
    // wind: lowpassed noise with slow LFO
    const wind = (out: GainNode, base: number, q: number, lfo: number) => {
      const n = this.a.noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = base; f.Q.value = q;
      const l = ctx.createOscillator(); l.frequency.value = lfo; const lg = ctx.createGain(); lg.gain.value = base * 0.6; l.connect(lg); lg.connect(f.frequency);
      const g = ctx.createGain(); g.gain.value = 0.25; n.connect(f); f.connect(g); g.connect(out); n.start(); l.start();
    };
    bed('meadow', (out) => { wind(out, 420, 0.8, 0.11); return (dt, level, night) => this.birds(dt, level * (1 - night * 0.9), out, 'meadow'); });
    bed('jungle', (out) => {
      // insects: high buzz + drips
      const n = this.a.noise(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 5200; f.Q.value = 8;
      const l = ctx.createOscillator(); l.frequency.value = 7; const lg = ctx.createGain(); lg.gain.value = 0.5; const am = ctx.createGain(); am.gain.value = 0.5; l.connect(lg); lg.connect(am.gain);
      const g = ctx.createGain(); g.gain.value = 0.08; n.connect(f); f.connect(am); am.connect(g); g.connect(out); n.start(); l.start();
      wind(out, 300, 0.6, 0.07);
      return (dt, level) => { this.drips(dt, level, out); this.birds(dt, level * 0.6, out, 'jungle'); };
    });
    bed('volcano', (out) => {
      const n = this.a.noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 70; f.Q.value = 1.5;
      const l = ctx.createOscillator(); l.frequency.value = 0.17; const lg = ctx.createGain(); lg.gain.value = 30; l.connect(lg); lg.connect(f.frequency);
      const g = ctx.createGain(); g.gain.value = 1.4; n.connect(f); f.connect(g); g.connect(out); n.start(); l.start();
      return (dt, level) => this.crackle(dt, level, out);
    });
    bed('beach', (out) => {
      const n = this.a.noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.5;
      const l = ctx.createOscillator(); l.frequency.value = 0.09; const lg = ctx.createGain(); lg.gain.value = 600; l.connect(lg); lg.connect(f.frequency);
      const am = ctx.createGain(); am.gain.value = 0.35; const l2 = ctx.createOscillator(); l2.frequency.value = 0.09; const l2g = ctx.createGain(); l2g.gain.value = 0.2; l2.connect(l2g); l2g.connect(am.gain);
      n.connect(f); f.connect(am); am.connect(out); n.start(); l.start(); l2.start();
      return (dt, level, night) => this.birds(dt, level * 0.4 * (1 - night), out, 'gull');
    });
    bed('swamp', (out) => { wind(out, 250, 0.5, 0.05); return (dt, level, night) => { this.frogs(dt, level * (0.4 + 0.6 * night), out); this.crickets(dt, level * night, out); }; });
    bed('snow', (out) => { wind(out, 650, 1.2, 0.15); const g = ctx.createGain(); g.gain.value = 1.4; return undefined; });
    bed('canyon', (out) => { wind(out, 520, 2.5, 0.2); return undefined; });
    bed('lake', (out) => { wind(out, 380, 0.7, 0.1); return (dt, level, night) => { this.birds(dt, level * 0.5 * (1 - night), out, 'meadow'); this.crickets(dt, level * night * 0.5, out); }; });
  }

  private every(key: string, dt: number, meanInterval: number, fn: () => void): void {
    this.timers[key] = (this.timers[key] ?? Math.random() * meanInterval) - dt;
    if (this.timers[key] <= 0) { this.timers[key] = meanInterval * (0.4 + Math.random() * 1.2); fn(); }
  }
  private birds(dt: number, level: number, out: GainNode, kind: string): void {
    if (level < 0.05) return;
    this.every(`bird-${kind}`, dt, kind === 'gull' ? 5 : 2.4, () => {
      const ctx = this.a.ctx; const base = ctx.currentTime;
      const n = kind === 'gull' ? 2 : 3 + Math.floor(Math.random() * 4);
      const f0 = kind === 'gull' ? 900 : 2200 + Math.random() * 1800;
      const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8; pan.connect(out);
      for (let i = 0; i < n; i++) {
        const t = base + i * (kind === 'gull' ? 0.35 : 0.1 + Math.random() * 0.08);
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * (kind === 'gull' ? 0.7 : 1.5), t + (kind === 'gull' ? 0.25 : 0.05)); o.frequency.exponentialRampToValueAtTime(f0 * 0.9, t + (kind === 'gull' ? 0.4 : 0.1));
        const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.12 * level, t + 0.02); e.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'gull' ? 0.45 : 0.11));
        o.connect(e); e.connect(pan); o.start(t); o.stop(t + 0.5);
      }
    });
  }
  private drips(dt: number, level: number, out: GainNode): void {
    if (level < 0.05) return;
    this.every('drip', dt, 1.6, () => {
      const ctx = this.a.ctx, t = ctx.currentTime; const o = ctx.createOscillator(); o.type = 'sine'; const f = 1200 + Math.random() * 1500;
      o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.04);
      const e = ctx.createGain(); e.gain.setValueAtTime(0.15 * level, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.4 - 0.7; o.connect(e); e.connect(pan); pan.connect(out); o.start(t); o.stop(t + 0.3);
    });
  }
  private crackle(dt: number, level: number, out: GainNode): void {
    if (level < 0.05) return;
    this.every('crackle', dt, 0.35, () => {
      const ctx = this.a.ctx, t = ctx.currentTime; const n = this.a.noise(); const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
      const e = ctx.createGain(); e.gain.setValueAtTime(0.25 * level, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.03 + Math.random() * 0.04);
      n.connect(f); f.connect(e); e.connect(out); n.start(t); n.stop(t + 0.1);
    });
  }
  private frogs(dt: number, level: number, out: GainNode): void {
    if (level < 0.05) return;
    this.every('frog', dt, 1.8, () => {
      const ctx = this.a.ctx; const base = ctx.currentTime; const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 1.6 - 0.8; pan.connect(out);
      const f0 = 160 + Math.random() * 140;
      for (let i = 0; i < 2; i++) {
        const t = base + i * 0.25; const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * 0.7, t + 0.18);
        const am = ctx.createOscillator(); am.frequency.value = 28; const ag = ctx.createGain(); ag.gain.value = 0.5; const amg = ctx.createGain(); amg.gain.value = 0.5; am.connect(ag); ag.connect(amg.gain);
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 5;
        const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.18 * level, t + 0.03); e.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o.connect(f); f.connect(amg); amg.connect(e); e.connect(pan); o.start(t); am.start(t); o.stop(t + 0.22); am.stop(t + 0.22);
      }
    });
  }
  private crickets(dt: number, level: number, out: GainNode): void {
    if (level < 0.05) return;
    this.every('cricket', dt, 0.6, () => {
      const ctx = this.a.ctx; const base = ctx.currentTime; const f0 = 4000 + Math.random() * 800;
      for (let i = 0; i < 5; i++) {
        const t = base + i * 0.055; const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f0;
        const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.05 * level, t + 0.01); e.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
        o.connect(e); e.connect(out); o.start(t); o.stop(t + 0.05);
      }
    });
  }

  update(dt: number, biomeW: Float32Array, night: number, rain: number): void {
    if (!this.started) return;
    const t = this.a.now;
    for (let i = 0; i < BIOME_IDS.length; i++) {
      const b = this.beds[BIOME_IDS[i]]; if (!b) continue;
      let level = Math.min(1, biomeW[i] * 1.4);
      if (BIOME_IDS[i] === 'jungle') level = Math.max(level, 0) * (1 + rain * 0.5);
      b.gain.gain.setTargetAtTime(level, t, 0.8);
      b.tick?.(dt, level, night);
    }
  }
}
