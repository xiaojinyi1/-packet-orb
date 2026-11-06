/**
 * 右下角最小 HUD：当前 ttl / 地址 / 平均延迟 / 丢包 + 全程进度条。
 * 数据来自最近一跳节点，不参与物理。
 */
export interface HudData {
  ttl: number;
  address: string;
  avgMs: number | null;
  lossPct: number;
  progress: number;
  zoneLabel: string;
}

export class HUD {
  readonly element: HTMLElement;
  private readonly ttlEl: HTMLElement;
  private readonly addrEl: HTMLElement;
  private readonly avgEl: HTMLElement;
  private readonly lossEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly zoneEl: HTMLElement;

  constructor(host: HTMLElement) {
    const root = document.createElement('aside');
    root.className = 'po-hud';
    root.innerHTML = `
      <div class="po-hud-row"><span class="po-hud-key">TTL</span><span class="po-hud-val" data-role="ttl">—</span></div>
      <div class="po-hud-row"><span class="po-hud-key">ADDR</span><span class="po-hud-val" data-role="addr">—</span></div>
      <div class="po-hud-row"><span class="po-hud-key">AVG</span><span class="po-hud-val" data-role="avg">—</span></div>
      <div class="po-hud-row"><span class="po-hud-key">LOSS</span><span class="po-hud-val" data-role="loss">—</span></div>
      <div class="po-hud-row"><span class="po-hud-key">ZONE</span><span class="po-hud-val" data-role="zone">—</span></div>
      <div class="po-hud-progress"><i data-role="bar" style="width:0%"></i></div>
    `;
    host.appendChild(root);
    this.element = root;
    this.ttlEl = root.querySelector<HTMLElement>('[data-role="ttl"]')!;
    this.addrEl = root.querySelector<HTMLElement>('[data-role="addr"]')!;
    this.avgEl = root.querySelector<HTMLElement>('[data-role="avg"]')!;
    this.lossEl = root.querySelector<HTMLElement>('[data-role="loss"]')!;
    this.zoneEl = root.querySelector<HTMLElement>('[data-role="zone"]')!;
    this.barEl = root.querySelector<HTMLElement>('[data-role="bar"]')!;
  }

  update(data: HudData): void {
    this.ttlEl.textContent = `T${data.ttl}`;
    this.addrEl.textContent = data.address || '—';
    this.avgEl.textContent = data.avgMs === null ? '—' : `${data.avgMs.toFixed(1)} ms`;
    this.lossEl.textContent = `${data.lossPct.toFixed(0)}%`;
    this.lossEl.classList.toggle('is-loss', data.lossPct > 0);
    this.zoneEl.textContent = data.zoneLabel;
    this.barEl.style.width = `${Math.max(0, Math.min(100, data.progress * 100)).toFixed(1)}%`;
  }

  dispose(): void {
    this.element.remove();
  }
}
