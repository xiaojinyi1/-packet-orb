/**
 * 原始解析结果 → TraceResult 契约（CLAUDE.md schema: "packet-orb/1"）。
 *
 * 三种格式（traceroute / tracert / mtr）的解析器只管把行拆成 RawHop：
 * ttl、地址、AS、每跳收到的样本、丢掉的样本数。统计量、私网判定、
 * 匿名判定、截断与置信度都在这里统一算，保证三条输入路径得到的
 * HopResult 完全一致。
 */
import type { HopResult, TraceResult } from './Schema';

/** 解析器的中间产物；不是对外契约。 */
export interface RawHop {
  ttl: number;
  addresses: string[];
  ptr: string | null;
  as: string | null;
  geo?: string | null;
  /** 收到的样本（ms）。 */
  samplesMs: number[];
  /** 丢失的探测数（`*` / 请求超时）。 */
  lost: number;
  /** mtr 的 Avg / StDev 列：样本不是逐包明细，统计量直接采信表格。 */
  avgMs?: number;
  stddevMs?: number;
  /**
   * mtr 直接给 Loss%（样本数不是逐包明细），优先于 lost/(lost+n)。
   * traceroute / tracert 不设置。
   */
  lossPct?: number;
}

export interface TraceMeta {
  source: 'paste' | 'builtin';
  target: { host: string; ip: string | null };
  capturedAt: string;
  /** 输入超过 30 跳被截断。 */
  truncated?: boolean;
  /** 解析器打分，写进 quality.confidence。 */
  confidence?: number;
}

export function isPrivateAddress(ip: string): boolean {
  if (!ip) return false;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if (!Number.isFinite(first)) return false;
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    // 100.64.0.0/10：运营商级 NAT，同样视为"家园区/城域网内侧"
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 总体标准差（除以 n），与 mtr 的 StDev 口径一致。 */
export function stddev(values: number[]): number | null {
  if (values.length === 0) return null;
  const m = mean(values) as number;
  const variance = values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / values.length;
  return Math.sqrt(variance);
}

const round = (v: number, digits = 3): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

export function normalizeHop(raw: RawHop): HopResult {
  const samples = raw.samplesMs.filter((v) => Number.isFinite(v) && v >= 0);
  const avg = raw.avgMs !== undefined && Number.isFinite(raw.avgMs) ? raw.avgMs : mean(samples);
  const lost = Math.max(0, raw.lost);
  const lossPct =
    raw.lossPct !== undefined
      ? round(Math.max(0, Math.min(100, raw.lossPct)), 1)
      : lost + samples.length > 0
        ? round((lost / (lost + samples.length)) * 100, 1)
        : 100;
  return {
    ttl: raw.ttl,
    addresses: raw.addresses,
    ptr: raw.ptr,
    private: raw.addresses.some(isPrivateAddress),
    samplesMs: samples,
    avgMs: avg === null ? null : round(avg, 3),
    bestMs: samples.length > 0 ? round(Math.min(...samples), 3) : null,
    worstMs: samples.length > 0 ? round(Math.max(...samples), 3) : null,
    stddevMs:
      raw.stddevMs !== undefined && Number.isFinite(raw.stddevMs)
        ? round(raw.stddevMs, 3)
        : samples.length > 1
          ? round(stddev(samples) as number, 3)
          : null,
    lossPct,
    as: raw.as,
    geo: raw.geo ?? null,
    anonymous: samples.length === 0,
  };
}

/** 样本数 < 3 或存在丢包 → UI 标灰（数据不足，不作为手感依据）。 */
export function isGreyHop(hop: HopResult): boolean {
  return hop.samplesMs.length < 3 || hop.lossPct > 0;
}

const MAX_HOPS = 30;

export function buildTrace(rawHops: RawHop[], meta: TraceMeta): TraceResult {
  const sorted = rawHops
    .filter((h) => Number.isInteger(h.ttl) && h.ttl >= 1)
    .sort((a, b) => a.ttl - b.ttl);
  const truncated = meta.truncated === true || sorted.length > MAX_HOPS;
  const hops = (truncated ? sorted.slice(0, MAX_HOPS) : sorted).map(normalizeHop);
  const anonymous = hops.filter((h) => h.anonymous).length;

  // 目标补全：解析器没读到标题行时，用最后一跳的地址兜底。
  let target = meta.target;
  if (!target.ip) {
    const last = [...hops].reverse().find((h) => h.addresses.length > 0);
    target = { host: target.host || 'unknown', ip: last?.addresses[0] ?? null };
  }
  if (!target.host) target = { host: target.ip ?? 'unknown', ip: target.ip };
  if (!target.ip) target = { ...target, ip: null };

  return {
    schema: 'packet-orb/1',
    source: meta.source,
    capturedAt: meta.capturedAt,
    target,
    hops,
    quality: {
      parsed: hops.length,
      anonymous,
      confidence: round(Math.max(0, Math.min(0.99, meta.confidence ?? 0.5)), 3),
      truncated,
    },
  };
}

/**
 * 置信度：识别到标题 + 逐行命中率 + 跳数。识别失败时仍 >= 0，供 UI 展示。
 * 0.9 以上视为可信；< 0.5 提示用户改用 forceParse。
 */
export function scoreConfidence(input: {
  formatMatched: boolean;
  hopLines: number;
  hops: number;
  targetFound: boolean;
  truncated: boolean;
}): number {
  const ratio = input.hopLines > 0 ? input.hops / input.hopLines : 0;
  let score = 0.3;
  if (input.formatMatched) score += 0.25;
  score += 0.32 * Math.min(1, ratio);
  if (input.hops >= 2) score += 0.08;
  if (input.targetFound) score += 0.07;
  if (input.truncated) score -= 0.04;
  return Math.max(0.05, Math.min(0.99, score));
}
