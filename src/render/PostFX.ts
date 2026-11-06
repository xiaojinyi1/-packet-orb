/**
 * 后处理：
 *   High   = Bloom + 轻量 DOF
 *   Medium = Bloom
 *   Low    = 直接渲染（无后处理）
 * 只在这里创建 composer，避免 world 生成器依赖渲染管线。
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type FxLevel = 'high' | 'medium' | 'low';

export class PostFX {
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly bokeh: BokehPass;
  private readonly output: OutputPass;
  private level: FxLevel = 'high';
  private readonly size = new THREE.Vector2();

  constructor(
    renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    renderer.getSize(this.size);
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.size.x, this.size.y), 0.42, 0.72, 0.72);
    this.composer.addPass(this.bloom);
    this.bokeh = new BokehPass(scene, camera, { focus: 8, aperture: 0.00035, maxblur: 0.006 });
    this.composer.addPass(this.bokeh);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.setLevel('high');
  }

  setLevel(level: FxLevel): void {
    this.level = level;
    this.bloom.enabled = level !== 'low';
    this.bokeh.enabled = level === 'high';
    this.bloom.strength = level === 'medium' ? 0.32 : 0.42;
  }

  get currentLevel(): FxLevel {
    return this.level;
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.bokeh.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  /** focus 用球到相机的距离，保证球永远在最清晰的那层。 */
  render(focusDistance: number): void {
    if (this.level === 'low') {
      this.composer.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.bokeh.enabled) {
      const uniforms = (this.bokeh as unknown as { uniforms?: { focus?: { value: number } } }).uniforms;
      const material = (this.bokeh as unknown as { materialBokeh?: { uniforms: { focus: { value: number } } } })
        .materialBokeh;
      if (uniforms?.focus) uniforms.focus.value = focusDistance;
      else if (material?.uniforms.focus) material.uniforms.focus.value = focusDistance;
    }
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.bloom.dispose();
    (this.bokeh as unknown as { dispose?: () => void }).dispose?.();
    this.output.dispose();
  }
}
