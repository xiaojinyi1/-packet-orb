/**
 * 电影化镜头：到站慢镜环绕、跨洋隧道出口拉升。
 * 到站环绕自己接管相机（期间主循环跳过 FollowRig），结束后交还；
 * 隧道出口只向 FollowRig 叠一个短促的上抬脉冲，避免两个系统抢相机。
 */
import * as THREE from 'three';
import gsap from 'gsap';
import { sampleAtS } from '../world/LayoutSolver';
import type { Layout } from '../world/LayoutSolver';

export class Cinematic {
  busy = false;
  reducedMotion = false;

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  /**
   * 到站演出：镜头从追尾位抬起并绕终点 100°，配合结算面板。
   * prefers-reduced-motion 时直接回调，不演出。
   */
  playArrival(layout: Layout, onDone: () => void): void {
    if (this.busy) return;
    if (this.reducedMotion) {
      onDone();
      return;
    }
    const end = sampleAtS(layout.samples, Math.max(0, layout.totalLength - 4));
    if (!end) {
      onDone();
      return;
    }
    const focus = new THREE.Vector3(end.x, end.y + 1.1, end.z);
    const startPos = this.camera.position.clone();
    const startAngle = Math.atan2(startPos.z - focus.z, startPos.x - focus.x);
    const startY = startPos.y;
    const state = { t: 0 };
    this.busy = true;
    const fov0 = this.camera.fov;

    gsap.to(state, {
      t: 1,
      duration: 2.4,
      ease: 'power2.inOut',
      onUpdate: () => {
        const t = state.t;
        const angle = startAngle + t * 1.45;
        const radius = 8.4 - t * 1.2;
        this.camera.position.set(
          focus.x + Math.cos(angle) * radius,
          startY + (focus.y + 5.2 - startY) * t,
          focus.z + Math.sin(angle) * radius,
        );
        this.camera.lookAt(focus.x, focus.y - 0.2, focus.z);
        this.camera.fov = fov0 - 3 * Math.sin(t * Math.PI);
        this.camera.updateProjectionMatrix();
      },
      onComplete: () => {
        this.busy = false;
        this.camera.fov = fov0;
        this.camera.updateProjectionMatrix();
        onDone();
      },
    });
  }

  /**
   * 彩蛋「反向播放」：镜头沿主干道从终点倒着飞回起点。
   * 纯镜头演出，不触碰物理状态。
   */
  playRewind(layout: Layout, onDone: () => void): void {
    if (this.busy) return;
    const end = sampleAtS(layout.samples, layout.totalLength - 2);
    if (!end) {
      onDone();
      return;
    }
    const state = { t: 1 };
    this.busy = true;
    const look = new THREE.Vector3();
    gsap.to(state, {
      t: 0,
      duration: this.reducedMotion ? 0.01 : 3.4,
      ease: 'power1.inOut',
      onUpdate: () => {
        const s = layout.totalLength * state.t;
        const at = sampleAtS(layout.samples, Math.max(0, s));
        if (!at) return;
        const forward = new THREE.Vector3(at.tx, 0, at.tz);
        this.camera.position.set(
          at.x - forward.x * 7 + at.sx * 1.2,
          at.y + 3.6,
          at.z - forward.z * 7 + at.sz * 1.2,
        );
        look.set(at.x + forward.x * 3.5, at.y + 1.2, at.z + forward.z * 3.5);
        this.camera.lookAt(look);
      },
      onComplete: () => {
        this.busy = false;
        onDone();
      },
    });
  }

  /** 到站前最后一帧的追尾相机位置，供结算关闭后复位使用。 */
  cancel(): void {
    this.busy = false;
    gsap.killTweensOf(this.camera.position);
  }
}
