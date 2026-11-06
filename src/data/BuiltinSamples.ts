/**
 * 内置样本库：**全部是合成测试夹具（synthetic fixture）**，不是真实网络测量。
 * 地址取自 RFC 5737 / RFC 1918 / RFC 6598 文档保留段，ASN 使用私有段 64512–65534，
 * UI 必须显示"内置合成样本"角标（source:"builtin" + synthetic:true）。
 *
 * 5 条样本覆盖设计稿第 6 节的戏型：
 *   0 骨干延迟（含坑洞/蹦床/发卡弯/断裂跳台，M0 手感基线）
 *   1 全雾样本（中段连续匿名 → 一条长迷雾隧道）
 *   2 高抖动样本（多段蹦床）
 *   3 跨洋样本（多次 ASN 切换 + 大幅 Δrtt 发卡弯）
 *   4 坏样本（中段重丢包 → 跳台 + 坑洞）
 */
import type { HopResult, TraceResult } from './Schema';
import { isPrivateAddress, mean, stddev } from './Normalizer';

interface HopOpts {
  as?: string;
  geo?: string;
  lossPct?: number;
}

function hop(ttl: number, ip: string | null, samples: number[], opts: HopOpts = {}): HopResult {
  const ordered = [...samples].sort((a, b) => a - b);
  const avg = mean(ordered);
  return {
    ttl,
    addresses: ip ? [ip] : [],
    ptr: null,
    private: ip ? isPrivateAddress(ip) : false,
    samplesMs: ordered,
    avgMs: avg === null ? null : Math.round(avg * 1000) / 1000,
    bestMs: ordered.length > 0 ? ordered[0] : null,
    worstMs: ordered.length > 0 ? ordered[ordered.length - 1] : null,
    stddevMs: stddev(ordered),
    lossPct: opts.lossPct ?? 0,
    as: opts.as ?? null,
    geo: opts.geo ?? null,
    anonymous: false,
  };
}

function anonHop(ttl: number): HopResult {
  return {
    ttl,
    addresses: [],
    ptr: null,
    private: false,
    samplesMs: [],
    avgMs: null,
    bestMs: null,
    worstMs: null,
    stddevMs: null,
    lossPct: 100,
    as: null,
    geo: null,
    anonymous: true,
  };
}

function trace(target: string, ip: string | null, hops: HopResult[]): TraceResult {
  return {
    schema: 'packet-orb/1',
    source: 'builtin',
    synthetic: true,
    capturedAt: '2026-11-05T00:00:00.000Z',
    target: { host: target, ip },
    hops,
    quality: {
      parsed: hops.length,
      anonymous: hops.filter((h) => h.anonymous).length,
      confidence: 1,
      truncated: false,
    },
  };
}

/** M0 手感基线：8 跳，覆盖私网起点、平路、上坡+坑洞、蹦床、下坡、发卡弯、断口、回落。 */
export const SYNTHETIC_8HOP: TraceResult = trace('backbone.example.test', '203.0.113.77', [
  hop(1, '192.168.1.1', [1.1, 1.2, 1.3], { geo: 'CN/WH' }),
  hop(2, '100.64.0.1', [4.6, 4.8, 5.0], { as: 'AS64500', geo: 'CN/WH' }),
  hop(3, '203.0.113.9', [22.1, 22.5, 22.6], { as: 'AS64500', geo: 'CN/WH', lossPct: 12 }),
  hop(4, '198.51.100.7', [17.0, 22.0, 34.8], { as: 'AS64500', geo: 'CN/WH', lossPct: 3 }),
  hop(5, '192.0.2.44', [10.9, 11.1, 11.6], { as: 'AS64510', geo: 'CN/SH' }),
  hop(6, '203.0.113.77', [85.2, 87.0, 90.0], { as: 'AS64510', geo: 'CN/SH', lossPct: 2 }),
  hop(7, '198.51.100.23', [28.9, 29.4, 31.1], { as: 'AS64510', geo: 'CN/SH', lossPct: 38 }),
  hop(8, '198.51.100.99', [8.4, 8.6, 8.8], { as: 'AS64520', geo: 'US/LA', lossPct: 4 }),
]);

/** 全雾样本：2–5 跳连续匿名，合并成一条迷雾隧道。 */
export const SYNTHETIC_FOG: TraceResult = trace('edge.example.test', '203.0.113.20', [
  hop(1, '192.168.1.1', [0.9, 1.0, 1.1], { geo: 'CN/WH' }),
  anonHop(2),
  anonHop(3),
  anonHop(4),
  anonHop(5),
  hop(6, '198.51.100.10', [26.0, 27.0, 28.0], { as: 'AS64501', geo: 'CN/SH' }),
  hop(7, '203.0.113.20', [29.0, 30.0, 31.0], { as: 'AS64540', geo: 'US/LA' }),
]);

/** 高抖动样本：多段 stddev > 5ms → 蹦床。 */
export const SYNTHETIC_JITTER: TraceResult = trace('jp.example.test', '203.0.113.30', [
  hop(1, '192.168.1.1', [0.8, 0.9, 1.0], { geo: 'CN/WH' }),
  hop(2, '10.0.0.1', [2.8, 3.0, 3.2], { as: 'AS64502', geo: 'CN/WH' }),
  hop(3, '203.0.113.31', [14.0, 18.0, 27.0], { as: 'AS64502', geo: 'CN/WH', lossPct: 6 }),
  hop(4, '198.51.100.41', [18.0, 26.0, 38.0], { as: 'AS64503', geo: 'JP/TY', lossPct: 8 }),
  hop(5, '198.51.100.42', [16.0, 27.0, 41.0], { as: 'AS64503', geo: 'JP/TY', lossPct: 4 }),
  hop(6, '203.0.113.30', [28.0, 31.0, 35.0], { as: 'AS64541', geo: 'JP/TY' }),
]);

/** 跨洋样本：180→300ms 的 Δrtt 触发发卡弯，ASN 三次切换。 */
export const SYNTHETIC_OCEAN: TraceResult = trace('ocean.example.test', '203.0.113.62', [
  hop(1, '192.168.1.1', [0.9, 1.0, 1.1], { geo: 'CN/WH' }),
  hop(2, '100.64.0.1', [3.8, 4.0, 4.2], { as: 'AS64504', geo: 'CN/WH' }),
  hop(3, '203.0.113.50', [11.0, 12.0, 13.0], { as: 'AS64504', geo: 'CN/WH' }),
  hop(4, '198.51.100.60', [176.0, 180.0, 184.0], { as: 'AS64505', geo: 'US/LA', lossPct: 2 }),
  hop(5, '198.51.100.61', [181.0, 185.0, 190.0], { as: 'AS64505', geo: 'US/LA', lossPct: 1 }),
  hop(6, '203.0.113.60', [295.0, 300.0, 306.0], { as: 'AS64506', geo: 'US/NY', lossPct: 3 }),
  hop(7, '203.0.113.61', [298.0, 305.0, 312.0], { as: 'AS64506', geo: 'US/NY', lossPct: 2 }),
  hop(8, '203.0.113.62', [288.0, 290.0, 293.0], { as: 'AS64507', geo: 'US/NY', lossPct: 0 }),
]);

/** 坏样本：中段匿名 + 62% 丢包跳台 + 12% 坑洞。 */
export const SYNTHETIC_BAD: TraceResult = trace('lossy.example.test', '203.0.113.72', [
  hop(1, '192.168.1.1', [1.0, 1.1, 1.2], { geo: 'CN/WH' }),
  anonHop(2),
  anonHop(3),
  hop(4, '203.0.113.70', [41.0, 45.0, 49.0], { as: 'AS64508', geo: 'CN/SH', lossPct: 62 }),
  hop(5, '203.0.113.71', [46.0, 48.0, 50.0], { as: 'AS64508', geo: 'CN/SH', lossPct: 12 }),
  hop(6, '203.0.113.72', [48.0, 50.0, 52.0], { as: 'AS64509', geo: 'CN/SH', lossPct: 8 }),
]);

export interface BuiltinSample {
  id: string;
  label: string;
  hint: string;
  synthetic: true;
  trace: TraceResult;
}

export const BUILTIN_SAMPLES: BuiltinSample[] = [
  {
    id: 'synthetic-8hop',
    label: '骨干高延迟（合成）',
    hint: '坑洞 / 蹦床 / 发卡弯 / 断裂跳台',
    synthetic: true,
    trace: SYNTHETIC_8HOP,
  },
  {
    id: 'synthetic-fog',
    label: '全雾中段（合成）',
    hint: '连续 4 跳匿名 → 单条迷雾隧道',
    synthetic: true,
    trace: SYNTHETIC_FOG,
  },
  {
    id: 'synthetic-jitter',
    label: '东京高抖动（合成）',
    hint: '多段蹦床，短路径',
    synthetic: true,
    trace: SYNTHETIC_JITTER,
  },
  {
    id: 'synthetic-ocean',
    label: '跨洋骨干（合成）',
    hint: '180→300ms 发卡弯 + ASN 关卡',
    synthetic: true,
    trace: SYNTHETIC_OCEAN,
  },
  {
    id: 'synthetic-bad',
    label: '坏样本（合成）',
    hint: '62% 丢包跳台 + 12% 坑洞',
    synthetic: true,
    trace: SYNTHETIC_BAD,
  },
];
