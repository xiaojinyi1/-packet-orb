/**
 * 物理内核：不依赖 DOM / three / Worker，可以直接被 vitest 驱动做 30 秒自动驾驶验证。
 * 固定步长由调用方保证（worker 用累加器，测试直接 step）。
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { addStaticColliders, createStaticBody } from './Colliders';
import { applyConfigToBody, applyDrive, createOrb, resetOrb } from './OrbController';
import { createTriggerState, updateTriggers, type TriggerState } from './Triggers';
import { FIXED_DT, SIM_FLAG } from './protocol';
import type { InputCommand, SimConfig, WorldSpec } from './protocol';

const NO_INPUT: InputCommand = { dirX: 0, dirZ: 0, throttle: 0 };

export interface StepResult {
  time: number;
  step: number;
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
}

export class SimCore {
  readonly world: RAPIER.World;
  readonly body: RAPIER.RigidBody;
  readonly orbCollider: RAPIER.Collider;
  readonly spec: WorldSpec;
  config: SimConfig;

  private triggers: TriggerState = createTriggerState();
  private stepCount = 0;
  private grounded = false;
  private prevVy = 0;

  constructor(spec: WorldSpec, config: SimConfig) {
    this.spec = spec;
    this.config = { ...config };
    this.world = new RAPIER.World({ x: 0, y: -config.gravity, z: 0 });
    this.world.integrationParameters.dt = FIXED_DT;
    const staticBody = createStaticBody(this.world);
    addStaticColliders(this.world, staticBody, spec.colliders);
    const orb = createOrb(this.world, spec.spawn, this.config);
    this.body = orb.body;
    this.orbCollider = orb.collider;
  }

  setConfig(next: SimConfig): void {
    this.config = { ...next };
    this.world.gravity = { x: 0, y: -next.gravity, z: 0 };
    applyConfigToBody(this.body, next);
    const collider = this.body.collider(0);
    if (collider) collider.setRestitution(next.restitution);
  }

  reset(): void {
    resetOrb(this.body, this.spec.spawn);
    this.stepCount = 0;
    this.grounded = false;
    this.prevVy = 0;
    this.triggers = createTriggerState();
  }

  isGrounded(): boolean {
    const p = this.body.translation();
    const ray = new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 0.45 + 0.14, true, undefined, undefined, this.orbCollider);
    return hit !== null;
  }

  step(input: InputCommand = NO_INPUT): StepResult {
    let flags = 0;
    const before = this.body.linvel();
    this.prevVy = before.y;
    const wasGrounded = this.grounded;

    const grounded = this.isGrounded();
    this.grounded = grounded;
    // rapier 0.17 的 addForce/addTorque 会跨步累积，必须在每步驱动前清空，
    // 否则 70% 力矩会一帧叠一帧，几十帧内就物理爆炸。
    this.body.resetForces(false);
    this.body.resetTorques(false);
    applyDrive(this.body, input, this.config, grounded);

    if (updateTriggers(this.triggers, this.body, this.spec.zones, FIXED_DT)) {
      flags |= SIM_FLAG.TRAMPOLINE;
      this.grounded = false;
    }

    this.world.step();
    this.stepCount += 1;

    const p = this.body.translation();
    const q = this.body.rotation();
    const v = this.body.linvel();

    let impact = 0;
    const nowGrounded = this.isGrounded();
    if (nowGrounded && !wasGrounded && this.prevVy < -1.2) {
      impact = Math.min(1, -this.prevVy / 9);
      this.grounded = true;
    }

    // NaN / 越界保护：一旦出现，重生成而不是让世界爆炸
    const finite =
      Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) &&
      Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w) &&
      Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    const fell = p.y < this.spec.fallY;
    if (!finite || fell) {
      flags |= SIM_FLAG.NaN_GUARD;
      if (fell) flags |= SIM_FLAG.RESPAWN;
      this.reset();
      const rp = this.body.translation();
      return {
        time: this.stepCount * FIXED_DT,
        step: this.stepCount,
        x: rp.x, y: rp.y, z: rp.z,
        qx: 0, qy: 0, qz: 0, qw: 1,
        vx: 0, vy: 0, vz: 0,
        speed: 0,
        grounded: true,
        impact: 0,
        flags,
      };
    }

    return {
      time: this.stepCount * FIXED_DT,
      step: this.stepCount,
      x: p.x, y: p.y, z: p.z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      vx: v.x, vy: v.y, vz: v.z,
      speed: Math.hypot(v.x, v.z),
      grounded: nowGrounded,
      impact,
      flags,
    };
  }
}

/** 便捷构造：先 init wasm，再建世界。 */
export async function createSimCore(spec: WorldSpec, config: SimConfig): Promise<SimCore> {
  await RAPIER.init();
  return new SimCore(spec, config);
}
