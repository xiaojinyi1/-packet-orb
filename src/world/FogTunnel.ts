/**
 * 迷雾隧道：连续匿名跳（>=4）合并成一条，只生成一层壳，避免重复雾墙。
 * 纯视觉，无碰撞；引导线用青色折线，保证雾里还能看清路肩。
 */
import * as THREE from 'three';
import type { Layout } from './LayoutSolver';

const WALL_HEIGHT = 3.2;
const WALL_MARGIN = 0.14;
const FOG_COLOR = '#0b0818';
const GUIDE_COLOR = '#2ed3c6';

export function buildFogTunnels(layout: Layout): THREE.Group {
  const group = new THREE.Group();
  group.name = 'packet-orb-fog';

  if (layout.fogTunnels.length === 0) return group;

  const shell: number[] = [];
  const guides: number[] = [];
  const steps = 2; // 1m / 采样

  for (const tunnel of layout.fogTunnels) {
    const inside = layout.samples.filter((p) => p.s >= tunnel.startS - 0.001 && p.s <= tunnel.endS + 0.001);
    for (let i = 0; i + steps < inside.length; i += steps) {
      const a = inside[i];
      const b = inside[i + steps];
      const halfW = layout.width / 2 - WALL_MARGIN;
      const aL = { x: a.x - a.sx * halfW, y: a.y, z: a.z - a.sz * halfW };
      const aR = { x: a.x + a.sx * halfW, y: a.y, z: a.z + a.sz * halfW };
      const bL = { x: b.x - b.sx * halfW, y: b.y, z: b.z - b.sz * halfW };
      const bR = { x: b.x + b.sx * halfW, y: b.y, z: b.z + b.sz * halfW };

      const aLT = { x: aL.x, y: a.y + WALL_HEIGHT, z: aL.z };
      const aRT = { x: aR.x, y: a.y + WALL_HEIGHT, z: aR.z };
      const bLT = { x: bL.x, y: b.y + WALL_HEIGHT, z: bL.z };
      const bRT = { x: bR.x, y: b.y + WALL_HEIGHT, z: bR.z };

      quad(aL, bL, bLT, aLT, shell); // 左墙
      quad(aR, bR, bRT, aRT, shell); // 右墙
      quad(aLT, bLT, bRT, aRT, shell); // 顶

      guide(aL, bL, guides, 0.06);
      guide(aR, bR, guides, 0.06);
    }
  }

  if (shell.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(shell, 3));
    const material = new THREE.MeshBasicMaterial({
      color: FOG_COLOR,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'fog-shell';
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  if (guides.length > 0) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(guides, 3));
    const material = new THREE.LineBasicMaterial({
      color: GUIDE_COLOR,
      transparent: true,
      opacity: 0.55,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'fog-guides';
    group.add(lines);
  }

  return group;
}

function quad(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  c: { x: number; y: number; z: number },
  d: { x: number; y: number; z: number },
  out: number[],
): void {
  out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  out.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
}

function guide(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  out: number[],
  lift: number,
): void {
  out.push(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
}

/** 某个弧长是否落在迷雾隧道内（RoadNetwork 用来压暗路面）。 */
export function fogAt(layout: Layout, s: number): boolean {
  for (const tunnel of layout.fogTunnels) {
    if (s >= tunnel.startS && s <= tunnel.endS) return true;
  }
  return false;
}

export function disposeFogTunnels(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const material = obj.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    }
  });
}
