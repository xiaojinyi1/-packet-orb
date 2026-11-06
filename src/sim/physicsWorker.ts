/**
 * 物理 Worker：rapier 只在这里初始化，固定步长 1/60，用累加器追实时时间。
 * 每个物理步产出 16 个 float，通过 transferable ArrayBuffer 回主线程。
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { SimCore, type StepResult } from './SimCore';
import { FIXED_DT, STATE, STATE_FLOATS } from './protocol';
import type { InputCommand, SimConfig, WorkerRequest, WorkerResponse, WorldSpec } from './protocol';

interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const ctx = self as unknown as WorkerScope;

let sim: SimCore | null = null;
let config: SimConfig | null = null;
let input: InputCommand = { dirX: 0, dirZ: 0, throttle: 0 };
let paused = false;
let accumulator = 0;
let lastTime = 0;
let loop: ReturnType<typeof setInterval> | null = null;

function postState(result: StepResult): void {
  const buffer = new ArrayBuffer(STATE_FLOATS * 4);
  const f = new Float32Array(buffer);
  f[STATE.TIME] = result.time;
  f[STATE.PX] = result.x;
  f[STATE.PY] = result.y;
  f[STATE.PZ] = result.z;
  f[STATE.QX] = result.qx;
  f[STATE.QY] = result.qy;
  f[STATE.QZ] = result.qz;
  f[STATE.QW] = result.qw;
  f[STATE.VX] = result.vx;
  f[STATE.VY] = result.vy;
  f[STATE.VZ] = result.vz;
  f[STATE.SPEED] = result.speed;
  f[STATE.GROUNDED] = result.grounded ? 1 : 0;
  f[STATE.IMPACT] = result.impact;
  f[STATE.STEP] = result.step;
  f[STATE.FLAGS] = result.flags;
  ctx.postMessage({ type: 'state', buffer, simTime: result.time, step: result.step }, [buffer]);
}

function tick(): void {
  if (!sim) return;
  const now = performance.now();
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.25) dt = 0.25;
  if (paused) return;
  accumulator += dt;
  let result: StepResult | null = null;
  let steps = 0;
  while (accumulator >= FIXED_DT && steps < 6) {
    result = sim.step(input);
    accumulator -= FIXED_DT;
    steps += 1;
  }
  if (result) postState(result);
}

async function init(spec: WorldSpec, initialConfig: SimConfig): Promise<void> {
  await RAPIER.init();
  config = { ...initialConfig };
  sim = new SimCore(spec, config);
  lastTime = performance.now();
  accumulator = 0;
  ctx.postMessage({ type: 'ready' });
  if (loop !== null) clearInterval(loop);
  loop = setInterval(tick, 5);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      init(msg.spec, msg.config).catch((err: unknown) => {
        ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      });
      break;
    case 'input':
      input = msg.input;
      break;
    case 'config':
      if (sim && config) {
        config = { ...config, ...msg.config };
        sim.setConfig(config);
      }
      break;
    case 'reset':
      if (sim) {
        sim.reset();
        accumulator = FIXED_DT;
      }
      break;
    case 'pause':
      paused = msg.paused;
      lastTime = performance.now();
      accumulator = 0;
      break;
    default:
      break;
  }
};
