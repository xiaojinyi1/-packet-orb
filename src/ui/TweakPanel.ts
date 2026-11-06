/**
 * tweakpane 调参面板：按 / 呼出/收起。
 * 只暴露 P1 需要调的手感/物理/镜头参数，不做游戏 UI。
 *
 * 说明：tweakpane 4.0.5 发布包里 dist/types 引用了未随包发布的 @tweakpane/core，
 * 官方类型不可用；这里按实际用到的 API 写一个最小结构类型，运行时行为不变。
 */
import { Pane } from 'tweakpane';
import type { SimConfig } from '../sim/protocol';
import type { FollowParams } from '../camera/FollowRig';
import type { ThemeName } from '../render/Theme';

export type Quality = 'high' | 'medium' | 'low';

interface BindingLike {
  on(event: 'change' | 'click', handler: () => void): BindingLike;
}

interface FolderLike {
  addBinding<T extends object, K extends keyof T>(
    target: T,
    key: K,
    options?: Record<string, unknown>,
  ): BindingLike;
  addFolder(options: { title?: string }): FolderLike;
  addButton(options: { title: string }): BindingLike;
}

interface PaneLike extends FolderLike {
  readonly element: HTMLElement;
  dispose(): void;
}

type PaneConstructor = new (options?: { container?: HTMLElement; title?: string }) => PaneLike;
const PaneClass = Pane as unknown as PaneConstructor;

export interface PanelState {
  quality: Quality;
  showStats: boolean;
  theme: ThemeName;
}

export interface TweakPanelOptions {
  config: SimConfig;
  camera: FollowParams;
  onPhysics: (partial: Partial<SimConfig>) => void;
  onCamera: (params: FollowParams) => void;
  onQuality: (quality: Quality) => void;
  onTheme: (theme: ThemeName) => void;
  onReset: () => void;
}

export class TweakPanel {
  readonly pane: PaneLike;
  readonly state: PanelState = { quality: 'high', showStats: true, theme: 'night' };
  readonly config: SimConfig;
  readonly camera: FollowParams;
  private wrapper: HTMLElement;
  private options: TweakPanelOptions;
  private visible = true;

  constructor(host: HTMLElement, options: TweakPanelOptions) {
    this.options = options;
    this.config = options.config;
    this.camera = options.camera;

    const wrapper = document.createElement('div');
    wrapper.className = 'po-tweakpane';
    host.appendChild(wrapper);
    this.wrapper = wrapper;
    this.pane = new PaneClass({ container: wrapper, title: 'Packet Orb · M2' });

    const drive = this.pane.addFolder({ title: 'Drive' });
    this.bindConfig(drive, 'torqueShare', { min: 0, max: 1, step: 0.01, label: 'torque 比例' });
    this.bindConfig(drive, 'torquePower', { min: 0, max: 12, step: 0.05, label: 'torque 上限' });
    this.bindConfig(drive, 'forcePower', { min: 0, max: 30, step: 0.1, label: 'force 上限' });
    this.bindConfig(drive, 'assistFloor', { min: 0, max: 1, step: 0.01, label: 'assist 下限' });
    this.bindConfig(drive, 'maxSpeed', { min: 4, max: 24, step: 0.1, label: 'maxSpeed' });

    const physics = this.pane.addFolder({ title: 'Physics' });
    this.bindConfig(physics, 'linearDamping', { min: 0, max: 1.5, step: 0.01 });
    this.bindConfig(physics, 'angularDamping', { min: 0, max: 1.5, step: 0.01 });
    this.bindConfig(physics, 'rollingFriction', { min: 0, max: 0.3, step: 0.005, label: 'rollingFriction' });
    this.bindConfig(physics, 'restitution', { min: 0, max: 1, step: 0.01 });
    this.bindConfig(physics, 'gravity', { min: 1, max: 30, step: 0.1 });

    const cam = this.pane.addFolder({ title: 'Camera' });
    cam.addBinding(this.camera, 'lag', { min: 0.02, max: 1, step: 0.01, label: 'lag (s)' }).on('change', () => {
      this.options.onCamera({ ...this.camera });
    });
    cam.addBinding(this.camera, 'lookAhead', { min: 0, max: 10, step: 0.1, label: 'lookAhead' }).on('change', () => {
      this.options.onCamera({ ...this.camera });
    });
    cam.addBinding(this.camera, 'lookHeight', { min: -1, max: 3, step: 0.1, label: 'look 抬升' }).on('change', () => {
      this.options.onCamera({ ...this.camera });
    });
    cam.addBinding(this.camera, 'fovBase', { min: 45, max: 90, step: 0.5, label: 'fov base' }).on('change', () => {
      this.options.onCamera({ ...this.camera });
    });
    cam.addBinding(this.camera, 'fovMax', { min: 45, max: 110, step: 0.5, label: 'fov max' }).on('change', () => {
      this.options.onCamera({ ...this.camera });
    });

    const perf = this.pane.addFolder({ title: 'Quality / Theme' });
    perf.addBinding(this.state, 'quality', {
      options: { High: 'high', Medium: 'medium', Low: 'low' },
      label: '画质档位',
    }).on('change', () => this.options.onQuality(this.state.quality));
    perf.addBinding(this.state, 'showStats', { label: '帧时采样' });
    perf.addBinding(this.state, 'theme', {
      options: { Night: 'night', Day: 'day' },
      label: '主题',
    }).on('change', () => this.options.onTheme(this.state.theme));

    this.pane.addButton({ title: '重置到起点 (R)' }).on('click', () => this.options.onReset());

    window.addEventListener('keydown', this.onKeyDown);
    labelTweakpaneInputs(wrapper);
  }

  private bindConfig(
    folder: FolderLike,
    key: keyof SimConfig,
    options: { min: number; max: number; step: number; label?: string },
  ): void {
    folder.addBinding(this.config, key, options).on('change', () => {
      this.options.onPhysics({ [key]: this.config[key] } as Partial<SimConfig>);
    });
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== '/') return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    event.preventDefault();
    this.toggle();
  };

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.wrapper.style.display = this.visible ? '' : 'none';
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.pane.dispose();
  }
}

/** tweakpane 4 的内部 input/select 没有可访问名，用行标签补上 aria-label。 */
function labelTweakpaneInputs(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.tp-lblv').forEach((row) => {
    const label = row.querySelector<HTMLElement>('.tp-lblv_l')?.textContent?.trim();
    if (!label) return;
    row.querySelectorAll<HTMLElement>('input, select').forEach((el) => {
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', label);
    });
  });
}
