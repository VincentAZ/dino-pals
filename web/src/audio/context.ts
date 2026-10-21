// Web Audio bootstrap: one context, master chain, unlock on first touch, pause on hide.
export class AudioEngine {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  ambience: GainNode;
  music: GainNode;
  voices: GainNode;
  noiseBuffer: AudioBuffer;
  unlocked = false;
  constructor() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 4; comp.attack.value = 0.01; comp.release.value = 0.25;
    this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
    this.master.connect(comp); comp.connect(this.ctx.destination);
    this.sfx = this.mk(0.8); this.ambience = this.mk(0.55); this.music = this.mk(0.22); this.voices = this.mk(0.8);
    // 2 s white noise buffer shared by everything
    const n = this.ctx.sampleRate * 2; this.noiseBuffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  private mk(v: number): GainNode { const g = this.ctx.createGain(); g.gain.value = v; g.connect(this.master); return g; }
  async unlock(): Promise<void> {
    try { await this.ctx.resume(); } catch { /* ignore */ }
    // iOS: play a silent buffer to fully unlock
    try { const s = this.ctx.createBufferSource(); s.buffer = this.ctx.createBuffer(1, 1, 22050); s.connect(this.ctx.destination); s.start(0); } catch { /* ignore */ }
    this.unlocked = true;
  }
  get now(): number { return this.ctx.currentTime; }
  noise(): AudioBufferSourceNode { const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuffer; s.loop = true; return s; }
  /** Simple distance attenuation + stereo pan for a world position relative to the listener. */
  spatial(dist: number, pan: number, maxDist = 140): { gain: number; pan: number } {
    return { gain: Math.max(0, 1 - dist / maxDist) ** 1.5, pan: Math.max(-1, Math.min(1, pan)) };
  }
  async suspend(): Promise<void> { try { await this.ctx.suspend(); } catch { /* ignore */ } }
  async resume(): Promise<void> { if (this.unlocked) { try { await this.ctx.resume(); } catch { /* ignore */ } } }
}
