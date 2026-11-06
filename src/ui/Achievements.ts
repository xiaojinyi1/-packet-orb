/**
 * 12 条彩蛋成就。右下角轻提示，不弹窗、不打断驾驶。
 * 触发条件分散在 main / 物理 flags / 解析结果里；这里只负责定义、去重与展示。
 */
export interface AchievementDef {
  id: string;
  title: string;
  desc: string;
  /** 尚未接线的条件在报告里要如实列出 */
  wired: boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'void', title: '你是从哪里来的？', desc: '滚出地图边界，掉进星空 void', wired: true },
  { id: 'bumps', title: '路政车出场', desc: '撞塌全部减速带', wired: false },
  { id: 'loop', title: '无限回廊', desc: '路由里出现了重复 IP', wired: true },
  { id: 'fog_off', title: '其实没有路', desc: '在迷雾隧道里连按三下 F', wired: true },
  { id: 'zero_loss', title: '零丢包送达', desc: '轨道投递一次不停直达终点', wired: true },
  { id: 'reroute', title: '重路由惩罚', desc: '抄近路越出主干道', wired: true },
  { id: 'door3', title: '门自己裂开', desc: '撞终点门三次', wired: true },
  { id: 'all_star', title: '运营商把一切都藏起来了', desc: '粘贴一段全是 * 的 trace', wired: true },
  { id: 'night_owl', title: '萤火虫版夜网', desc: '凌晨 0–5 点访问', wired: true },
  { id: 'rewind', title: '反向播放', desc: '长按 R 三秒，从终点退回你家', wired: true },
  { id: 'gamepad', title: '手柄玩家', desc: '用手柄输入并隐藏标题界面', wired: true },
  { id: 'e1', title: '全部彩蛋', desc: '分享链接带 ?e=1', wired: true },
];

const STORAGE_KEY = 'packet-orb/achievements';

export class Achievements {
  private readonly unlocked = new Set<string>();
  private readonly host: HTMLElement;
  private queue: AchievementDef[] = [];
  private showing = false;
  private readonly toastEl: HTMLDivElement;
  private readonly counterEl: HTMLSpanElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.toastEl = document.createElement('div');
    this.toastEl.className = 'po-toast';
    this.host.appendChild(this.toastEl);

    this.counterEl = document.createElement('span');
    this.counterEl.className = 'po-achievement-count';

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const list = JSON.parse(raw) as string[];
        for (const id of list) this.unlocked.add(id);
      }
    } catch {
      // localStorage 不可用时只做会话内解锁
    }
    this.renderCounter();
  }

  get count(): number {
    return this.unlocked.size;
  }

  has(id: string): boolean {
    return this.unlocked.has(id);
  }

  unlockAll(): void {
    for (const def of ACHIEVEMENTS) this.unlocked.add(def.id);
    this.save();
    this.renderCounter();
  }

  unlock(id: string): boolean {
    if (this.unlocked.has(id)) return false;
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (!def || !def.wired) return false;
    this.unlocked.add(id);
    this.save();
    this.renderCounter();
    this.enqueue(def);
    return true;
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.unlocked]));
    } catch {
      // 忽略隐私模式下的写入失败
    }
  }

  private renderCounter(): void {
    this.counterEl.textContent = `◆ ${this.unlocked.size}/${ACHIEVEMENTS.length}`;
  }

  /** HUD 里的角标元素，交给 main 塞进 HUD。 */
  get counter(): HTMLSpanElement {
    return this.counterEl;
  }

  private enqueue(def: AchievementDef): void {
    this.queue.push(def);
    if (!this.showing) this.next();
  }

  private next(): void {
    const def = this.queue.shift();
    if (!def) {
      this.showing = false;
      return;
    }
    this.showing = true;
    this.toastEl.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'po-toast-title';
    title.textContent = def.title;
    const desc = document.createElement('div');
    desc.className = 'po-toast-desc';
    desc.textContent = def.desc;
    this.toastEl.append(title, desc);
    this.toastEl.classList.add('is-visible');
    window.setTimeout(() => {
      this.toastEl.classList.remove('is-visible');
      window.setTimeout(() => this.next(), 320);
    }, 2600);
  }
}
