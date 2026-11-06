/**
 * 终端风格粘贴面板：整块识别格式 → 解析 → 交给 main 重建世界。
 * 失败时显示置信度、错误摘要与「强制解析」；成功时显示格式 / 跳数 / 置信度。
 */
import './panel.css';
import { BUILTIN_SAMPLES } from '../data/BuiltinSamples';
import { FORMAT_LABEL, PARSE_EXAMPLE, parseTrace } from '../data/PasteParser';
import type { ParseOutcome } from '../data/PasteParser';
import type { BuiltinSample } from '../data/BuiltinSamples';
import type { TraceResult } from '../data/Schema';

export interface TerminalHandlers {
  onGenerate: (trace: TraceResult, info: { format: string; confidence: number }) => void;
  onBuiltin: (sample: BuiltinSample) => void;
  onShare: () => void;
}

type StatusKind = 'idle' | 'busy' | 'ok' | 'error';

export class TerminalPanel {
  readonly element: HTMLElement;
  private readonly handlers: TerminalHandlers;
  private readonly textarea: HTMLTextAreaElement;
  private readonly statusEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly generateBtn: HTMLButtonElement;
  private readonly forceBtn: HTMLButtonElement;
  private readonly fileInput: HTMLInputElement;
  private readonly builtinSelect: HTMLSelectElement;
  private busy = false;

  constructor(host: HTMLElement, handlers: TerminalHandlers) {
    this.handlers = handlers;
    const root = document.createElement('section');
    root.className = 'po-terminal';
    root.innerHTML = `
      <div class="po-terminal-bar">
        <span class="po-terminal-dot"></span>
        <span class="po-terminal-title">packet-orb://trace</span>
        <button class="po-terminal-min" type="button" title="收起 / 展开">—</button>
      </div>
      <div class="po-terminal-body">
        <div class="po-terminal-hint">粘贴 traceroute / tracert / mtr -r 原始输出，Enter 生成迷宫</div>
        <textarea class="po-terminal-input" spellcheck="false" aria-label="粘贴 traceroute / tracert / mtr 原始输出" placeholder="traceroute to example.com ..."></textarea>
        <div class="po-terminal-row">
          <button class="po-btn po-btn-primary" data-action="generate" type="button">解析并生成 Enter</button>
          <button class="po-btn" data-action="example" type="button">填入示例</button>
          <button class="po-btn" data-action="file" type="button">导入 .txt</button>
          <button class="po-btn" data-action="share" type="button">复制分享链接</button>
          <button class="po-btn po-btn-force" data-action="force" type="button" hidden>强制解析</button>
        </div>
        <div class="po-terminal-row po-terminal-samples">
          <select class="po-terminal-select" data-role="builtin" aria-label="内置合成样本"></select>
          <button class="po-btn" data-action="builtin" type="button">载入内置</button>
          <span class="po-badge po-badge-synth" data-role="synth" hidden>内置合成样本</span>
        </div>
        <div class="po-terminal-status" data-role="status" role="status" aria-live="polite">等待输入。</div>
        <div class="po-terminal-meta" data-role="meta"></div>
      </div>
      <input class="po-hidden-input" type="file" accept=".txt,text/plain" data-role="file-input" aria-label="导入 traceroute 文本文件" />
    `;
    host.appendChild(root);
    this.element = root;

    this.textarea = root.querySelector<HTMLTextAreaElement>('.po-terminal-input')!;
    this.statusEl = root.querySelector<HTMLElement>('[data-role="status"]')!;
    this.metaEl = root.querySelector<HTMLElement>('[data-role="meta"]')!;
    this.generateBtn = root.querySelector<HTMLButtonElement>('[data-action="generate"]')!;
    this.forceBtn = root.querySelector<HTMLButtonElement>('[data-action="force"]')!;
    this.fileInput = root.querySelector<HTMLInputElement>('[data-role="file-input"]')!;
    this.builtinSelect = root.querySelector<HTMLSelectElement>('[data-role="builtin"]')!;

    for (const sample of BUILTIN_SAMPLES) {
      const option = document.createElement('option');
      option.value = sample.id;
      option.textContent = sample.label;
      this.builtinSelect.appendChild(option);
    }

    root.querySelector<HTMLButtonElement>('[data-action="generate"]')!.addEventListener('click', () => void this.submit());
    root.querySelector<HTMLButtonElement>('[data-action="example"]')!.addEventListener('click', () => {
      this.textarea.value = PARSE_EXAMPLE;
      this.textarea.focus();
      this.setStatus('示例已填入，按 Enter 解析。', 'idle');
    });
    root.querySelector<HTMLButtonElement>('[data-action="file"]')!.addEventListener('click', () => this.fileInput.click());
    root.querySelector<HTMLButtonElement>('[data-action="share"]')!.addEventListener('click', () => this.handlers.onShare());
    this.fileInput.addEventListener('change', () => void this.loadFile());
    this.forceBtn.addEventListener('click', () => void this.submit(true));
    root.querySelector<HTMLButtonElement>('[data-action="builtin"]')!.addEventListener('click', () => {
      const sample = BUILTIN_SAMPLES.find((s) => s.id === this.builtinSelect.value) ?? BUILTIN_SAMPLES[0];
      this.setSynthBadge(sample.synthetic);
      this.setStatus(`已载入 ${sample.label}（内置合成，非真实测量）。`, 'ok');
      this.handlers.onBuiltin(sample);
    });
    root.querySelector<HTMLButtonElement>('.po-terminal-min')!.addEventListener('click', () => {
      root.classList.toggle('is-collapsed');
    });

    this.textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    });

    // 拖拽整块面板任意位置都能接收 .txt
    root.addEventListener('dragover', (event) => {
      event.preventDefault();
      root.classList.add('is-drag');
    });
    root.addEventListener('dragleave', () => root.classList.remove('is-drag'));
    root.addEventListener('drop', (event) => {
      event.preventDefault();
      root.classList.remove('is-drag');
      const file = event.dataTransfer?.files?.[0];
      if (file) void this.readFile(file);
    });
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.generateBtn.disabled = busy;
    this.forceBtn.disabled = busy;
    this.generateBtn.textContent = busy ? '重建中…' : '解析并生成 Enter';
  }

  setStatus(text: string, kind: StatusKind = 'idle'): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset.kind = kind;
  }

  setSynthBadge(visible: boolean): void {
    const badge = this.element.querySelector<HTMLElement>('[data-role="synth"]');
    if (badge) badge.hidden = !visible;
  }

  private async loadFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (file) await this.readFile(file);
    this.fileInput.value = '';
  }

  private async readFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      this.textarea.value = text;
      this.setStatus(`已读取 ${file.name}（${(file.size / 1024).toFixed(1)} KB），Enter 解析。`, 'ok');
    } catch (err) {
      this.setStatus(`读取文件失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  private async submit(force = false): Promise<void> {
    if (this.busy) return;
    const text = this.textarea.value.trim();
    if (!text) {
      this.setStatus('请先粘贴 traceroute / mtr -r 原始输出。', 'error');
      return;
    }
    this.setBusy(true);
    this.setStatus('解析中…', 'busy');
    // 让浏览器先画出 busy 态，再做同步解析（解析本身是毫秒级）
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const outcome = parseTrace(text, { forceParse: force });
    if (!outcome.trace) {
      this.setBusy(false);
      this.showFailure(outcome);
      return;
    }

    const { trace } = outcome;
    this.setSynthBadge(trace.synthetic === true);
    this.metaEl.textContent =
      `${FORMAT_LABEL[outcome.format]} · ${trace.hops.length} 跳 · ` +
      `置信度 ${(outcome.confidence * 100).toFixed(0)}% · ${trace.target.host}`;
    this.setStatus(
      `生成世界：${trace.hops.length} 跳，${trace.quality.anonymous} 个匿名跳` +
        `${trace.quality.truncated ? '，已截断到 30 跳' : ''}。`,
      'ok',
    );
    this.forceBtn.hidden = true;
    this.handlers.onGenerate(trace, { format: outcome.format, confidence: outcome.confidence });
  }

  private showFailure(outcome: ParseOutcome): void {
    const pct = (outcome.confidence * 100).toFixed(0);
    const reason = outcome.error ?? '无法识别输入格式';
    this.setStatus(`${reason}（置信度 ${pct}%）`, 'error');
    this.metaEl.textContent = '';
    const looksLikeTrace = /(traceroute|tracert|mtr|hops?|ms\b)/i.test(this.textarea.value);
    this.forceBtn.hidden = !looksLikeTrace;
  }

  dispose(): void {
    this.element.remove();
  }
}
