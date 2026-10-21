// Synthesized dinosaur calls per voice class. All friendly "hellos".
import type { AudioEngine } from './context.ts';
import type { Voice } from '../dinos/manifest.ts';

function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 2048, c = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x)); }
  return c;
}

export function playVoice(a: AudioEngine, voice: Voice, gain: number, pan: number, sizeM = 6): void {
  if (!a.unlocked || gain <= 0.01) return;
  const ctx = a.ctx, t0 = ctx.currentTime + 0.02;
  const out = ctx.createGain(); out.gain.value = gain;
  const panner = ctx.createStereoPanner(); panner.pan.value = pan;
  out.connect(panner); panner.connect(a.voices);
  const sizeK = Math.max(0.5, Math.min(2.2, sizeM / 8)); // bigger = lower
  switch (voice) {
    case 'bigTheropod': {
      // low noise + pitch-swept oscillator + distortion + formant filters
      const dur = 1.9;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(55 / sizeK, t0); osc.frequency.exponentialRampToValueAtTime(110 / sizeK, t0 + 0.5); osc.frequency.exponentialRampToValueAtTime(42 / sizeK, t0 + dur);
      const osc2 = ctx.createOscillator(); osc2.type = 'square'; osc2.frequency.setValueAtTime(82 / sizeK, t0); osc2.frequency.exponentialRampToValueAtTime(60 / sizeK, t0 + dur);
      const vib = ctx.createOscillator(); vib.frequency.value = 9; const vg = ctx.createGain(); vg.gain.value = 6; vib.connect(vg); vg.connect(osc.frequency);
      const noise = a.noise(); const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 400 / sizeK; nf.Q.value = 0.7;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0, t0); ng.gain.linearRampToValueAtTime(0.5, t0 + 0.15); ng.gain.linearRampToValueAtTime(0, t0 + dur);
      const dist = ctx.createWaveShaper(); dist.curve = distortionCurve(60); dist.oversample = '2x';
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 300 / sizeK; f1.Q.value = 2;
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 900 / sizeK; f2.Q.value = 2.5;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1400, t0); lp.frequency.exponentialRampToValueAtTime(500, t0 + dur);
      const env = ctx.createGain(); env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(0.9, t0 + 0.12); env.gain.setValueAtTime(0.9, t0 + dur * 0.55); env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      const mix = ctx.createGain(); mix.gain.value = 0.5;
      osc.connect(mix); osc2.connect(mix); noise.connect(nf); nf.connect(ng); ng.connect(mix);
      mix.connect(dist); dist.connect(f1); dist.connect(f2); f1.connect(lp); f2.connect(lp); dist.connect(lp); lp.connect(env); env.connect(out);
      osc.start(t0); osc2.start(t0); vib.start(t0); noise.start(t0);
      osc.stop(t0 + dur + 0.1); osc2.stop(t0 + dur + 0.1); vib.stop(t0 + dur + 0.1); noise.stop(t0 + dur + 0.1);
      break;
    }
    case 'sauropod': {
      const dur = 2.6;
      const osc = ctx.createOscillator(); osc.type = 'triangle';
      osc.frequency.setValueAtTime(70 / sizeK, t0); osc.frequency.linearRampToValueAtTime(95 / sizeK, t0 + 0.8); osc.frequency.linearRampToValueAtTime(62 / sizeK, t0 + dur);
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.setValueAtTime(35 / sizeK, t0); sub.frequency.linearRampToValueAtTime(30 / sizeK, t0 + dur);
      const vib = ctx.createOscillator(); vib.frequency.value = 5.5; const vg = ctx.createGain(); vg.gain.setValueAtTime(0, t0); vg.gain.linearRampToValueAtTime(5, t0 + 0.8); vib.connect(vg); vg.connect(osc.frequency);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600; f.Q.value = 3;
      const env = ctx.createGain(); env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(0.8, t0 + 0.4); env.gain.setValueAtTime(0.8, t0 + dur * 0.6); env.gain.linearRampToValueAtTime(0, t0 + dur);
      osc.connect(f); sub.connect(f); f.connect(env); env.connect(out);
      osc.start(t0); sub.start(t0); vib.start(t0); osc.stop(t0 + dur); sub.stop(t0 + dur); vib.stop(t0 + dur);
      break;
    }
    case 'ceratopsian': {
      // grunt: two short pulses
      for (let i = 0; i < 2; i++) {
        const s = t0 + i * 0.42, dur = 0.34;
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(95 / sizeK, s); osc.frequency.exponentialRampToValueAtTime(70 / sizeK, s + dur);
        const noise = a.noise(); const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 350; nf.Q.value = 1;
        const ng = ctx.createGain(); ng.gain.value = 0.35;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(900, s); f.frequency.exponentialRampToValueAtTime(300, s + dur); f.Q.value = 4;
        const env = ctx.createGain(); env.gain.setValueAtTime(0, s); env.gain.linearRampToValueAtTime(0.9, s + 0.04); env.gain.exponentialRampToValueAtTime(0.001, s + dur);
        osc.connect(f); noise.connect(nf); nf.connect(ng); ng.connect(f); f.connect(env); env.connect(out);
        osc.start(s); noise.start(s); osc.stop(s + dur); noise.stop(s + dur);
      }
      break;
    }
    case 'raptor': {
      // screech: fast up-down chirps
      for (let i = 0; i < 3; i++) {
        const s = t0 + i * 0.22, dur = 0.19;
        const osc = ctx.createOscillator(); osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(900, s); osc.frequency.exponentialRampToValueAtTime(2200, s + 0.07); osc.frequency.exponentialRampToValueAtTime(700, s + dur);
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 1.5;
        const env = ctx.createGain(); env.gain.setValueAtTime(0, s); env.gain.linearRampToValueAtTime(0.5, s + 0.02); env.gain.exponentialRampToValueAtTime(0.001, s + dur);
        osc.connect(f); f.connect(env); env.connect(out); osc.start(s); osc.stop(s + dur);
      }
      break;
    }
    case 'pterosaur': {
      const dur = 0.9;
      const osc = ctx.createOscillator(); osc.type = 'square';
      osc.frequency.setValueAtTime(1200, t0); osc.frequency.exponentialRampToValueAtTime(2000, t0 + 0.3); osc.frequency.exponentialRampToValueAtTime(900, t0 + dur);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1600; f.Q.value = 2;
      const vib = ctx.createOscillator(); vib.frequency.value = 22; const vg = ctx.createGain(); vg.gain.value = 120; vib.connect(vg); vg.connect(osc.frequency);
      const env = ctx.createGain(); env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(0.35, t0 + 0.08); env.gain.setValueAtTime(0.35, t0 + 0.5); env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(f); f.connect(env); env.connect(out); osc.start(t0); vib.start(t0); osc.stop(t0 + dur); vib.stop(t0 + dur);
      break;
    }
    case 'marine': {
      // blow + splash: noise burst with a low whoosh
      const dur = 1.1;
      const noise = a.noise(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(300, t0); f.frequency.exponentialRampToValueAtTime(2500, t0 + 0.25); f.frequency.exponentialRampToValueAtTime(600, t0 + dur); f.Q.value = 0.8;
      const env = ctx.createGain(); env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(0.9, t0 + 0.1); env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      const osc = ctx.createOscillator(); osc.type = 'sine'; osc.frequency.setValueAtTime(140 / sizeK, t0); osc.frequency.exponentialRampToValueAtTime(60 / sizeK, t0 + 0.8);
      const oe = ctx.createGain(); oe.gain.setValueAtTime(0.6, t0); oe.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
      noise.connect(f); f.connect(env); env.connect(out); osc.connect(oe); oe.connect(out);
      noise.start(t0); osc.start(t0); noise.stop(t0 + dur); osc.stop(t0 + dur);
      break;
    }
    case 'chirp': default: {
      for (let i = 0; i < 4; i++) {
        const s = t0 + i * 0.16, dur = 0.12;
        const osc = ctx.createOscillator(); osc.type = 'sine';
        osc.frequency.setValueAtTime(700 + i * 120, s); osc.frequency.exponentialRampToValueAtTime(1500 + i * 100, s + 0.06); osc.frequency.exponentialRampToValueAtTime(900, s + dur);
        const env = ctx.createGain(); env.gain.setValueAtTime(0, s); env.gain.linearRampToValueAtTime(0.5, s + 0.02); env.gain.exponentialRampToValueAtTime(0.001, s + dur);
        osc.connect(env); env.connect(out); osc.start(s); osc.stop(s + dur);
      }
    }
  }
}
