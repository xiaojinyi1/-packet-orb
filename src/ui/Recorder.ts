/**
 * 到站录屏：把 canvas 前 8 秒录成 WebM，失败时由调用方退回静态图。
 * 只依赖 MediaRecorder / canvas.captureStream，没有第三方库。
 */
export interface RecordingResult {
  url: string;
  blob: Blob;
  mime: string;
  ms: number;
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private autoStop: number | null = null;
  private onDone: ((result: RecordingResult | null) => void) | null = null;

  get supported(): boolean {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function'
    );
  }

  get recording(): boolean {
    return this.recorder !== null;
  }

  /** 开始录；到 ms 自动停止并把结果交给 onDone。 */
  start(canvas: HTMLCanvasElement, onDone: (result: RecordingResult | null) => void, ms = 8000): boolean {
    if (this.recorder) this.stop();
    if (!this.supported) {
      onDone(null);
      return false;
    }
    try {
      this.stream = canvas.captureStream(30);
      const mime = pickMime();
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 5_000_000 } : undefined);
      this.chunks = [];
      this.onDone = onDone;
      this.startedAt = performance.now();
      this.recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.chunks.push(event.data);
      };
      this.recorder.onstop = () => this.finish();
      this.recorder.start(250);
      this.autoStop = window.setTimeout(() => this.stop(), ms);
      return true;
    } catch {
      this.cleanup();
      onDone(null);
      return false;
    }
  }

  stop(): void {
    if (this.autoStop !== null) {
      window.clearTimeout(this.autoStop);
      this.autoStop = null;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        this.finish();
      }
    }
  }

  dispose(): void {
    this.stop();
    this.cleanup();
  }

  private finish(): void {
    const cb = this.onDone;
    this.onDone = null;
    const ms = performance.now() - this.startedAt;
    const type = this.recorder?.mimeType || 'video/webm';
    const blob = new Blob(this.chunks, { type });
    this.cleanup();
    if (cb) cb(blob.size > 1024 ? { url: URL.createObjectURL(blob), blob, mime: type, ms } : null);
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

function pickMime(): string | null {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}
