// One-shot sound effects.
import type { AudioEngine } from './context.ts';

function route(a: AudioEngine, gain: number, pan: number): GainNode {
  const g = a.ctx.createGain(); g.gain.value = gain;
  const p = a.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(a.sfx);
  return g;
}

export function footstep(a: AudioEngine, big: boolean, gain: number, pan: number): void {
  if (!a.unlocked || gain < 0.02) return;
  const ctx = a.ctx, t = ctx.currentTime; const out = route(a, gain, pan);
  const n = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(big ? 500 : 1200, t); f.frequency.exponentialRampToValueAtTime(120, t + (big ? 0.25 : 0.1));
  const e = ctx.createGain(); e.gain.setValueAtTime(big ? 0.9 : 0.35, t); e.gain.exponentialRampToValueAtTime(0.001, t + (big ? 0.3 : 0.12));
  n.connect(f); f.connect(e); e.connect(out); n.start(t); n.stop(t + 0.35);
  if (big) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.3);
    const oe = ctx.createGain(); oe.gain.setValueAtTime(0.9, t); oe.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(oe); oe.connect(out); o.start(t); o.stop(t + 0.4);
  }
}

export function eatCrunch(a: AudioEngine, gain: number, pan: number): void {
  if (!a.unlocked || gain < 0.02) return;
  const ctx = a.ctx; const out = route(a, gain, pan);
  for (let i = 0; i < 5; i++) {
    const t = ctx.currentTime + i * 0.28 + Math.random() * 0.05;
    const n = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1500 + Math.random() * 1500; f.Q.value = 1.2;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.6, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    n.connect(f); f.connect(e); e.connect(out); n.start(t); n.stop(t + 0.1);
  }
}

export function splash(a: AudioEngine, gain: number, pan: number, big = false): void {
  if (!a.unlocked || gain < 0.02) return;
  const ctx = a.ctx, t = ctx.currentTime; const out = route(a, gain, pan);
  const n = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(big ? 500 : 1200, t); f.frequency.exponentialRampToValueAtTime(3500, t + 0.15); f.frequency.exponentialRampToValueAtTime(800, t + 0.8); f.Q.value = 0.9;
  const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(big ? 1 : 0.6, t + 0.05); e.gain.exponentialRampToValueAtTime(0.001, t + (big ? 1.1 : 0.6));
  n.connect(f); f.connect(e); e.connect(out); n.start(t); n.stop(t + 1.2);
}

export function pop(a: AudioEngine): void {
  if (!a.unlocked) return;
  const ctx = a.ctx, t = ctx.currentTime; const out = route(a, 0.5, 0);
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(500, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.06); o.frequency.exponentialRampToValueAtTime(400, t + 0.14);
  const e = ctx.createGain(); e.gain.setValueAtTime(0.7, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  o.connect(e); e.connect(out); o.start(t); o.stop(t + 0.2);
}

export function sparkle(a: AudioEngine): void {
  if (!a.unlocked) return;
  const ctx = a.ctx; const out = route(a, 0.35, 0);
  const notes = [1046, 1318, 1568, 2093, 2637, 3136];
  for (let i = 0; i < 7; i++) {
    const t = ctx.currentTime + i * 0.07; const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = notes[(i * 2 + Math.floor(Math.random() * 2)) % notes.length];
    const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.5, t + 0.01); e.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(e); e.connect(out); o.start(t); o.stop(t + 0.55);
  }
}

export function thump(a: AudioEngine, gain: number, pan: number): void {
  if (!a.unlocked || gain < 0.02) return;
  const ctx = a.ctx, t = ctx.currentTime; const out = route(a, gain, pan);
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.4);
  const e = ctx.createGain(); e.gain.setValueAtTime(1, t); e.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  o.connect(e); e.connect(out); o.start(t); o.stop(t + 0.55);
  const n = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300;
  const ne = ctx.createGain(); ne.gain.setValueAtTime(0.5, t); ne.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  n.connect(f); f.connect(ne); ne.connect(out); n.start(t); n.stop(t + 0.35);
}

export function sniff(a: AudioEngine, gain: number, pan: number): void {
  if (!a.unlocked || gain < 0.02) return;
  const ctx = a.ctx; const out = route(a, gain, pan);
  for (let i = 0; i < 3; i++) {
    const t = ctx.currentTime + i * 0.3; const n = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(2200, t + 0.12); f.Q.value = 1;
    const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.35, t + 0.05); e.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(f); f.connect(e); e.connect(out); n.start(t); n.stop(t + 0.2);
  }
}

export function wingFlap(a: AudioEngine, gain: number, pan: number): void {
  if (!a.unlocked || gain < 0.02) return;
  const ctx = a.ctx; const out = route(a, gain, pan);
  for (let i = 0; i < 4; i++) {
    const t = ctx.currentTime + i * 0.32; const n = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(1800, t + 0.1); f.frequency.exponentialRampToValueAtTime(300, t + 0.28);
    const e = ctx.createGain(); e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.5, t + 0.08); e.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    n.connect(f); f.connect(e); e.connect(out); n.start(t); n.stop(t + 0.32);
  }
}
