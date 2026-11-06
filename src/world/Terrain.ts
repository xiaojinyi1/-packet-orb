/**
 * 灰盒地面：整块 low-poly 基座 + 暗色网格。
 * 不参与碰撞（球只在路网内活动，掉出路面由 fallY 兜底），
 * 也不做地形起伏——起伏全部由 LayoutSolver 的折线决定。
 */
import * as THREE from 'three';
import type { Layout } from './LayoutSolver';
import { matcapMaterial } from '../render/MatcapMaterial';
import { palette } from '../render/Theme';

export function buildTerrain(layout: Layout): THREE.Group {
  const group = new THREE.Group();
  group.name = 'packet-orb-terrain';

  const baseY = layout.minY - 8;
  const p = palette();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(900, 900, 1, 1), matcapMaterial(0, { color: p.ground }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(0, baseY, Math.max(0, layout.totalLength / 2));
  plane.receiveShadow = true;
  plane.name = 'terrain-base';
  plane.receiveShadow = false;
  group.add(plane);

  // 远景 AO：一层带径向渐变的暗色贴片压在大地上，代替实时环境光遮蔽
  const aoCanvas = document.createElement('canvas');
  aoCanvas.width = 256;
  aoCanvas.height = 256;
  const actx = aoCanvas.getContext('2d');
  if (actx) {
    const g = actx.createRadialGradient(128, 128, 20, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,0.30)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    actx.fillStyle = g;
    actx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(aoCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const ao = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    ao.rotation.x = -Math.PI / 2;
    ao.position.set(0, baseY + 0.03, Math.max(0, layout.totalLength / 2));
    ao.name = 'terrain-ao';
    ao.userData.ownTexture = tex;
    group.add(ao);
  }

  const shadowMat = new THREE.ShadowMaterial({ color: '#000000', opacity: 0.4 });
  shadowMat.polygonOffset = true;
  shadowMat.polygonOffsetFactor = -2;
  shadowMat.polygonOffsetUnits = -2;
  const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), shadowMat);
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.set(0, baseY + 0.04, Math.max(0, layout.totalLength / 2));
  shadowCatcher.receiveShadow = true;
  shadowCatcher.name = 'terrain-shadow';
  group.add(shadowCatcher);

  const grid = new THREE.GridHelper(900, 60, p.gridMajor, p.grid);
  grid.position.set(0, baseY + 0.02, Math.max(0, layout.totalLength / 2));
  grid.name = 'terrain-grid';
  group.add(grid);

  return group;
}

export function disposeTerrain(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.GridHelper || obj instanceof THREE.LineSegments) {
      obj.geometry.dispose();
      const own = obj.userData.ownTexture as THREE.Texture | undefined;
      own?.dispose();
      const material = obj.material;
      const mats = Array.isArray(material) ? material : [material];
      mats.forEach((m) => {
        // 共享 matcap 材质由 MatcapMaterial 统一管理，重建世界时不能释放。
        if (!m.userData.poShared) m.dispose();
      });
    }
  });
}
