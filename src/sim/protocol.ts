/**
 * 主线程 ⇄ 物理 Worker 的共享协议（只有类型与常量，无运行时副作用）。
 */

export const FIXED_DT = 1 / 60;
export const STATE_FLOATS = 16;

export const STATE = {
  TIME: 0,
  PX: 1,
  PY: 2,
  PZ: 3,
  QX: 4,
  QY: 5,
  QZ: 6,
  QW: 7,
  VX: 8,
  VY: 9,
  VZ: 10,
  SPEED: 11,
  GROUNDED: 12,
  IMPACT: 13,
  STEP: 14,
  FLAGS: 15,
} as const;

export const SIM_FLAG = {
  RESPAWN: 1 << 0,
  TRAMPOLINE: 1 << 1,
  NaN_GUARD: 1 << 2,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TrimeshColliderSpec {
  kind: 'trimesh';
  vertices: Float32Array;
  indices: Uint32Array;
  friction: number;
  restitution: number;
}

export interface CuboidColliderSpec {
  kind: 'cuboid';
  halfExtents: [number, number, number];
  position: [number, number, number];
  rotation: [number, number, number, number];
  friction: number;
  restitution: number;
}

export type ColliderSpec = TrimeshColliderSpec | CuboidColliderSpec;

export interface ZoneSpec {
  kind: 'trampoline';
  center: Vec3;
  tangent: Vec3;
  side: Vec3;
  halfLength: number;
  halfWidth: number;
}

export interface WorldSpec {
  colliders: ColliderSpec[];
  zones: ZoneSpec[];
  spawn: Vec3;
  checkpoints: Vec3[];
  fallY: number;
}

export interface SimConfig {
  /** 力矩份额，0.7 = 70% torque + 30% 直接力。 */
  torqueShare: number;
  /** 力矩上限 N·m（再乘份额）。 */
  torquePower: number;
  /** 直接力上限 N（再乘份额）。 */
  forcePower: number;
  /** 高速时 drive assist 下限，0.4 = 衰减到 40%。 */
  assistFloor: number;
  linearDamping: number;
  angularDamping: number;
  rollingFriction: number;
  gravity: number;
  restitution: number;
  maxSpeed: number;
}

export interface InputCommand {
  /** 世界空间水平单位向量；方向来自镜头朝向。 */
  dirX: number;
  dirZ: number;
  /** 0~1，-1 表示倒车。 */
  throttle: number;
}

export interface Snapshot {
  simTime: number;
  step: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  grounded: boolean;
  landImpact: number;
  flags: number;
}

export type WorkerRequest =
  | { type: 'init'; spec: WorldSpec; config: SimConfig }
  | { type: 'input'; input: InputCommand }
  | { type: 'reset' }
  | { type: 'config'; config: Partial<SimConfig> }
  | { type: 'pause'; paused: boolean }
  | { type: 'recycle'; buffer: ArrayBuffer };

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'state'; buffer: ArrayBuffer; simTime: number; step: number }
  | { type: 'error'; message: string };

export function defaultSimConfig(): SimConfig {
  return {
    torqueShare: 0.7,
    torquePower: 3.2,
    forcePower: 10,
    assistFloor: 0.4,
    linearDamping: 0.28,
    angularDamping: 0.32,
    rollingFriction: 0.02,
    gravity: 9.81,
    restitution: 0.52,
    maxSpeed: 13,
  };
}

export function readSnapshot(buffer: ArrayBuffer): Snapshot {
  const f = new Float32Array(buffer);
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
