/**
 * 触发区：M0 只有蹦床。物理上蹦床板已经是 restitution 0.88 的静态刚体，
 * 这里额外给一次干净的向上速度，并沿路面方向补一脚前进速度——
 * 否则低速进入蹦床会陷入“原地无限弹跳”（水平速度被逐次衰减到 0）。
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ZoneSpec } from './protocol';

const TRAMPOLINE_BOUNCE = 8.5;
const TRAMPOLINE_COOLDOWN = 0.4;
const TRAMPOLINE_MIN_FORWARD = 6.5;
const TRAMPOLINE_FORWARD_BOOST = 2.5;

export interface TriggerState {
  cooldown: number;
  // 最近一次触发落在哪块 zone 上，供调试/渲染用
  lastZone: number;
}

export function createTriggerState(): TriggerState {
  return { cooldown: 0, lastZone: -1 };
}

export function updateTriggers(
  state: TriggerState,
  body: RAPIER.RigidBody,
  zones: ZoneSpec[],
  dt: number,
): boolean {
  state.cooldown = Math.max(0, state.cooldown - dt);
  if (state.cooldown > 0) return false;
  const p = body.translation();
  const v = body.linvel();
  if (v.y > 1.5) return false; // 已经在上升，不重复弹

  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i];
    const rx = p.x - zone.center.x;
    const ry = p.y - zone.center.y;
    const rz = p.z - zone.center.z;
    const along = rx * zone.tangent.x + ry * zone.tangent.y + rz * zone.tangent.z;
    const side = rx * zone.side.x + ry * zone.side.y + rz * zone.side.z;
    const up = ry; // 蹦床都在水平/近水平路面上，up 取世界 Y
    if (Math.abs(along) > zone.halfLength) continue;
    if (Math.abs(side) > zone.halfWidth) continue;
    if (up < 0.15 || up > 1.25) continue;

    // 水平切向（去掉 tangent 的 y 分量后重新归一）
    const tl = Math.hypot(zone.tangent.x, zone.tangent.z) || 1;
    const fx = zone.tangent.x / tl;
    const fz = zone.tangent.z / tl;
    const forward = Math.max(v.x * fx + v.z * fz, TRAMPOLINE_MIN_FORWARD) + TRAMPOLINE_FORWARD_BOOST;
    body.setLinvel({ x: fx * forward, y: TRAMPOLINE_BOUNCE, z: fz * forward }, true);
    const w = body.angvel();
    body.setAngvel({ x: w.x * 0.85, y: w.y * 0.85, z: w.z * 0.85 }, true);
    state.cooldown = TRAMPOLINE_COOLDOWN;
    state.lastZone = i;
    return true;
  }
  return false;
}
