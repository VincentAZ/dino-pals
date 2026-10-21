// Gentle pentatonic pad: random slow notes through a soft filter + feedback delay.
import type { AudioEngine } from './context.ts';

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

export class Music {
  private a: AudioEngine;
  private next = 0;
  private started = false;
  private out!: GainNode;
  private last = -1;
  constructor(a: AudioEngine) { this.a = a; }
  start(): void {
    if (this.started) return; this.started = true;
    const ctx = this.a.ctx;
    this.out = ctx.createGain(); this.out.gain.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500; lp.Q.value = 0.3;
    const delay = ctx.createDelay(2); delay.delayTime.value = 0.62; const fb = ctx.createGain(); fb.gain.value = 0.42; const wet = ctx.createGain(); wet.gain.value = 0.45;
    this.out.connect(lp); lp.connect(this.a.music); lp.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(this.a.music);
    this.next = ctx.currentTime + 1;
  }
  update(night: number): void {
    if (!this.started) return;
    const ctx = this.a.ctx;
    if (ctx.currentTime < this.next) return;
    this.next = ctx.currentTime + 1.8 + Math.random() * 3.2;
    let idx = Math.floor(Math.random() * SCALE.length);
    if (idx === this.last) idx = (idx + 2) % SCALE.length;
    this.last = idx;
    const f = SCALE[idx] * (night > 0.5 ? 0.5 : 1);
    const t = ctx.currentTime;
    for (const [type, det, g] of [['sine', 0, 0.5], ['triangle', 3, 0.22], ['sine', -5, 0.2]] as [OscillatorType, number, number][]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det;
      const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(g, t + 1.2); e.gain.linearRampToValueAtTime(g * 0.6, t + 2.5); e.gain.linearRampToValueAtTime(0, t + 4.5);
      o.connect(e); e.connect(this.out); o.start(t); o.stop(t + 4.6);
    }
  }
}
