/**
 * 语义道具：ASN 关卡的拱门、终点门、家园区小屋。
 * 拱门按分区实例化（柱 + 梁各一个 InstancedMesh）；
 * 终点门是唯一允许 emissive 的地标（另一处是 Packet Orb 本体）。
 */
import * as THREE from 'three';
import { matcapMaterial } from '../render/MatcapMaterial';
import { palette } from '../render/Theme';
import { sampleAtS, type Layout } from './LayoutSolver';

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

export function buildProps(layout: Layout): THREE.Group {
  const group = new THREE.Group();
  group.name = 'packet-orb-props';

  buildGates(layout, group);
  buildFinishDoor(layout, group);
  buildHomeCluster(layout, group);

  return group;
}

/** 分区边界拱门：两根柱 + 一根梁，颜色取新分区的主题色。 */
function buildGates(layout: Layout, group: THREE.Group): void {
  const gates = layout.zones.slice(1).flatMap((zone) => {
    const sample = sampleAtS(layout.samples, zone.startS);
    return sample ? [{ zone, sample }] : [];
  });
  if (gates.length === 0) return;

  const pillarGeo = new THREE.BoxGeometry(0.7, 1, 0.7);
  const beamGeo = new THREE.BoxGeometry(1, 0.55, 1);
  const material = matcapMaterial(1, { color: '#ffffff' });

  const pillars = new THREE.InstancedMesh(pillarGeo, material, gates.length * 2);
  const beams = new THREE.InstancedMesh(beamGeo, material, gates.length);
  pillars.name = 'zone-gate-pillars';
  beams.name = 'zone-gate-beams';
  pillars.castShadow = true;
  beams.castShadow = true;

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  gates.forEach(({ zone, sample }, i) => {
    const color = new THREE.Color(zone.color);
    const span = layout.width / 2 + 1.4;
    const height = 6.4;
    const rot = Math.atan2(sample.tx, sample.tz);
    quat.setFromAxisAngle(yAxis, rot);

    for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
      const sign = sideIdx === 0 ? -1 : 1;
      pos.set(sample.x + sample.sx * span * sign, sample.y + height / 2, sample.z + sample.sz * span * sign);
      scale.set(1, height, 1);
      matrix.compose(pos, quat, scale);
      pillars.setMatrixAt(i * 2 + sideIdx, matrix);
      pillars.setColorAt(i * 2 + sideIdx, color);
    }

    pos.set(sample.x, sample.y + height + 0.28, sample.z);
    scale.set(span * 2 + 0.7, 1, 1);
    matrix.compose(pos, quat, scale);
    beams.setMatrixAt(i, matrix);
    beams.setColorAt(i, color);
  });

  pillars.instanceMatrix.needsUpdate = true;
  beams.instanceMatrix.needsUpdate = true;
  if (pillars.instanceColor) pillars.instanceColor.needsUpdate = true;
  if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
  group.add(pillars, beams);
}

/** 终点门：柠檬黄 emissive 门框 + 地面光带。 */
function buildFinishDoor(layout: Layout, group: THREE.Group): void {
  const sample = sampleAtS(layout.samples, Math.max(0, layout.totalLength - 2.5));
  if (!sample) return;

  const finish = palette().finish;
  // matcap 本身不参与光照；门框用高亮柠檬黄配合 bloom 产生“发光”观感。
  const frameMat = matcapMaterial(2, { color: finish });
  const gate = new THREE.Group();
  gate.name = 'finish-gate';
  gate.position.set(sample.x, sample.y, sample.z);
  gate.rotation.y = Math.atan2(sample.tx, sample.tz);

  const post = new THREE.BoxGeometry(0.55, 7.2, 0.55);
  const left = new THREE.Mesh(post, frameMat);
  left.position.set(-5.2, 3.6, 0);
  const right = new THREE.Mesh(post, frameMat);
  right.position.set(5.2, 3.6, 0);
  const beam = new THREE.Mesh(new THREE.BoxGeometry(11, 0.7, 0.7), frameMat);
  beam.position.set(0, 7.2, 0);
  gate.add(left, right, beam);

  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(10.4, 1.6),
    new THREE.MeshBasicMaterial({
      color: finish,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  strip.rotation.x = -Math.PI / 2;
  strip.position.y = 0.04;
  gate.add(strip);
  group.add(gate);
}

/** 家园区（私网跳）小屋：起点左侧一小簇，纯体块 + 四棱锥屋顶。 */
function buildHomeCluster(layout: Layout, group: THREE.Group): void {
  const rand = mulberry32(7);
  const home = new THREE.Group();
  home.name = 'home-cluster';
  const homePalette = ['#ff7a45', '#2ed3c6', '#ffe447'];
  const wallMat = matcapMaterial(0, { color: palette().road });

  // 盆地底面很低：先给家园区垫一块台地，小屋才不会悬在半空。
  // 台地只放在路外侧（偏移 11.5m、宽 7m），顶面比路面低 0.3m，避免与路面共面闪烁。
  const mid = sampleAtS(layout.samples, 11);
  if (mid) {
    const baseY = layout.minY - 7.6;
    const topY = mid.y - 0.3;
    const padH = Math.max(0.8, topY - baseY);
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(7, padH, 14),
      matcapMaterial(1, { color: palette().wall }),
    );
    pad.position.set(
      mid.x - mid.sx * 11.5,
      baseY + padH / 2,
      mid.z - mid.sz * 11.5,
    );
    pad.rotation.y = Math.atan2(mid.tx, mid.tz);
    pad.receiveShadow = true;
    home.add(pad);
  }

  for (let i = 0; i < 3; i += 1) {
    const s = 6 + i * 5;
    const sample = sampleAtS(layout.samples, s);
    if (!sample) continue;
    const offset = 8.5 + rand() * 2.2;
    const x = sample.x - sample.sx * offset;
    const z = sample.z - sample.sz * offset;
    const w = 3.4 + rand() * 1.4;
    const d = 3.2 + rand() * 1.2;
    const h = 2.6 + rand() * 0.8;

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    body.position.set(x, sample.y + h / 2, z);
    body.castShadow = true;
    body.receiveShadow = true;

    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(w, d) * 0.78, 1.7, 4),
      matcapMaterial(2, { color: homePalette[i % homePalette.length] }),
    );
    roof.rotation.y = Math.PI / 4;
    roof.position.set(x, sample.y + h + 0.85, z);
    roof.castShadow = true;
    home.add(body, roof);
  }
  group.add(home);
}

export function disposeProps(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.InstancedMesh) {
      obj.geometry.dispose();
      const material = obj.material;
      const mats = Array.isArray(material) ? material : [material];
      mats.forEach((m) => {
        // 共享 matcap 材质由 MatcapMaterial 统一管理，重建世界时不能释放。
        if (!m.userData.poShared) m.dispose();
      });
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
    }
  });
}
