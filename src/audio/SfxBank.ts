/**
 * howler 音效库：全部波形在运行时合成（无外部音频资产）。
 * 逐跳“叮”、碰撞材质音、到站和弦；静音开关默认读 localStorage。
 * 浏览器要求用户手势后才能出声：main 在首次输入时调用 unlock()。
 */
declare global {
  interface Window {
    Howl?: new (opts: Record<string, unknown>) => {
      play: (id?: number) => number;
      volume: (v: number) => void;
      unload: () => void;
    };
    Howler?: {
      ctx?: AudioContext;
      volume: (v: number) => void;
      mute: (m: boolean) => void;
      _muted?: boolean;
    };
  }
}

const STORAGE_KEY = 'packet-orb/muted';

function encodeWav(samples: Float32Array, sampleRate = 44100): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function tone(freq: number, duration: number, shape: 'sine' | 'triangle' | 'square', decay = 4): Float32Array {
  const rate = 44100;
  const n = Math.floor(duration * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const phase = Math.sin(2 * Math.PI * freq * t);
    let v = phase;
    if (shape === 'triangle') v = (2 / Math.PI) * Math.asin(phase);
    else if (shape === 'square') v = phase >= 0 ? 1 : -1;
    out[i] = v * Math.exp(-t * decay) * 0.35;
  }
  return out;
}

function noiseBurst(duration: number, lowFreq: number): Float32Array {
  const rate = 44100;
  const n = Math.floor(duration * rate);
  const out = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    const white = Math.random() * 2 - 1;
    last = last * 0.86 + white * 0.14; // 简单低通，听起来更像撞击而不是白噪
    const body = Math.sin(2 * Math.PI * lowFreq * t) * Math.exp(-t * 18);
    out[i] = (last * 0.5 + body * 0.6) * Math.exp(-t * 9) * 0.45;
  }
  return out;
}

function chord(freqs: number[], duration: number): Float32Array {
  const rate = 44100;
  const n = Math.floor(duration * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    let v = 0;
    for (const [k, f] of freqs.entries()) {
      const start = k * 0.09;
      if (t < start) continue;
      v += Math.sin(2 * Math.PI * f * (t - start)) * Math.exp(-(t - start) * 3.2);
    }
    out[i] = v * 0.16 * Math.min(1, t * 14);
  }
  return out;
}

interface HowlLike {
  play: () => number;
  unload: () => void;
  volume: (v: number) => void;
}

export class SfxBank {
  private readonly howls = new Map<string, HowlLike>();
  private ready = false;
  private muted = false;
  private readonly button: HTMLButtonElement;
  private lastHopAt = 0;

  constructor(host: HTMLElement) {
    try {
      this.muted = localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    this.button = document.createElement('button');
    this.button.className = 'po-sound';
    this.button.type = 'button';
    this.button.addEventListener('click', () => this.toggle());
    this.renderButton();
    host.appendChild(this.button);
  }

  private renderButton(): void {
    this.button.textContent = this.muted ? 'SOUND OFF' : 'SOUND ON';
    this.button.dataset.muted = String(this.muted);
  }

  private ensure(): boolean {
    if (this.ready) return true;
    const HowlCtor = window.Howl;
    if (!HowlCtor) return false;
    this.ready = true;
    const make = (name: string, data: string, volume: number): void => {
      const howl = new HowlCtor({ src: [data], format: ['wav'], volume, preload: true });
      this.howls.set(name, howl as unknown as HowlLike);
    };
    make('hop', encodeWav(tone(760, 0.11, 'triangle', 9)), 0.5);
    make('hopLow', encodeWav(tone(520, 0.13, 'triangle', 8)), 0.45);
    make('hitRoad', encodeWav(noiseBurst(0.16, 120)), 0.55);
    make('hitMetal', encodeWav(noiseBurst(0.2, 220)), 0.5);
    make('hitTramp', encodeWav(tone(300, 0.22, 'sine', 6)), 0.55);
    make('arrive', encodeWav(chord([523.25, 659.25, 783.99, 1046.5], 1.1)), 0.7);
    this.applyMute();
    return true;
  }

  private applyMute(): void {
    const howler = window.Howler;
    if (!howler) return;
    howler.mute(this.muted);
  }

  unlock(): void {
    this.ensure();
    const ctx = window.Howler?.ctx;
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  private play(name: string): void {
    if (this.muted) return;
    if (!this.ensure()) return;
    this.howls.get(name)?.play();
  }

  hop(ttl: number): void {
    const now = performance.now();
    if (now - this.lastHopAt < 120) return;
    this.lastHopAt = now;
    this.play(ttl % 2 === 0 ? 'hop' : 'hopLow');
  }

  impact(kind: 'road' | 'wall' | 'trampoline', intensity: number): void {
    if (intensity < 0.08) return;
    this.play(kind === 'wall' ? 'hitMetal' : kind === 'trampoline' ? 'hitTramp' : 'hitRoad');
  }

  arrive(): void {
    this.play('arrive');
  }

  toggle(): void {
    this.muted = !this.muted;
    this.renderButton();
    this.applyMute();
    try {
      localStorage.setItem(STORAGE_KEY, this.muted ? '1' : '0');
    } catch {
      // 忽略
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    this.howls.forEach((h) => h.unload());
    this.howls.clear();
    this.button.remove();
  }
}
