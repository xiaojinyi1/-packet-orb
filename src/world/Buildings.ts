/**
 * 装饰建筑：一律 InstancedMesh（CLAUDE.md 性能预算：建筑必须实例化）。
 * 只做体块，不做窗、不做招牌——那是 M2 美术阶段的事。
 */
import * as THREE from 'three';
import { matcapMaterial } from '../render/MatcapMaterial';
import { buildingTint } from '../render/Theme';
import { sampleAtS, zoneAtS, type Layout } from './LayoutSolver';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BuildingInstance {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rot: number;
  color: THREE.Color;
}

export function buildBuildings(layout: Layout, seed = 20261105): THREE.Group {
  const group = new THREE.Group();
  group.name = 'packet-orb-buildings';

  const rand = mulberry32(seed);
  const instances: BuildingInstance[] = [];
  const minClear = layout.width / 2 + 8;
  const baseY = layout.minY - 7.6;

  for (let s = 8; s < layout.totalLength - 6; s += 6 + rand() * 8) {
    const sample = sampleAtS(layout.samples, s);
    if (!sample || sample.gap) continue;

    for (const sign of [-1, 1] as const) {
      if (rand() < 0.16) continue;
      const offset = 17 + rand() * 17;
      const x = sample.x + sample.sx * sign * offset;
      const z = sample.z + sample.sz * sign * offset;

      // 发卡弯会让两段路贴得很近：任何一个路面采样点附近都不许放楼
      let blocked = false;
      for (let k = 0; k < layout.samples.length; k += 4) {
        const p = layout.samples[k];
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < minClear * minClear) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const w = 3 + rand() * 4.5;
      const d = 3 + rand() * 5;
      // 楼体从盆地底面一直长到街面上方的天际线，避免悬空
      const topY = sample.y + 2.5 + rand() * 12;
      const h = Math.max(4, topY - baseY);
      const zone = zoneAtS(layout, s);
      const color = new THREE.Color(buildingTint(zone.index, rand()));
      instances.push({
        x,
        y: baseY + h / 2,
        z,
        w,
        h,
        d,
        rot: Math.atan2(sample.tx, sample.tz) + (rand() - 0.5) * 0.35,
        color,
      });
    }
  }

  if (instances.length === 0) return group;

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = matcapMaterial(1, { color: '#ffffff' });
  const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
  mesh.name = 'buildings-blocks';
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  instances.forEach((b, i) => {
    pos.set(b.x, b.y, b.z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot);
    scale.set(b.w, b.h, b.d);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, b.color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);

  return group;
}

export function disposeBuildings(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      obj.geometry.dispose();
      const material = obj.material;
      const mats = Array.isArray(material) ? material : [material];
      mats.forEach((m) => {
        // 共享 matcap 材质由 MatcapMaterial 统一管理，重建世界时不能释放。
        if (!m.userData.poShared) m.dispose();
      });
      obj.dispose();
    }
  });
}
