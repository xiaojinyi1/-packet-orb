/**
 * 粘贴解析：一次吃掉 Unix/BSD traceroute、Windows tracert、mtr（--json / -r）。
 *
 * 策略：先整块识别格式 → 逐行正则 → 置信度打分；识别失败给出示例提示，
 * 并允许 forceParse 用"最长匹配"强行解析。容错优先于严格：
 * n<3 的跳保留原样（UI 标灰）、全 * 跳标 anonymous、>30 跳截断。
 */
import type { TraceResult } from './Schema';
import { buildTrace, scoreConfidence } from './Normalizer';
import type { RawHop } from './Normalizer';
import { parseMtrJson, parseMtrReport } from './MtrParser';

export type TraceFormat = 'traceroute' | 'tracert' | 'mtr-json' | 'mtr-report' | 'unknown';

export interface ParseOutcome {
  trace: TraceResult | null;
  format: TraceFormat;
  confidence: number;
  hopLines: number;
  notes: string[];
  error?: string;
}

interface ParsedBlock {
  rawHops: RawHop[];
  target: { host: string; ip: string | null };
  hopLines: number;
  formatMatched: boolean;
  truncated: boolean;
  notes: string[];
}

export const FORMAT_LABEL: Record<TraceFormat, string> = {
  traceroute: 'Unix traceroute',
  tracert: 'Windows tracert',
  'mtr-json': 'mtr --json',
  'mtr-report': 'mtr -r',
  unknown: '未识别',
};

export const PARSE_EXAMPLE = `traceroute to www.example.com (104.16.132.249), 30 hops max, 60 byte packets
 1  192.168.1.1 (192.168.1.1)  1.234 ms  1.102 ms  1.455 ms
 2  * * *
 3  202.97.60.1 (202.97.60.1) [AS4134]  38.120 ms  39.004 ms  41.220 ms

或 mtr -r www.example.com 的宽表输出（含 HOST / Loss% 表头）。`;

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

export function isIp(token: string): boolean {
  const clean = token.replace(/^\[|\]$/g, '');
  if (IPV4_RE.test(clean)) return clean.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  return clean.includes(':') && IPV6_RE.test(clean) && clean.split(':').length >= 3;
}

function extractIps(text: string): string[] {
  const out: string[] = [];
  const paren = [...text.matchAll(/\(([^)]+)\)/g)];
  for (const m of paren) if (isIp(m[1])) out.push(m[1]);
  if (out.length === 0) {
    for (const token of text.split(/[\s,]+/)) {
      const clean = token.replace(/[[\]]/g, '');
      if (isIp(clean)) out.push(clean);
    }
  } else {
    // 裸 IP 与括号内 IP 重复时只保留一个
    for (const token of text.split(/[\s,]+/)) {
      const clean = token.replace(/[[\]]/g, '');
      if (isIp(clean) && !out.includes(clean) && !paren.some((m) => m[1].includes(clean))) out.push(clean);
    }
  }
  return [...new Set(out)];
}

function consumeUnixRest(hop: RawHop, rest: string): void {
  for (const ip of extractIps(rest)) if (!hop.addresses.includes(ip)) hop.addresses.push(ip);
  const asMatch = rest.match(/\[?(AS\d+)\]?/i);
  if (asMatch) hop.as = asMatch[1].toUpperCase();
  if (!hop.ptr) {
    const ptr = rest.match(/^([A-Za-z0-9._-]+)\s+\(/);
    if (ptr && !isIp(ptr[1]) && ptr[1] !== '*') hop.ptr = ptr[1];
  }
  for (const m of rest.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*ms/g)) hop.samplesMs.push(Number(m[1]));
  hop.lost += (rest.match(/\*/g) ?? []).length;
  if (/\b[!][A-Z]\b/.test(rest) && hop.samplesMs.length === 0) hop.lost += 1;
}

function parseUnix(text: string): ParsedBlock | null {
  const lines = text.split(/\r?\n/);
  const rawHops: RawHop[] = [];
  let target: { host: string; ip: string | null } = { host: '', ip: null };
  let formatMatched = false;
  let hopLines = 0;
  let current: RawHop | null = null;

  for (const line of lines) {
    const header = line.match(/^\s*traceroute6?\s+(?:to\s+)?([^\s(]+)\s*(?:\(([^)]+)\))?/i);
    if (header && /hops?\s+max|byte\s+packets/i.test(line)) {
      formatMatched = true;
      const host = header[1];
      const ip = header[2] && isIp(header[2]) ? header[2] : isIp(host) ? host : null;
      target = { host, ip };
      continue;
    }

    const start = line.match(/^\s*(\d{1,3})\s+(.*)$/);
    if (start) {
      const ttl = Number(start[1]);
      if (ttl < 1 || ttl > 64) continue;
      current = { ttl, addresses: [], ptr: null, as: null, samplesMs: [], lost: 0 };
      consumeUnixRest(current, start[2]);
      rawHops.push(current);
      hopLines += 1;
      continue;
    }

    if (current && /^\s*(?:\*|[\d.]+\s*ms)\b/.test(line)) {
      consumeUnixRest(current, line.trim());
    }
  }

  if (rawHops.length === 0) return null;
  const truncated = rawHops.some((h) => h.ttl > 30) || rawHops.length > 30;
  return { rawHops, target, hopLines: Math.max(1, hopLines), formatMatched, truncated, notes: [] };
}

function parseTracert(text: string): ParsedBlock | null {
  const lines = text.split(/\r?\n/);
  const rawHops: RawHop[] = [];
  let target: { host: string; ip: string | null } = { host: '', ip: null };
  let formatMatched = false;
  let hopLines = 0;

  for (const line of lines) {
    const header = line.match(
      /^\s*(?:通过最多\s*\d+\s*个跃点跟踪到|Tracing route to)\s+(\S+)\s*(?:\[([^\]]+)\])?/i,
    );
    if (header) {
      formatMatched = true;
      const host = header[1];
      const ip = header[2] && isIp(header[2]) ? header[2] : isIp(host) ? host : null;
      target = { host, ip };
      continue;
    }
    if (/^\s*over a maximum of \d+ hops/i.test(line) || /Trace complete|跟踪完成/i.test(line)) continue;

    const m = line.match(/^\s*(\d{1,3})\s+(.*)$/);
    if (!m) continue;
    if (/跃点|hops\b/i.test(m[2])) continue;
    const ttl = Number(m[1]);
    if (ttl < 1 || ttl > 64) continue;
    const rest = m[2];
    const samples = [...rest.matchAll(/(\d+)\s*ms/gi)].map((x) => Number(x[1]));
    if (samples.length === 0 && !rest.includes('*') && !/请求超时|timed out|Request timed out/i.test(rest)) {
      continue;
    }
    const stars = (rest.match(/\*/g) ?? []).length;
    const timedOut = /请求超时|timed out|Request timed out/i.test(rest);
    const lost = Math.max(stars, timedOut ? Math.max(1, 3 - samples.length) : 0);
    const addresses = extractIps(rest).slice(-1);
    rawHops.push({ ttl, addresses, ptr: null, as: null, samplesMs: samples, lost });
    hopLines += 1;
  }

  if (rawHops.length === 0) return null;
  const truncated = rawHops.length > 30;
  return { rawHops, target, hopLines: Math.max(1, hopLines), formatMatched, truncated, notes: [] };
}

function toBlock(result: ReturnType<typeof parseMtrJson>): ParsedBlock | null {
  if (!result) return null;
  return {
    rawHops: result.rawHops,
    target: result.target,
    hopLines: result.hopLines,
    formatMatched: result.formatMatched,
    truncated: result.rawHops.length > 30,
    notes: [],
  };
}

export function detectFormat(text: string): TraceFormat {
  const head = text.trimStart();
  if (head.startsWith('{')) return 'mtr-json';
  if (/^\s*HOST\b.*Loss%/im.test(text) || /\.\|--\s/.test(text) || /^\s*\d+:\s+\[/m.test(text)) {
    return 'mtr-report';
  }
  if (/^\s*traceroute6?\s/im.test(text)) return 'traceroute';
  if (/通过最多|Tracing route to/i.test(text)) return 'tracert';
  return 'unknown';
}

/** forceParse：不看标题，逐行找"ttl + 地址/星号/ms"，按两种行格式里命中最多的那种解析。 */
function longestMatch(text: string): ParsedBlock | null {
  const unix = parseUnix(text);
  const win = parseTracert(text);
  const pick =
    (unix?.rawHops.length ?? 0) >= (win?.rawHops.length ?? 0) && unix ? unix : win;
  if (!pick) return null;
  // 去掉标题依赖：只要行能解析出 ttl 就算数。
  return { ...pick, formatMatched: false, notes: ['按最长匹配强行解析，字段可能不完整'] };
}

function tryAll(text: string): ParsedBlock | null {
  const blocks = [
    toBlock(parseMtrJson(text)),
    toBlock(parseMtrReport(text)),
    parseUnix(text),
    parseTracert(text),
  ].filter((b): b is ParsedBlock => b !== null);
  blocks.sort((a, b) => b.rawHops.length - a.rawHops.length);
  return blocks[0] ?? null;
}

export function parseTrace(text: string, opts: { forceParse?: boolean } = {}): ParseOutcome {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      trace: null,
      format: 'unknown',
      confidence: 0,
      hopLines: 0,
      notes: [],
      error: '输入为空：请粘贴 traceroute / tracert / mtr -r 的原始输出。',
    };
  }

  let format = detectFormat(trimmed);
  let block: ParsedBlock | null = null;
  switch (format) {
    case 'mtr-json':
      block = toBlock(parseMtrJson(trimmed));
      break;
    case 'mtr-report':
      block = toBlock(parseMtrReport(trimmed));
      break;
    case 'traceroute':
      block = parseUnix(trimmed);
      break;
    case 'tracert':
      block = parseTracert(trimmed);
      break;
    default:
      block = null;
  }

  if (!block || block.rawHops.length === 0) {
    block = tryAll(trimmed);
    if (block && !block.formatMatched) format = block.formatMatched ? format : 'unknown';
  }

  if (opts.forceParse && (!block || block.rawHops.length === 0)) {
    block = longestMatch(trimmed);
  }

  if (!block || block.rawHops.length === 0) {
    return {
      trace: null,
      format,
      confidence: 0,
      hopLines: 0,
      notes: [],
      error: '没能识别出任何跳。请贴 traceroute 或 mtr -r 原始输出，或点「强制解析」按最长匹配再试。',
    };
  }

  const confidence = scoreConfidence({
    formatMatched: block.formatMatched,
    hopLines: block.hopLines,
    hops: block.rawHops.length,
    targetFound: block.target.ip !== null,
    truncated: block.truncated,
  });

  const notes = [...block.notes];
  if (block.truncated) notes.push('超过 30 跳，已截断');

  const trace = buildTrace(block.rawHops, {
    source: 'paste',
    capturedAt: new Date().toISOString(),
    target: block.target,
    confidence,
    truncated: block.truncated,
  });

  if (trace.hops.length < 2) {
    return {
      trace: null,
      format,
      confidence,
      hopLines: block.hopLines,
      notes,
      error: '只解析到 1 跳，无法生成迷宫。',
    };
  }

  return { trace, format, confidence, hopLines: block.hopLines, notes };
}
