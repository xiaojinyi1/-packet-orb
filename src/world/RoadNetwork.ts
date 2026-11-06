/**
 * 把 LayoutSolver 的纯数据变成三份东西：
 *   1. 灰盒网格（road / wall / trampoline pad / 引导线）
 *   2. 烘焙后的静态碰撞体描述（trimesh + cuboid），交给 Worker 里的 rapier
 *   3. 触发区描述（蹦床）
 * 这里不做任何数据映射，映射只在 LayoutSolver。
 */
import * as THREE from 'three';
import { TERRAIN, sampleAtS, zoneAtS } from './LayoutSolver';
import { fogAt } from './FogTunnel';
import type { Layout, PathSample } from './LayoutSolver';
import type { ColliderSpec, ZoneSpec } from '../sim/protocol';
import { matcapMaterial } from '../render/MatcapMaterial';
import { palette } from '../render/Theme';

const colors = () => palette();

type V3 = { x: number; y: number; z: number };

const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const posOf = (p: PathSample): V3 => ({ x: p.x, y: p.y, z: p.z });
const sideOf = (p: PathSample): V3 => ({ x: p.sx, y: p.sy, z: p.sz });
const upOf = (p: PathSample): V3 => ({ x: p.ux, y: p.uy, z: p.uz });
const tangentOf = (p: PathSample): V3 => ({ x: p.tx, y: p.ty, z: p.tz });

interface SurfaceBuilder {
  positions: number[];
  colors: number[];
}

interface ColliderBuilder {
  vertices: number[];
  indices: number[];
}

function addTri(
  surface: SurfaceBuilder,
  collider: ColliderBuilder,
  a: V3,
  b: V3,
  c: V3,
  color: THREE.Color,
  refNormal: V3,
) {
  const n = cross(sub(b, a), sub(c, a));
  const flip = dot(n, refNormal) < 0;
  const t = flip ? [a, c, b] : [a, b, c];
  for (const v of t) {
    surface.positions.push(v.x, v.y, v.z);
    surface.colors.push(color.r, color.g, color.b);
    collider.vertices.push(v.x, v.y, v.z);
    collider.indices.push(collider.indices.length);
  }
}

/** 四边形 a→b→c→d 环绕；按参考法线自动纠正绕序。 */
function addQuad(
  surface: SurfaceBuilder,
  collider: ColliderBuilder,
  a: V3,
  b: V3,
  c: V3,
  d: V3,
  color: THREE.Color,
  refNormal: V3,
) {
  const n = cross(sub(b, a), sub(c, a));
  if (dot(n, refNormal) >= 0) {
    addTri(surface, collider, a, b, c, color, refNormal);
    addTri(surface, collider, a, c, d, color, refNormal);
  } else {
    addTri(surface, collider, a, d, c, color, refNormal);
    addTri(surface, collider, a, c, b, color, refNormal);
  }
}

function addVisualQuad(surface: SurfaceBuilder, a: V3, b: V3, c: V3, d: V3, color: THREE.Color): void {
  for (const v of [a, b, c, a, c, d]) {
    surface.positions.push(v.x, v.y, v.z);
    surface.colors.push(color.r, color.g, color.b);
  }
}

function surfaceColorAt(layout: Layout, sample: PathSample): THREE.Color {
  const span = layout.spans[sample.spanIndex];
  if (!span) return new THREE.Color(colors().road);
  if (span.kind === 'pit' && span.featureStartS !== null && span.featureEndS !== null) {
    if (sample.s >= span.featureStartS && sample.s <= span.featureEndS) return new THREE.Color(colors().pit);
  }
  if (span.kind === 'jump' && span.kickerStartS !== null && sample.s >= span.kickerStartS && sample.s <= span.sEnd) {
    return new THREE.Color(colors().ramp);
  }
  if (sample.landing) return new THREE.Color(colors().landing);
  // 迷雾隧道里路面压暗，只留引导线
  if (fogAt(layout, sample.s)) return new THREE.Color('#3a3358');
  // 分区（ASN / geo）整体换色：主路面轻微染色，不抢引导线的对比度
  const zone = zoneAtS(layout, sample.s);
  return new THREE.Color(colors().road).lerp(new THREE.Color(zone.color), 0.08);
}

export interface RoadBuild {
  group: THREE.Group;
  colliders: ColliderSpec[];
  zones: ZoneSpec[];
}

export function buildRoadNetwork(layout: Layout): RoadBuild {
  const group = new THREE.Group();
  group.name = 'packet-orb-road';
  const road: SurfaceBuilder = { positions: [], colors: [] };
  const wall: SurfaceBuilder = { positions: [], colors: [] };
  const stripe: SurfaceBuilder = { positions: [], colors: [] };
  const collider: ColliderBuilder = { vertices: [], indices: [] };
  const wallColor = new THREE.Color(colors().wall);
  const halfWidth = layout.width / 2;
  const wallHeight = TERRAIN.wallHeight;
  const wallThickness = 0.28;
  const down = { x: 0, y: -1, z: 0 };

  const samples = layout.samples;
  const pairs: [PathSample, PathSample][] = [];
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a.gap || b.gap) continue;
    pairs.push([a, b]);
  }

  for (const [a, b] of pairs) {
    const pa = posOf(a);
    const pb = posOf(b);
    const sa = sideOf(a);
    const sb = sideOf(b);
    const ua = upOf(a);
    const ub = upOf(b);
    const color = surfaceColorAt(layout, a);
    const refUp = norm(add(ua, ub));

    // 路面
    addQuad(
      road,
      collider,
      add(pa, scale(sa, -halfWidth)),
      add(pa, scale(sa, halfWidth)),
      add(pb, scale(sb, halfWidth)),
      add(pb, scale(sb, -halfWidth)),
      color,
      refUp,
    );

    // 分区色边条：ASN / geo 切换时路肩颜色整体变，是玩家感知“换关卡”的第一信号
    if (!fogAt(layout, a.s)) {
      const zoneColor = new THREE.Color(zoneAtS(layout, a.s).color);
      const lift = scale(refUp, 0.055);
      const inner = halfWidth - 0.62;
      const outer = halfWidth - 0.1;
      for (const sign of [-1, 1] as const) {
        addVisualQuad(
          stripe,
          add(add(pa, scale(sa, sign * inner)), lift),
          add(add(pb, scale(sb, sign * inner)), lift),
          add(add(pb, scale(sb, sign * outer)), lift),
          add(add(pa, scale(sa, sign * outer)), lift),
          zoneColor,
        );
      }
    }

    // 两侧护栏（内侧立面 + 顶面）；碰撞体同样吃这份 trimesh
    for (const sign of [-1, 1] as const) {
      const inward = scale(sa, -sign);
      const edgeA = add(pa, scale(sa, sign * halfWidth));
      const edgeB = add(pb, scale(sb, sign * halfWidth));
      const topA = add(edgeA, scale(ua, wallHeight));
      const topB = add(edgeB, scale(ub, wallHeight));
      const outA = add(edgeA, scale(sa, sign * wallThickness));
      const outB = add(edgeB, scale(sb, sign * wallThickness));
      const outTopA = add(outA, scale(ua, wallHeight));
      const outTopB = add(outB, scale(ub, wallHeight));

      addQuad(wall, collider, edgeA, edgeB, topB, topA, wallColor, inward);
      addQuad(wall, collider, topA, topB, outTopB, outTopA, wallColor, refUp);
      // 外侧垂面（视觉封闭，同时挡住从落差处侧向钻入）
      addQuad(
        wall,
        collider,
        outTopA,
        outTopB,
        add(outB, scale(down, 0.9)),
        add(outA, scale(down, 0.9)),
        wallColor,
        scale(sa, sign),
      );
    }
  }

  // 起点 / 终点封口墙：灰盒阶段防止球直接滚出世界
  const ends: [PathSample, V3][] = [
    [samples[0], scale(tangentOf(samples[0]), -1)],
    [samples[samples.length - 1], tangentOf(samples[samples.length - 1])],
  ];
  for (const [p, ref] of ends) {
    const base = posOf(p);
    const side = sideOf(p);
    const up = upOf(p);
    const left = add(base, scale(side, -halfWidth));
    const right = add(base, scale(side, halfWidth));
    addQuad(
      wall,
      collider,
      left,
      right,
      add(right, scale(up, 2.2)),
      add(left, scale(up, 2.2)),
      wallColor,
      ref,
    );
  }

  const roadMaterial = matcapMaterial(3, { color: '#cfc9bb', vertexColors: true, side: THREE.DoubleSide });
  const roadGeometry = new THREE.BufferGeometry();
  roadGeometry.setAttribute('position', new THREE.Float32BufferAttribute(road.positions, 3));
  roadGeometry.setAttribute('color', new THREE.Float32BufferAttribute(road.colors, 3));
  roadGeometry.computeVertexNormals();
  const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
  roadMesh.name = 'road-surface';
  roadMesh.receiveShadow = false;
  group.add(roadMesh);

  // matcap 不吃实时光照，阴影用一层同几何的 ShadowMaterial 收在路面上。
  const roadShadowMat = new THREE.ShadowMaterial({ color: '#000000', opacity: 0.45 });
  roadShadowMat.polygonOffset = true;
  roadShadowMat.polygonOffsetFactor = -2;
  roadShadowMat.polygonOffsetUnits = -2;
  const roadShadow = new THREE.Mesh(roadGeometry, roadShadowMat);
  roadShadow.name = 'road-shadow';
  roadShadow.receiveShadow = true;
  roadShadow.renderOrder = 2;
  group.add(roadShadow);

  const wallMaterial = matcapMaterial(1, { color: colors().wall, vertexColors: true, side: THREE.DoubleSide });
  const wallGeometry = new THREE.BufferGeometry();
  wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wall.positions, 3));
  wallGeometry.setAttribute('color', new THREE.Float32BufferAttribute(wall.colors, 3));
  wallGeometry.computeVertexNormals();
  const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
  wallMesh.name = 'road-wall';
  wallMesh.receiveShadow = false;
  group.add(wallMesh);

  const stripeGeometry = new THREE.BufferGeometry();
  stripeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(stripe.positions, 3));
  stripeGeometry.setAttribute('color', new THREE.Float32BufferAttribute(stripe.colors, 3));
  stripeGeometry.computeVertexNormals();
  const stripeMesh = new THREE.Mesh(
    stripeGeometry,
    matcapMaterial(3, { vertexColors: true, side: THREE.DoubleSide, polygonOffset: true }),
  );
  stripeMesh.name = 'zone-stripes';
  stripeMesh.receiveShadow = false;
  group.add(stripeMesh);

  // 引导线：主干路永远有霓虹引导线，颜色随分区切换；雾里强制青色
  const guidePoints: number[] = [];
  const guideColors: number[] = [];
  for (const [a, b] of pairs) {
    const color = fogAt(layout, a.s) ? new THREE.Color(colors().guide) : new THREE.Color(zoneAtS(layout, a.s).color);
    const pa = add(posOf(a), scale(upOf(a), 0.045));
    const pb = add(posOf(b), scale(upOf(b), 0.045));
    guidePoints.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
    guideColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
  const guideGeometry = new THREE.BufferGeometry();
  guideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(guidePoints, 3));
  guideGeometry.setAttribute('color', new THREE.Float32BufferAttribute(guideColors, 3));
  const guide = new THREE.LineSegments(
    guideGeometry,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62 }),
  );
  guide.name = 'road-guide';
  group.add(guide);

  const colliders: ColliderSpec[] = [];
  if (collider.vertices.length > 0) {
    colliders.push({
      kind: 'trimesh',
      vertices: new Float32Array(collider.vertices),
      indices: new Uint32Array(collider.indices),
      friction: 0.9,
      restitution: 0.1,
    });
  }

  // 蹦床：路面之上的一块弹性板（独立 cuboid，restitution 0.88，combine=Max）
  const zones: ZoneSpec[] = [];
  for (const feature of layout.features) {
    if (feature.kind !== 'trampoline') continue;
    const centerSample = sampleAtS(samples, (feature.startS + feature.endS) / 2);
    if (!centerSample) continue;
    const startSample = sampleAtS(samples, feature.startS);
    const endSample = sampleAtS(samples, feature.endS);
    if (!startSample || !endSample) continue;
    const padLength = Math.max(2, feature.endS - feature.startS);
    const padWidth = layout.width * TERRAIN.trampolineWidthRatio;
    const tangent = norm(sub(posOf(endSample), posOf(startSample)));
    const side = norm(sideOf(centerSample));
    const up = norm(upOf(centerSample));
    // 顶面与路面齐平（中心下沉半个板厚），否则球的球心会撞上板的立边，
    // 水平速度被瞬间吃掉，看起来像“蹦床前急刹车”。
    const center = add(posOf(centerSample), scale(up, -0.06));
    // 视觉上抬 2cm：与路面共面会 z-fighting；碰撞体仍保持顶面齐平。
    const visualCenter = add(center, scale(up, 0.02));
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(side.x, side.y, side.z),
      new THREE.Vector3(up.x, up.y, up.z),
      new THREE.Vector3(tangent.x, tangent.y, tangent.z),
    );
    const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
    const padMesh = new THREE.Mesh(
      new THREE.BoxGeometry(padWidth, 0.12, padLength),
      matcapMaterial(2, { color: colors().trampoline }),
    );
    padMesh.name = 'trampoline-pad';
    padMesh.position.set(visualCenter.x, visualCenter.y, visualCenter.z);
    padMesh.quaternion.copy(quat);
    padMesh.castShadow = false;
    padMesh.receiveShadow = true;
    group.add(padMesh);

    colliders.push({
      kind: 'cuboid',
      halfExtents: [padWidth / 2, 0.06, padLength / 2],
      position: [center.x, center.y, center.z],
      rotation: [quat.x, quat.y, quat.z, quat.w],
      friction: 0.6,
      restitution: 0.88,
    });
    zones.push({
      kind: 'trampoline',
      center: { x: center.x, y: center.y, z: center.z },
      tangent,
      side,
      halfLength: padLength / 2,
      halfWidth: padWidth / 2,
    });
  }

  return { group, colliders, zones };
}

export function disposeRoadNetwork(build: RoadBuild): void {
  build.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const material = obj.material;
      const mats = Array.isArray(material) ? material : [material];
      mats.forEach((m) => {
        // 共享 matcap 材质由 MatcapMaterial 统一管理，重建世界时不能释放。
        if (!m.userData.poShared) m.dispose();
      });
    }
  });
}
