/**
 * 粒子：碰撞烟尘 / 落地尘 / 终点礼花。
 * 池化 Points，additive，颜色按材质语义（路面米白、霓虹青、危险品红）。
 * Low 档与 prefers-reduced-motion 下停用。
 */
import * as THREE from 'three';

const MAX = 220;

/** 圆形软点贴图：没有它 PointsMaterial 会画成硬方块。 */
function softDotTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  color: THREE.Color;
  size: number;
}

export class Particles {
  readonly points: THREE.Points;
  private readonly pool: Particle[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private enabled = true;
  private readonly tmpColor = new THREE.Color();

  constructor() {
    this.positions = new Float32Array(MAX * 3);
    this.colors = new Float32Array(MAX * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      map: softDotTexture(),
      size: 0.22,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.name = 'orb-particles';
    this.points.frustumCulled = false;
    this.points.visible = false;
    for (let i = 0; i < MAX; i += 1) {
      this.pool.push({
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
        color: new THREE.Color(),
        size: 1,
      });
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.points.visible = on && this.alive > 0;
  }

  private alive = 0;

  emit(pos: THREE.Vector3, count: number, color: string, speed = 4.2, life = 0.65): void {
    if (!this.enabled) return;
    this.tmpColor.set(color);
    let spawned = 0;
    for (const particle of this.pool) {
      if (particle.life > 0) continue;
      particle.pos.copy(pos);
      particle.pos.y += 0.35;
      const a = Math.random() * Math.PI * 2;
      const up = 0.55 + Math.random() * 0.9;
      const r = 0.25 + Math.random() * 0.55;
      particle.vel.set(Math.cos(a) * r * speed, up * speed * 0.55, Math.sin(a) * r * speed);
      particle.maxLife = life * (0.7 + Math.random() * 0.6);
      particle.life = particle.maxLife;
      particle.color.copy(this.tmpColor);
      spawned += 1;
      if (spawned >= count) break;
    }
  }

  burstImpact(pos: THREE.Vector3, impact: number, material: 'road' | 'wall' | 'trampoline'): void {
    const color = material === 'trampoline' ? '#ff2e88' : material === 'wall' ? '#8f86ff' : '#d9d2c5';
    this.emit(pos, 8 + Math.round(impact * 14), color, 3.4 + impact * 2.4, 0.5 + impact * 0.3);
  }

  update(dt: number): void {
    if (!this.enabled) return;
    let alive = 0;
    for (let i = 0; i < this.pool.length; i += 1) {
      const p = this.pool[i];
      if (p.life <= 0) {
        this.positions[i * 3 + 1] = -999;
        continue;
      }
      p.life -= dt;
      p.vel.y -= 9.2 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const t = Math.max(0, p.life / p.maxLife);
      const a = i * 3;
      this.positions[a] = p.pos.x;
      this.positions[a + 1] = p.pos.y;
      this.positions[a + 2] = p.pos.z;
      this.colors[a] = p.color.r * t;
      this.colors[a + 1] = p.color.g * t;
      this.colors[a + 2] = p.color.b * t;
      alive += 1;
    }
    this.alive = alive;
    const geometry = this.points.geometry;
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = alive > 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
