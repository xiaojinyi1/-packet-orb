/**
 * 到站结算：逐跳延迟瀑布图、最慢一跳高亮、丢包段回放 / 重跑。
 * 只消费 TraceResult，不读原始粘贴文本。
 */
import type { TraceResult } from '../data/Schema';

export interface ResultActions {
  onReplay: () => void;
  onRestart: () => void;
  onClose: () => void;
  onShare?: () => void;
}

export class ResultPanel {
  readonly element: HTMLElement;
  private readonly card: HTMLElement;
  private actions: ResultActions | null = null;

  constructor(host: HTMLElement) {
    const root = document.createElement('div');
    root.className = 'po-result';
    root.hidden = true;
    root.innerHTML = `<div class="po-result-card" role="dialog" aria-modal="true" aria-label="到站结算"></div>`;
    host.appendChild(root);
    this.element = root;
    this.card = root.querySelector<HTMLElement>('.po-result-card')!;
    root.addEventListener('click', (event) => {
      if (event.target === root) this.hide();
    });
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  show(trace: TraceResult, actions: ResultActions): void {
    this.actions = actions;
    const hops = trace.hops;
    const maxAvg = Math.max(1, ...hops.map((h) => h.avgMs ?? 0));
    const slowest = hops.reduce((best, h, i) => ((h.avgMs ?? -1) > (hops[best].avgMs ?? -1) ? i : best), 0);
    const lost = hops.filter((h) => h.anonymous).length;

    this.card.innerHTML = `
      <h2>PACKET ARRIVED</h2>
      <div class="po-result-sub">
        ${escapeHtml(trace.target.host)} · ${hops.length} 跳 · 匿名 ${lost} ·
        置信度 ${(trace.quality.confidence * 100).toFixed(0)}%
        ${trace.synthetic ? '· 内置合成样本' : `· ${trace.source}`}
      </div>
      <div class="po-result-list"></div>
      <div class="po-result-actions">
        <button class="po-btn" data-action="share" type="button">复制分享链接</button>
        <button class="po-btn" data-action="replay" type="button">回放丢包路段</button>
        <button class="po-btn" data-action="restart" type="button">再跑一次</button>
        <button class="po-btn po-btn-primary" data-action="close" type="button">关闭</button>
      </div>
      <div class="po-result-media" data-role="media" hidden></div>
      <div class="po-result-note">瀑布条 = 该跳平均 RTT；最慢一跳标品红。丢包路段回放会暂停驾驶、沿最差区段推一段镜头。</div>
    `;

    const list = this.card.querySelector<HTMLElement>('.po-result-list')!;
    hops.forEach((hop, index) => {
      const row = document.createElement('div');
      row.className = 'po-result-hop' + (index === slowest ? ' is-slowest' : '');
      const addr = hop.anonymous ? '匿名 / * * *' : (hop.ptr ?? hop.addresses[0] ?? '—');
      const width = Math.max(2, ((hop.avgMs ?? 0) / maxAvg) * 100);
      row.innerHTML = `
        <span class="po-result-ttl">T${hop.ttl}</span>
        <span class="po-result-addr" title="${escapeHtml(addr)}">${escapeHtml(addr)}</span>
        <span class="po-result-bar"><i style="width:${width.toFixed(1)}%"></i></span>
        <span class="po-result-ms">${hop.avgMs === null ? '—' : `${hop.avgMs.toFixed(1)} ms`}${
          hop.lossPct > 0 ? ` / ${hop.lossPct.toFixed(0)}%` : ''
        }</span>
      `;
      list.appendChild(row);
    });

    const share = this.card.querySelector<HTMLButtonElement>('[data-action="share"]')!;
    if (!actions.onShare) {
      share.hidden = true;
    } else {
      share.addEventListener('click', () => this.actions?.onShare?.());
    }
    this.card.querySelector<HTMLButtonElement>('[data-action="replay"]')!.addEventListener('click', () => this.actions?.onReplay());
    this.card.querySelector<HTMLButtonElement>('[data-action="restart"]')!.addEventListener('click', () => this.actions?.onRestart());
    this.card.querySelector<HTMLButtonElement>('[data-action="close"]')!.addEventListener('click', () => this.actions?.onClose());
    this.element.hidden = false;
  }

  /** 录屏 / 静态图回退，由 main 在 MediaRecorder 结束后调用。 */
  setMedia(label: string, href: string, download?: string): void {
    const box = this.card.querySelector<HTMLElement>('[data-role="media"]');
    if (!box) return;
    const a = document.createElement('a');
    a.className = 'po-result-media-link';
    a.textContent = label;
    a.href = href;
    if (download) a.download = download;
    else a.target = '_blank';
    a.rel = 'noreferrer';
    box.replaceChildren(a);
    box.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  dispose(): void {
    this.element.remove();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
