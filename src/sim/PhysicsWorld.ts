/**
 * 主线程侧的物理世界门面：Worker 生命周期、输入上行、位姿下行与插值。
 * 协议见 ./protocol.ts —— Worker 每步发一个 16 float 的 transferable buffer。
 */
import {
  FIXED_DT,
  STATE,
  STATE_FLOATS,
} from './protocol';
import type { InputCommand, SimConfig, Snapshot, WorldSpec, WorkerRequest, WorkerResponse } from './protocol';

export interface RenderPose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  grounded: boolean;
  impact: number;
  flags: number;
  simTime: number;
  step: number;
}

const IDENTITY: RenderPose = {
  x: 0, y: 1, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
  vx: 0, vy: 0, vz: 0, speed: 0, grounded: false, impact: 0, flags: 0,
  simTime: 0, step: 0,
};

function slerp(
  ax: number, ay: number, az: number, aw: number,
  bx: number, by: number, bz: number, bw: number,
  t: number,
): [number, number, number, number] {
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  let bx2 = bx;
  let by2 = by;
  let bz2 = bz;
  let bw2 = bw;
  if (dot < 0) {
    dot = -dot;
    bx2 = -bx;
    by2 = -by;
    bz2 = -bz;
    bw2 = -bw;
  }
  if (dot > 0.9995) {
    const x = ax + (bx2 - ax) * t;
    const y = ay + (by2 - ay) * t;
    const z = az + (bz2 - az) * t;
    const w = aw + (bw2 - aw) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const sa = Math.sin((1 - t) * theta) / sinTheta;
  const sb = Math.sin(t * theta) / sinTheta;
  return [ax * sa + bx2 * sb, ay * sa + by2 * sb, az * sa + bz2 * sb, aw * sa + bw2 * sb];
}

export class PhysicsWorld {
  private worker: Worker;
  private prev = new Float32Array(STATE_FLOATS);
  private curr = new Float32Array(STATE_FLOATS);
  private hasState = false;
  private lastRecvAt = 0;
  private lastSentInput: InputCommand = { dirX: 0, dirZ: 0, throttle: 0 };
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;
  private readyPromise: Promise<void>;
  private onError?: (message: string) => void;

  private constructor(worker: Worker) {
    this.worker = worker;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      this.readyReject(new Error(event.message || 'physics worker error'));
      this.onError?.(event.message || 'physics worker error');
    };
  }

  static async create(spec: WorldSpec, config: SimConfig): Promise<PhysicsWorld> {
    const worker = new Worker(new URL('./physicsWorker.ts', import.meta.url), { type: 'module' });
    const world = new PhysicsWorld(worker);
    const init: WorkerRequest = { type: 'init', spec, config };
    worker.postMessage(init);
    await Promise.race([
      world.readyPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('physics worker 初始化超时（5s）')), 5000)),
    ]);
    return world;
  }

  setErrorHandler(handler: (message: string) => void): void {
    this.onError = handler;
  }

  private handleMessage(msg: WorkerResponse): void {
    if (msg.type === 'ready') {
      this.readyResolve();
      return;
    }
    if (msg.type === 'error') {
      this.readyReject(new Error(msg.message));
      this.onError?.(msg.message);
      return;
    }
    if (msg.type === 'state') {
      if (!this.hasState) {
        this.prev.set(new Float32Array(msg.buffer));
        this.hasState = true;
      } else {
        this.prev.set(this.curr);
      }
      this.curr.set(new Float32Array(msg.buffer));
      this.lastRecvAt = performance.now();
    }
  }

  /** 每帧调用；只在与上次下发的输入有明显差异时 post。 */
  sendInput(input: InputCommand): void {
    const last = this.lastSentInput;
    if (
      Math.abs(input.dirX - last.dirX) < 0.01 &&
      Math.abs(input.dirZ - last.dirZ) < 0.01 &&
      Math.abs(input.throttle - last.throttle) < 0.01
    ) return;
    this.lastSentInput = { ...input };
    this.worker.postMessage({ type: 'input', input } satisfies WorkerRequest);
  }

  setConfig(partial: Partial<SimConfig>): void {
    this.worker.postMessage({ type: 'config', config: partial } satisfies WorkerRequest);
  }

  reset(): void {
    this.worker.postMessage({ type: 'reset' } satisfies WorkerRequest);
  }

  pause(paused: boolean): void {
    this.worker.postMessage({ type: 'pause', paused } satisfies WorkerRequest);
  }

  /** 渲染插值：prev → curr，alpha 按收到上一帧后的时间推进（约 1 步延迟）。 */
  sample(now: number): RenderPose {
    if (!this.hasState) return { ...IDENTITY };
    const alpha = Math.max(0, Math.min(1, (now - this.lastRecvAt) / (FIXED_DT * 1000)));
    const a = this.prev;
    const b = this.curr;
    const lerp = (i: number) => a[i] + (b[i] - a[i]) * alpha;
    const [qx, qy, qz, qw] = slerp(
      a[STATE.QX], a[STATE.QY], a[STATE.QZ], a[STATE.QW],
      b[STATE.QX], b[STATE.QY], b[STATE.QZ], b[STATE.QW],
      alpha,
    );
    return {
      x: lerp(STATE.PX),
      y: lerp(STATE.PY),
      z: lerp(STATE.PZ),
      qx, qy, qz, qw,
      vx: lerp(STATE.VX),
      vy: lerp(STATE.VY),
      vz: lerp(STATE.VZ),
      speed: lerp(STATE.SPEED),
      grounded: b[STATE.GROUNDED] > 0.5,
      impact: Math.max(a[STATE.IMPACT], b[STATE.IMPACT]),
      flags: b[STATE.FLAGS],
      simTime: lerp(STATE.TIME),
      step: b[STATE.STEP],
    };
  }

  /** 最近一次原始快照（调试 / 指标用，不插值）。 */
  latest(): Snapshot | null {
    if (!this.hasState) return null;
    const f = this.curr;
    return {
      simTime: f[STATE.TIME],
      step: f[STATE.STEP],
      px: f[STATE.PX],
      py: f[STATE.PY],
      pz: f[STATE.PZ],
      qx: f[STATE.QX],
      qy: f[STATE.QY],
      qz: f[STATE.QZ],
      qw: f[STATE.QW],
      vx: f[STATE.VX],
      vy: f[STATE.VY],
      vz: f[STATE.VZ],
      speed: f[STATE.SPEED],
      grounded: f[STATE.GROUNDED] > 0.5,
      landImpact: f[STATE.IMPACT],
      flags: f[STATE.FLAGS],
    };
  }

  dispose(): void {
    this.worker.terminate();
  }
}
