/**
 * 三输入：键盘 / 触屏左摇杆 / Gamepad API。
 * - 输入源切换时更新提示文案（.po-input-hint）。
 * - 移动端（粗指针或窄屏）默认进入「轨道投递」观赏模式。
 * - 轨道模式：自动沿主路径行驶；按住蓄力，松手投递。
 */
export type InputSource = 'keyboard' | 'touch' | 'gamepad';
export type DriveMode = 'free' | 'orbit';

export interface AxisInput {
  forward: number;
  right: number;
  active: boolean;
  reset: boolean;
  /** 长按 R ≥ 3 秒：反向播放彩蛋。 */
  rewind: boolean;
  source: InputSource;
  mode: DriveMode;
  /** 轨道模式蓄力 0..1 */
  charge: number;
  /** 本帧松手投递 */
  launch: boolean;
  /** 本帧出现了新输入（用于解锁音频） */
  interacted: boolean;
}

const DEAD = 0.08;

function isCoarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export class InputMapper {
  private keys = new Set<string>();
  private resetPressed = false;
  private rewindPressed = false;
  private rDownAt = 0;
  private source: InputSource = 'keyboard';
  private mode: DriveMode = 'free';
  private charge = 0;
  private charging = false;
  private launch = false;
  private interacted = false;

  private readonly joystick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private touchForward = 0;
  private touchRight = 0;

  constructor(host: HTMLElement) {
    this.mode = isCoarsePointer() || window.innerWidth < 820 ? 'orbit' : 'free';

    this.joystick = document.createElement('div');
    this.joystick.className = 'po-stick';
    this.knob = document.createElement('div');
    this.knob.className = 'po-stick-knob';
    this.joystick.appendChild(this.knob);
    this.joystick.style.display = 'none';
    host.appendChild(this.joystick);

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'po-input-hint';
    host.appendChild(this.hintEl);
    this.updateHint();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('gamepadconnected', this.onGamepad);
  }

  get currentMode(): DriveMode {
    return this.mode;
  }

  get currentSource(): InputSource {
    return this.source;
  }

  setMode(mode: DriveMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.charge = 0;
    this.charging = false;
    this.updateHint();
  }

  toggleMode(): void {
    this.setMode(this.mode === 'free' ? 'orbit' : 'free');
  }

  private setSource(next: InputSource): void {
    if (this.source === next) return;
    this.source = next;
    this.updateHint();
  }

  private updateHint(): void {
    const mode = this.mode === 'orbit' ? '轨道投递' : '自由驾驶';
    const body =
      this.source === 'touch'
        ? '左摇杆转向 · 按住蓄力 · 松手投递'
        : this.source === 'gamepad'
          ? '左摇杆转向 · A 蓄力 · 松手投递'
          : 'WASD / 方向键 驾驶 · 空格 投递 · R 复位 · Tab 切模式';
    this.hintEl.textContent = `${mode} · ${body}`;
    this.hintEl.dataset.mode = this.mode;
    this.hintEl.dataset.source = this.source;
  }

  private onGamepad = (): void => {
    this.setSource('gamepad');
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      this.toggleMode();
      return;
    }
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyR' && !e.repeat) this.rDownAt = performance.now();
    this.keys.add(e.code);
    this.setSource('keyboard');
    this.interacted = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code !== 'KeyR') return;
    // R 按下即复位；按住 ≥3 秒改为触发“反向播放”，松手时不再复位。
    if (this.rDownAt > 0 && performance.now() - this.rDownAt >= 3000) {
      this.rewindPressed = true;
    } else {
      this.resetPressed = true;
    }
    this.rDownAt = 0;
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.touchForward = 0;
    this.touchRight = 0;
  };

  private onCanvas(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (!el.closest('#app canvas')) return false;
    return !el.closest('.po-terminal, .po-result, .tp-dfwv, .po-tweakpane, .po-hud');
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.onCanvas(e.target)) return;
    const touch = e.pointerType === 'touch';
    if (!touch && this.mode === 'free') return;
    this.setSource(touch ? 'touch' : this.source);
    this.interacted = true;
    if (this.mode === 'orbit') {
      e.preventDefault();
      this.charging = true;
      this.charge = 0;
      return;
    }
    if (!touch) return;
    e.preventDefault();
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.joystick.style.display = 'block';
    this.joystick.style.left = `${e.clientX - 56}px`;
    this.joystick.style.top = `${e.clientY - 56}px`;
    this.knob.style.transform = 'translate(0px, 0px)';
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.mode === 'orbit') {
      if (this.charging) this.charge = Math.min(1, this.charge + 0.035);
      return;
    }
    if (this.stickId !== e.pointerId) return;
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy) || 1;
    const max = 48;
    const k = Math.min(1, max / len);
    this.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    const nx = Math.max(-1, Math.min(1, dx / max));
    const ny = Math.max(-1, Math.min(1, dy / max));
    this.touchRight = Math.abs(nx) > DEAD ? nx : 0;
    this.touchForward = Math.abs(-ny) > DEAD ? -ny : 0;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.mode === 'orbit') {
      if (this.charging) {
        this.charging = false;
        this.launch = true;
      }
      return;
    }
    if (this.stickId !== e.pointerId) return;
    this.stickId = null;
    this.touchForward = 0;
    this.touchRight = 0;
    this.joystick.style.display = 'none';
  };

  read(): AxisInput {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let padForward = 0;
    let padRight = 0;
    let padLaunch = false;
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      if (Math.abs(ax) > DEAD || Math.abs(ay) > DEAD) {
        padRight = Math.abs(ax) > DEAD ? ax : 0;
        padForward = Math.abs(-ay) > DEAD ? -ay : 0;
        this.setSource('gamepad');
      }
      if (pad.buttons[0]?.pressed) {
        padLaunch = true;
        this.setSource('gamepad');
      }
    }

    let kForward = 0;
    let kRight = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) kForward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) kForward -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kRight += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kRight -= 1;

    const forward = kForward !== 0 ? kForward : padForward !== 0 ? padForward : this.touchForward;
    const right = kRight !== 0 ? kRight : padRight !== 0 ? padRight : this.touchRight;
    const active = Math.abs(forward) > 0.05 || Math.abs(right) > 0.05;

    if (this.mode === 'orbit') {
      if (padLaunch) {
        this.charging = true;
        this.charge = Math.min(1, this.charge + 0.05);
      } else if (this.charging && this.charge > 0) {
        this.charging = false;
        this.launch = true;
      }
    }

    const reset = this.resetPressed;
    this.resetPressed = false;
    const rewind = this.rewindPressed;
    this.rewindPressed = false;
    const launch = this.launch;
    this.launch = false;
    const interacted = this.interacted;
    this.interacted = false;

    return {
      forward,
      right,
      active,
      reset,
      rewind,
      source: this.source,
      mode: this.mode,
      charge: this.charge,
      launch,
      interacted,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('gamepadconnected', this.onGamepad);
    this.joystick.remove();
    this.hintEl.remove();
  }
}
