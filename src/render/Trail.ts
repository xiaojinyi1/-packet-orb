/**
 * 球体拖尾：additive ribbon，长度与宽度随速度增长，静止时自然收短。
 * 低画质档 / prefers-reduced-motion 时整体关闭（只保留球体发光）。
 */
import * as THREE from 'three';

const MAX_POINTS = 48;
const MIN_STEP = 0.2;

export class Trail {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly points: THREE.Vector3[] = [];
  private readonly lastRecorded = new THREE.Vector3();
  private readonly speeds: number[] = [];
  private enabled = true;
  private readonly colorA = new THREE.Color('#2ed3c6');
  private readonly colorB = new THREE.Color('#2ed3c6');
  private readonly colorC = new THREE.Color('#ff2e88');

  constructor() {
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_POINTS * 2 * 3);
    this.colors = new Float32Array(MAX_POINTS * 2 * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const index: number[] = [];
    for (let i = 0; i < MAX_POINTS - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      }),
    );
    this.mesh.name = 'orb-trail';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh.visible = on && this.points.length > 2;
    if (!on) this.clear();
  }

  reset(pos: THREE.Vector3): void {
    this.clear();
    this.points.push(pos.clone());
    this.speeds.push(0);
    this.lastRecorded.copy(pos);
  }

  clear(): void {
    this.points.length = 0;
    this.speeds.length = 0;
    this.mesh.visible = false;
  }

  /** 每帧调用：pos 为球心，speed 为当前速度。 */
  update(pos: THREE.Vector3, speed: number, dt: number): void {
    if (!this.enabled) return;
    const head = this.points[0];
    // 与"最后记录点"比较：若与上一帧比较，60fps 下每帧位移常常小于阈值，永远不采样。
    if (!head || this.lastRecorded.distanceTo(pos) > MIN_STEP) {
      this.points.unshift(pos.clone());
      this.speeds.unshift(speed);
      this.lastRecorded.copy(pos);
      if (this.points.length > MAX_POINTS) {
        this.points.length = MAX_POINTS;
        this.speeds.length = MAX_POINTS;
      }
    } else {
      head.copy(pos);
      this.speeds[0] = speed;
    }

    // 静止太久时逐步收缩
    if (speed < 0.6 && this.points.length > 4 && dt > 0) {
      if (Math.random() < 0.35) {
        this.points.pop();
        this.speeds.pop();
      }
    }

    const n = this.points.length;
    if (n < 3) {
      this.mesh.visible = false;
      return;
    }

    const speedRatio = Math.min(1, speed / 12);
    const width = 0.06 + 0.16 * speedRatio;
    const tmp = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (let i = 0; i < n; i += 1) {
      const p = this.points[i];
      const prev = this.points[Math.max(0, i - 1)];
      const next = this.points[Math.min(n - 1, i + 1)];
      dir.copy(prev).sub(next);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      side.crossVectors(dir, up).normalize();
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      tmp.copy(side).multiplyScalar(width * (1 - i / Math.max(1, n - 1)));

      const a = i * 6;
      this.positions[a] = p.x + tmp.x;
      this.positions[a + 1] = p.y + tmp.y;
      this.positions[a + 2] = p.z + tmp.z;
      this.positions[a + 3] = p.x - tmp.x;
      this.positions[a + 4] = p.y - tmp.y;
      this.positions[a + 5] = p.z - tmp.z;

      const fade = Math.pow(1 - i / (n - 1), 2.6) * (0.35 + 0.55 * speedRatio);
      const c = this.colorA
        .clone()
        .lerp(this.colorB, Math.min(1, speedRatio * 1.15))
        .lerp(this.colorC, Math.max(0, speedRatio - 0.75) * 2.2);
      for (let k = 0; k < 2; k += 1) {
        this.colors[a + k * 3] = c.r * fade;
        this.colors[a + k * 3 + 1] = c.g * fade;
        this.colors[a + k * 3 + 2] = c.b * fade;
      }
    }

    const geometry = this.mesh.geometry;
    geometry.setDrawRange(0, (n - 1) * 6);
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    geometry.computeBoundingSphere();
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** 雾隧道里的霓虹引导线呼吸：只改线材质，不重建几何。 */
export function pulseFogGuide(fogGroup: THREE.Object3D | null, time: number): void {
  if (!fogGroup) return;
  fogGroup.traverse((obj) => {
    if (!(obj instanceof THREE.LineSegments)) return;
    const mat = obj.material as THREE.LineBasicMaterial;
    mat.opacity = 0.42 + 0.32 * (0.5 + 0.5 * Math.sin(time * 2.4));
    mat.color.setHSL(0.47 + 0.02 * Math.sin(time * 1.7), 0.85, 0.62);
  });
}
