/**
 * 文字图集：把 ttl / rtt / loss / IP / 城市名预烘焙进一张 2048² 纹理，
 * 再合并成一个 draw call 的地面涂装 + 路牌网格。
 * 不引入任何运行时字体库；所有字形来自系统等宽/无衬线字体，截图即资产。
 */
import * as THREE from 'three';
import { palette } from './Theme';
import { sampleAtS } from '../world/LayoutSolver';
import type { Layout } from '../world/LayoutSolver';

const ATLAS = 2048;
const CELL_W = 512;
const CELL_H = 256;
const COLS = ATLAS / CELL_W;
const ROWS = ATLAS / CELL_H;

interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace';

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface TextAtlasBuild {
  mesh: THREE.Group;
  texture: THREE.Texture;
  dispose: () => void;
}

/**
 * 生成地面涂装与路牌。
 * 每个可达跳一块地面涂装（3 行：TTL+城市 / IP / RTT+LOSS），
 * 并在同一位置的路肩立一块路牌，内容与地面一致（取前两行）。
 */
export function buildTextAtlas(layout: Layout, trace: { hops: { ttl: number; avgMs: number | null; lossPct: number; addresses: string[]; anonymous: boolean }[] }): TextAtlasBuild {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS;
  canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('文字图集：无法创建 2D canvas');
  const p = palette();

  ctx.clearRect(0, 0, ATLAS, ATLAS);
  ctx.textBaseline = 'top';

  const rects: Rect[] = [];
  const nodes = layout.nodes;

  nodes.forEach((node, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS) % ROWS;
    const x = col * CELL_W;
    const y = row * CELL_H;
    const hop = trace.hops.find((h) => h.ttl === node.ttl);
    const rtt = hop?.avgMs ?? null;
    const loss = hop?.lossPct ?? 0;
    const city = node.geo ? node.geo.split('/').slice(-1)[0] : node.as ?? '';
    const ip = node.addresses[0] ?? (node.anonymous ? '* * *' : '—');

    // 透明底 + 深色描边：地面是奶油灰，路牌是暗色，两边都能读。
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(13,10,26,0.92)';
    ctx.lineWidth = 10;

    ctx.font = `700 64px ${MONO}`;
    ctx.fillStyle = p.ink;
    const line1 = `T${node.ttl}${city ? `  ${trim(city, 9)}` : ''}`;
    ctx.strokeText(line1, x + 24, y + 24);
    ctx.fillText(line1, x + 24, y + 24);

    ctx.font = `500 40px ${MONO}`;
    ctx.fillStyle = p.inkDim;
    const line2 = trim(ip, 18);
    ctx.strokeText(line2, x + 24, y + 104);
    ctx.fillText(line2, x + 24, y + 104);

    ctx.font = `700 38px ${MONO}`;
    ctx.fillStyle = loss > 0 ? p.danger : p.guide;
    const rttText = rtt === null ? '—' : `${rtt.toFixed(1)} ms`;
    const line3 = `${rttText}${loss > 0 ? `  LOSS ${loss.toFixed(0)}%` : ''}`;
    ctx.strokeText(line3, x + 24, y + 164);
    ctx.fillText(line3, x + 24, y + 164);

    rects.push({
      u0: (x + 6) / ATLAS,
      v0: 1 - (y + CELL_H - 6) / ATLAS,
      u1: (x + CELL_W - 6) / ATLAS,
      v1: 1 - (y + 6) / ATLAS,
    });
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'packet-orb-text';

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vCount = 0;

  const quad = (
    corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
    rect: Rect,
  ): void => {
    for (const c of corners) positions.push(c.x, c.y, c.z);
    uvs.push(rect.u1, rect.v0, rect.u0, rect.v0, rect.u0, rect.v1, rect.u1, rect.v1);
    indices.push(vCount, vCount + 1, vCount + 2, vCount, vCount + 2, vCount + 3);
    vCount += 4;
  };

  nodes.forEach((node, i) => {
    const rect = rects[i];
    if (!rect) return;
    const s = Math.min(layout.totalLength - 1, node.s + 3.2);
    const at = sampleAtS(layout.samples, s);
    if (!at) return;

    const side = new THREE.Vector3(at.sx, 0, at.sz);
    const tangent = new THREE.Vector3(at.tx, 0, at.tz);
    const center = new THREE.Vector3(at.x + at.ux * 0.02, at.y + at.ux * 0.02, at.z + at.uz * 0.02);
    center.y = at.y + 0.02;
    const halfW = 4.2;
    const halfL = 2.1;

    // 地面涂装：法线朝上，沿路径方向铺
    quad(
      [
        center.clone().addScaledVector(side, -halfW).addScaledVector(tangent, -halfL),
        center.clone().addScaledVector(side, halfW).addScaledVector(tangent, -halfL),
        center.clone().addScaledVector(side, halfW).addScaledVector(tangent, halfL),
        center.clone().addScaledVector(side, -halfW).addScaledVector(tangent, halfL),
      ],
      rect,
    );

    // 路牌：立在右侧路肩，面向来车
    const signAt = sampleAtS(layout.samples, Math.max(0, node.s - 0.8));
    if (!signAt) return;
    const sw = new THREE.Vector3(signAt.sx, 0, signAt.sz);
    const st = new THREE.Vector3(signAt.tx, 0, signAt.tz);
    const sc = new THREE.Vector3(signAt.x, signAt.y, signAt.z)
      .addScaledVector(sw, 5.15)
      .addScaledVector(st, -0.2);
    sc.y += 1.75;
    const facing = st.clone().negate();
    // 路牌用同一行字体，但只取上半格（TTL + IP），看起来更像标牌
    const signRect: Rect = {
      u0: rect.u0,
      v0: rect.v1 - (rect.v1 - rect.v0) * 0.62,
      u1: rect.u1,
      v1: rect.v1,
    };
    quad(
      [
        sc.clone().addScaledVector(sw, -2.3).addScaledVector(facing, 0),
        sc.clone().addScaledVector(sw, 2.3),
        sc.clone().addScaledVector(sw, 2.3).addScaledVector(new THREE.Vector3(0, 1.5, 0), 1),
        sc.clone().addScaledVector(sw, -2.3).addScaledVector(new THREE.Vector3(0, 1.5, 0), 1),
      ],
      signRect,
    );
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'text-atlas';
  mesh.renderOrder = 4;
  group.add(mesh);

  const postGeo = new THREE.BoxGeometry(0.09, 1.55, 0.09);
  const postMat = new THREE.MeshMatcapMaterial({ color: p.wall, flatShading: true });
  const posts = new THREE.InstancedMesh(postGeo, postMat, Math.max(1, nodes.length));
  posts.name = 'sign-posts';
  const m = new THREE.Matrix4();
  nodes.forEach((node, i) => {
    const at = sampleAtS(layout.samples, Math.max(0, node.s - 0.8));
    if (!at) return;
    const pos = new THREE.Vector3(at.x, at.y, at.z)
      .addScaledVector(new THREE.Vector3(at.sx, 0, at.sz), 5.15)
      .addScaledVector(new THREE.Vector3(0, 1, 0), 0.75);
    m.makeTranslation(pos.x, pos.y, pos.z);
    posts.setMatrixAt(i, m);
  });
  posts.instanceMatrix.needsUpdate = true;
  posts.castShadow = true;
  group.add(posts);

  return {
    mesh: group,
    texture,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      postGeo.dispose();
      postMat.dispose();
      posts.dispose();
      texture.dispose();
    },
  };
}
