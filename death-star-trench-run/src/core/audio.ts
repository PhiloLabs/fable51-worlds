/**
 * Fully procedural WebAudio SFX — no asset files.
 * Everything is synthesised: engine hum, laser bolts, explosions, torpedoes,
 * alarms and a low tension drone.  Created lazily on the first user gesture.
 */
export class Audio {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private musicGain!: GainNode;
  private sfxGain!: GainNode;
  private engineOsc: OscillatorNode[] = [];
  private engineGain!: GainNode;
  private noiseBuf: AudioBuffer | null = null;
  private droneNodes: AudioNode[] = [];
  enabled = true;
  private started = false;

  init() {
    if (this.started) return;
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const c = this.ctx!;
      this.master = c.createGain(); this.master.gain.value = 0.55; this.master.connect(c.destination);
      this.musicGain = c.createGain(); this.musicGain.gain.value = 0.32; this.musicGain.connect(this.master);
      this.sfxGain = c.createGain(); this.sfxGain.gain.value = 1.0; this.sfxGain.connect(this.master);

      // white-noise buffer reused by every noisy effect
      const len = c.sampleRate * 2;
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;

      this.buildEngine();
      this.started = true;
    } catch { /* audio is optional */ }
  }

  resume() { this.ctx?.resume?.(); }
  setMasterVolume(v: number) { if (this.master) this.master.gain.value = v; }

  private noise(dur: number, gain: number, filter?: { type: BiquadFilterType; freq: number; q?: number }) {
    const c = this.ctx!; const src = c.createBufferSource();
    src.buffer = this.noiseBuf!; src.loop = true;
    let node: AudioNode = src;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = filter.type; f.frequency.value = filter.freq; f.Q.value = filter.q ?? 1;
      src.connect(f); node = f;
    }
    const g = c.createGain(); g.gain.value = gain;
    node.connect(g); g.connect(this.sfxGain);
    src.start(); src.stop(c.currentTime + dur);
    return { g, f: filter ? (node as BiquadFilterNode) : null };
  }

  private buildEngine() {
    const c = this.ctx!;
    this.engineGain = c.createGain(); this.engineGain.gain.value = 0.0; this.engineGain.connect(this.sfxGain);
    // layered saw drones + filtered noise = ion engine
    for (const [f, g, type] of [[46, 0.22, 'sawtooth'], [69, 0.13, 'sawtooth'], [92, 0.08, 'square'], [138, 0.05, 'sawtooth']] as const) {
      const o = c.createOscillator(); o.type = type as OscillatorType; o.frequency.value = f;
      const gg = c.createGain(); gg.gain.value = g;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.Q.value = 0.7;
      o.connect(gg); gg.connect(lp); lp.connect(this.engineGain); o.start();
      this.engineOsc.push(o);
    }
    const src = c.createBufferSource(); src.buffer = this.noiseBuf!; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 0.8;
    const ng = c.createGain(); ng.gain.value = 0.16;
    src.connect(bp); bp.connect(ng); ng.connect(this.engineGain); src.start();
  }

  /** throttle 0..1, boost adds pitch */
  setEngine(throttle: number, boost = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0.34 * throttle, t, 0.12);
    const p = 1 + boost * 0.34 + throttle * 0.12;
    for (let i = 0; i < this.engineOsc.length; i++) {
      const base = [46, 69, 92, 138][i];
      this.engineOsc[i].frequency.setTargetAtTime(base * p, t, 0.16);
    }
  }

  laser(pitch = 1, vol = 0.5) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(1750 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(180 * pitch, t + 0.16);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.30 * vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200 * pitch; f.Q.value = 2.2;
    o.connect(f); f.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + 0.22);
  }

  explosion(size = 1, vol = 0.8) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const dur = 0.5 + size * 1.6;
    const { g, f } = this.noise(dur + 0.2, 0.0001, { type: 'lowpass', freq: 1800 / Math.max(size, 0.4), q: 0.9 });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.75 * vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (f) { f.frequency.setValueAtTime(2400 / Math.max(size, 0.4), t); f.frequency.exponentialRampToValueAtTime(70, t + dur); }
    // sub-bass thump
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(88 / Math.max(size * 0.6, 0.5), t);
    o.frequency.exponentialRampToValueAtTime(24, t + dur * 0.7);
    const og = c.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.6 * vol * Math.min(size, 2.4), t + 0.03);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(og); og.connect(this.sfxGain); o.start(t); o.stop(t + dur + 0.05);
  }

  torpedo() {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(1400, t + 0.34);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2600;
    o.connect(f); f.connect(g); g.connect(this.sfxGain);
    o.start(t); o.stop(t + 0.85);
    this.noise(0.7, 0.12, { type: 'highpass', freq: 900 }).g.gain.setTargetAtTime(0.0001, t + 0.1, 0.2);
  }

  beep(freq = 900, dur = 0.08, vol = 0.2) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfxGain); o.start(t); o.stop(t + dur + 0.02);
  }

  alarm(on: boolean) {
    if (!this.ctx || !this.enabled) return;
    if (on) this.beep(660, 0.12, 0.16);
  }

  /** slow evolving tension drone; call with 0..1 */
  private droneGain: GainNode | null = null;
  setDrone(level: number, root = 55) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx;
    if (!this.droneGain) {
      this.droneGain = c.createGain(); this.droneGain.gain.value = 0; this.droneGain.connect(this.musicGain);
      for (const [mult, gain, det] of [[1, 0.3, 0], [1.5, 0.18, 4], [2, 0.14, -5], [3, 0.06, 7], [4.02, 0.04, 0]] as const) {
        const o = c.createOscillator(); o.type = 'sawtooth';
        o.frequency.value = root * mult; o.detune.value = det;
        const g = c.createGain(); g.gain.value = gain;
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 1.1;
        const lfo = c.createOscillator(); lfo.frequency.value = 0.07 + Math.random() * 0.09;
        const lfoG = c.createGain(); lfoG.gain.value = 90;
        lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();
        o.connect(g); g.connect(lp); lp.connect(this.droneGain); o.start();
        this.droneNodes.push(o, lfo);
      }
    }
    this.droneGain.gain.setTargetAtTime(level * 0.55, c.currentTime, 1.4);
  }

  /** deep sub-rumble for the destruction */
  rumble(dur = 6, vol = 0.9) {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx, t = c.currentTime;
    const { g, f } = this.noise(dur + 0.3, 0.0001, { type: 'lowpass', freq: 140, q: 1.2 });
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * vol, t + 0.6);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.45, dur * 0.35);
    if (f) f.frequency.setTargetAtTime(45, t, dur * 0.4);
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(38, t);
    o.frequency.exponentialRampToValueAtTime(17, t + dur);
    const og = c.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.85 * vol, t + 0.35);
    og.gain.setTargetAtTime(0.0001, t + dur * 0.5, dur * 0.3);
    o.connect(og); og.connect(this.sfxGain); o.start(t); o.stop(t + dur + 0.4);
  }

  dispose() { try { this.ctx?.close(); } catch { /* ignore */ } }
}

export const audio = new Audio();
