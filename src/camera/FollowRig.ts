/**
 * 追尾镜头：位置阻尼滞后 0.18s，注视点 = 球前方 4 单位，
 * FOV 随速度 65→78，落地瞬间收紧 FOV 并下压。
 */
import * as THREE from 'three';

export interface FollowParams {
  /** 位置阻尼时间常数，秒。 */
  lag: number;
  /** 注视点前移距离。 */
  lookAhead: number;
  fovBase: number;
  fovMax: number;
  distance: number;
  height: number;
  /** 注视点相对球心的抬升，避免球贴画面底缘。 */
  lookHeight: number;
}

export const DEFAULT_FOLLOW: FollowParams = {
  lag: 0.18,
  lookAhead: 4,
  fovBase: 65,
  fovMax: 78,
  distance: 6.4,
  height: 2.6,
  lookHeight: 0.8,
};

const UP = new THREE.Vector3(0, 1, 0);
const TMP_DESIRED = new THREE.Vector3();
const TMP_LOOK = new THREE.Vector3();
const TMP_FORWARD = new THREE.Vector3();

export class FollowRig {
  readonly camera: THREE.PerspectiveCamera;
  params: FollowParams;
  private cameraPos = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private fov = DEFAULT_FOLLOW.fovBase;
  private impactPulse = 0;
  /** 出隧道拉升脉冲（0..1），会同时抬高镜头并轻微拉宽 FOV。 */
  private liftPulse = 0;
  /** 轨道投递 / 到站演出模式：镜头略高略远、注视点更远。 */
  cinematic = false;
  private initialized = false;
  /** 平滑后的镜头朝向（水平），给输入映射用。 */
  readonly flatForward = new THREE.Vector3(0, 0, 1);

  constructor(camera: THREE.PerspectiveCamera, params: FollowParams = DEFAULT_FOLLOW) {
    this.camera = camera;
    this.params = { ...params };
    this.camera.fov = params.fovBase;
  }

  reset(target: THREE.Vector3, forward: THREE.Vector3): void {
    this.impactPulse = 0;
    this.liftPulse = 0;
    this.fov = this.params.fovBase;
    this.computeDesired(target, forward, TMP_DESIRED);
    this.cameraPos.copy(TMP_DESIRED);
    TMP_LOOK.copy(target).addScaledVector(forward, this.params.lookAhead);
    TMP_LOOK.y += this.params.lookHeight;
    this.lookAt.copy(TMP_LOOK);
    this.initialized = true;
    this.applyToCamera();
  }

  /** 隧道出口等场景的镜头拉升脉冲，0..1。 */
  pulseLift(amount = 1): void {
    this.liftPulse = Math.max(this.liftPulse, Math.min(1, Math.max(0, amount)));
  }

  private get cinematicLift(): number {
    return this.cinematic ? 1 : 0;
  }

  private computeDesired(target: THREE.Vector3, forward: THREE.Vector3, out: THREE.Vector3): void {
    TMP_FORWARD.copy(forward);
    TMP_FORWARD.y = 0;
    if (TMP_FORWARD.lengthSq() < 1e-6) TMP_FORWARD.set(0, 0, 1);
    TMP_FORWARD.normalize();
    const distance = this.params.distance + this.cinematicLift * 1.4 + this.liftPulse * 1.6;
    const height = this.params.height + this.cinematicLift * 1.1 + this.liftPulse * 2.4;
    out.copy(target)
      .addScaledVector(TMP_FORWARD, -distance)
      .addScaledVector(UP, height);
    // 落地瞬间镜头整体下压
    out.y -= this.impactPulse * 0.45;
    // 不允许镜头钻到球下面
    out.y = Math.max(out.y, target.y + 1.05);
  }

  update(
    dt: number,
    target: THREE.Vector3,
    forward: THREE.Vector3,
    speed: number,
    maxSpeed: number,
    impact: number,
  ): void {
    if (impact > 0.02) this.impactPulse = Math.max(this.impactPulse, Math.min(1, impact));
    this.impactPulse *= Math.exp(-dt * 5.5);
    if (this.impactPulse < 0.001) this.impactPulse = 0;
    this.liftPulse *= Math.exp(-dt * 1.35);
    if (this.liftPulse < 0.001) this.liftPulse = 0;
    const lookAhead = this.params.lookAhead + this.cinematicLift * 2.2 + this.liftPulse * 1.2;

    this.computeDesired(target, forward, TMP_DESIRED);
    if (!this.initialized) {
      this.cameraPos.copy(TMP_DESIRED);
      this.lookAt.copy(target).addScaledVector(forward, lookAhead);
      this.initialized = true;
    } else {
      const posK = 1 - Math.exp(-dt / Math.max(1e-4, this.params.lag));
      this.cameraPos.lerp(TMP_DESIRED, posK);
      TMP_LOOK.copy(target).addScaledVector(forward, lookAhead);
      TMP_LOOK.y += this.params.lookHeight;
      TMP_LOOK.y -= this.impactPulse * 0.2;
      const lookK = 1 - Math.exp(-dt / 0.07);
      this.lookAt.lerp(TMP_LOOK, lookK);
    }

    this.flatForward.copy(forward);
    this.flatForward.y = 0;
    if (this.flatForward.lengthSq() < 1e-6) this.flatForward.set(0, 0, 1);
    this.flatForward.normalize();

    const speedRatio = Math.max(0, Math.min(1, speed / Math.max(1e-3, maxSpeed)));
    const fovTarget = this.params.fovBase
      + (this.params.fovMax - this.params.fovBase) * speedRatio
      - this.impactPulse * 7
      + this.liftPulse * 4
      - this.cinematicLift * 2;
    const fovK = 1 - Math.exp(-dt / (this.impactPulse > 0.05 ? 0.05 : 0.28));
    this.fov += (fovTarget - this.fov) * fovK;
    this.applyToCamera();
  }

  private applyToCamera(): void {
    this.camera.position.copy(this.cameraPos);
    this.camera.lookAt(this.lookAt);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  /** 输入方向用的镜头朝向：水平面内从镜头指向注视点。 */
  getPlanarForward(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.flatForward);
  }

  /** 当前水平右方向（镜头右手侧）。 */
  getPlanarRight(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-this.flatForward.z, 0, this.flatForward.x);
  }
}
