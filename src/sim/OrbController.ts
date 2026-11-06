/**
 * Packet Orb 的刚体与驱动。
 * 混合驱动：70% 绕 (up × 方向) 的力矩 + 30% 质心直接力，
 * drive assist 随水平速度线性衰减到 assistFloor。
 * 球体参数严格按 CLAUDE.md 参数区：r=0.45 / mass=1.2 / damping 0.28·0.32 / rolling 0.02。
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { InputCommand, SimConfig, Vec3 } from './protocol';

export const ORB_RADIUS = 0.45;
export const ORB_MASS = 1.2;
/**
 * 碰撞摩擦与“滚动摩擦 0.02”不是一回事：
 * 0.02 是滚动阻力系数（在 applyRollingResistance 里按力矩施加），
 * 碰撞面摩擦必须足够大，否则 70% 的力矩驱动力全变成空转，球只会滑不会滚。
 */
export const ORB_SURFACE_FRICTION = 0.95;

export function createOrb(
  world: RAPIER.World,
  spawn: Vec3,
  config: SimConfig,
): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(config.linearDamping)
      .setAngularDamping(config.angularDamping)
      .setCcdEnabled(true)
      .setCanSleep(false),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.ball(ORB_RADIUS)
      .setMass(ORB_MASS)
      .setFriction(ORB_SURFACE_FRICTION)
      .setRestitution(config.restitution)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max),
    body,
  );
  return { body, collider };
}

export function applyDrive(
  body: RAPIER.RigidBody,
  input: InputCommand,
  config: SimConfig,
  grounded: boolean,
): void {
  const v = body.linvel();
  const speed = Math.hypot(v.x, v.z);
  let dx = input.dirX;
  let dz = input.dirZ;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    applyRollingResistance(body, config, grounded);
    return;
  }
  dx /= len;
  dz /= len;
  const throttle = Math.max(-1, Math.min(1, input.throttle));
  if (Math.abs(throttle) < 1e-3) {
    applyRollingResistance(body, config, grounded);
    return;
  }

  // 速度越高辅助越弱，最低到 assistFloor（默认 0.4）
  const assist = 1 - (1 - config.assistFloor) * Math.min(1, speed / config.maxSpeed);
  // 空中只保留少量操控
  const airFactor = grounded ? 1 : 0.18;
  const gain = throttle * assist * airFactor;

  // 力矩轴 = up × 前进方向 = (dz, 0, -dx)，正扭矩让球向 dz/-dx 滚动
  const torque = config.torquePower * config.torqueShare * gain;
  body.addTorque({ x: dz * torque, y: 0, z: -dx * torque }, true);

  const force = config.forcePower * (1 - config.torqueShare) * gain;
  body.addForce({ x: dx * force, y: 0, z: dz * force }, true);

  // 超过 maxSpeed 时给一个线性回拉，防止一路加速到失控
  if (speed > config.maxSpeed) {
    const overshoot = speed - config.maxSpeed;
    const brake = Math.min(overshoot * 6, 18) * ORB_MASS;
    body.addForce({ x: (-v.x / speed) * brake, y: 0, z: (-v.z / speed) * brake }, true);
  }

  applyRollingResistance(body, config, grounded);
}

/** 滚动阻力：力矩与角速度反向，量级 rollingFriction · m · g · R。 */
function applyRollingResistance(body: RAPIER.RigidBody, config: SimConfig, grounded: boolean): void {
  if (!grounded) return;
  const w = body.angvel();
  const wl = Math.hypot(w.x, w.y, w.z);
  if (wl < 0.15) return;
  const magnitude = config.rollingFriction * ORB_MASS * config.gravity * ORB_RADIUS;
  body.addTorque(
    { x: (-w.x / wl) * magnitude, y: (-w.y / wl) * magnitude, z: (-w.z / wl) * magnitude },
    true,
  );
}

/** 每次改体重建 damping，tweakpane 实时生效。 */
export function applyConfigToBody(body: RAPIER.RigidBody, config: SimConfig): void {
  body.setLinearDamping(config.linearDamping);
  body.setAngularDamping(config.angularDamping);
}

export function resetOrb(body: RAPIER.RigidBody, spawn: Vec3): void {
  body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
  body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  body.wakeUp();
}
