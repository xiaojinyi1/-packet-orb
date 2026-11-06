/**
 * 数据 → 空间映射的**唯一实现处**（CLAUDE.md「数据→空间映射」）。
 *
 * 本文件只做纯数学：输入 TraceResult，输出中心线与特征区间，不碰 three / rapier。
 * 段长 = 12 + 8·sqrt(avgMs)；Δrtt>15ms 上坡 6~12°；Δrtt<-10ms 下坡；
 * Δrtt>60ms 发卡弯；loss 10~30% 坑洞；loss>30% 断裂跳台；jitter>5ms 蹦床。
 */
import type { TraceResult, HopResult } from '../data/Schema';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 灰盒地形尺寸（玩法常量，不是美术资产）。 */
export const TERRAIN = {
  width: 9,
  wallHeight: 1.1,
  sampleStep: 0.5,
  pitDepth: 0.55,
  pitLength: 7,
  pitRampLength: 2.4,
  trampolineLength: 8,
  trampolineWidthRatio: 0.72,
  kickerLength: 10,
  kickerRise: 3,
  jumpGap: 2.2,
  landingLength: 15,
  landingDrop: 0.35,
  spawnHeight: 0.9,
  fallDepth: 25,
} as const;

export type FeatureKind = 'pit' | 'trampoline' | 'jump';
export type SpanKind = 'road' | FeatureKind;

export interface LayoutSpan {
  index: number;
  ttlStart: number;
  ttlEnd: number;
  /** 公式段长，米。 */
  length: number;
  pitchDeg: number;
  /** 段内累计偏航，度；>60ms 的 Δrtt 触发 ±150° 发卡弯。 */
  turnDeg: number;
  kind: SpanKind;
  /** 全局弧长区间。 */
  sStart: number;
  sEnd: number;
  avgMs: number;
  lossPct: number;
  stddevMs: number | null;
  /** kind=pit/trampoline 时该特征在本段内的弧长区间（全局 s）。 */
  featureStartS: number | null;
  featureEndS: number | null;
  /** kind=jump 时的三处关键弧长（全局 s）。 */
  kickerStartS: number | null;
  gapStartS: number | null;
  gapEndS: number | null;
  landingEndS: number | null;
}

export interface PathSample {
  s: number;
  x: number;
  y: number;
  z: number;
  /** 单位切线。 */
  tx: number;
  ty: number;
  tz: number;
  /** 单位横向（水平）。 */
  sx: number;
  sy: number;
  sz: number;
  /** 单位上方向（随坡度倾斜）。 */
  ux: number;
  uy: number;
  uz: number;
  spanIndex: number;
  /** 跳台断口上的采样点：没有路面，只用于弧长连续性。 */
  gap: boolean;
  /** 断裂跳台的落地区。 */
  landing: boolean;
}

export interface LayoutFeature {
  kind: FeatureKind;
  spanIndex: number;
  startS: number;
  endS: number;
  /** 仅坑洞：凹陷深度。 */
  depth: number;
}

/** 每跳一个节点（路牌 / 建筑顶灯 / HUD 用），位置在跳对应的主干点上。 */
export interface LayoutNode {
  ttl: number;
  index: number;
  s: number;
  x: number;
  y: number;
  z: number;
  addresses: string[];
  anonymous: boolean;
  as: string | null;
  geo: string | null;
}

/** ASN（缺失时用 geo，再缺失按 TTL 均分）切出来的区段。 */
export interface LayoutZone {
  index: number;
  key: string;
  ttlStart: number;
  ttlEnd: number;
  startS: number;
  endS: number;
  color: string;
}

/** 连续匿名跳合并成的迷雾隧道；>=4 跳才生成，避免重复雾墙。 */
export interface FogTunnel {
  index: number;
  ttlStart: number;
  ttlEnd: number;
  startS: number;
  endS: number;
}

export type DecorationKind = 'pit' | 'trampoline' | 'jump' | 'gate' | 'fog' | 'finish';

export interface LayoutDecoration {
  kind: DecorationKind;
  spanIndex: number;
  startS: number;
  endS: number;
  color: string;
}

export const ZONE_COLORS = ['#2ED3C6', '#FF7A45', '#FF2E88', '#FFE447', '#8F86FF'] as const;

export interface Layout {
  width: number;
  totalLength: number;
  spans: LayoutSpan[];
  samples: PathSample[];
  features: LayoutFeature[];
  nodes: LayoutNode[];
  zones: LayoutZone[];
  fogTunnels: FogTunnel[];
  decorations: LayoutDecoration[];
  spawn: Vec3;
  checkpoints: Vec3[];
  minY: number;
  maxY: number;
  /** 掉出世界的最低下落判定线。 */
  fallY: number;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

/** 段长公式：禁止线性映射，跨洋 300ms 不能拉出 2km。 */
export function segmentLength(avgMs: number | null): number {
  const ms = avgMs === null || !Number.isFinite(avgMs) || avgMs < 0 ? 0 : avgMs;
  return 12 + 8 * Math.sqrt(ms);
}

/** Δrtt → 坡度（度）。>15ms 上坡 6~12°，<-10ms 下坡 6~10°。 */
export function pitchForDelta(deltaMs: number | null): number {
  if (deltaMs === null || !Number.isFinite(deltaMs)) return 0;
  if (deltaMs > 15) {
    const t = clamp((Math.min(deltaMs, 60) - 15) / 45, 0, 1);
    return 6 + 6 * t;
  }
  if (deltaMs < -10) {
    const t = clamp((Math.min(-deltaMs, 60) - 10) / 50, 0, 1);
    return -(6 + 4 * t);
  }
  return 0;
}

/** Δrtt > 60ms → 发卡弯；方向按段序交替，避免所有弯都朝同一侧。 */
export function turnForDelta(deltaMs: number | null, spanIndex: number): number {
  if (deltaMs === null || !Number.isFinite(deltaMs) || deltaMs <= 60) return 0;
  return 150 * (spanIndex % 2 === 0 ? 1 : -1);
}

/** lossPct / jitter → 段类型。匿名跳不给坑/跳台，交给迷雾隧道处理。 */
export function spanKindForHop(hop: HopResult): SpanKind {
  if (hop.anonymous) return 'road';
  if (hop.lossPct >= 30) return 'jump';
  if (hop.lossPct >= 10) return 'pit';
  if (hop.stddevMs !== null && hop.stddevMs > 5) return 'trampoline';
  return 'road';
}

function makePoint(s: number, x: number, y: number, z: number, spanIndex: number, gap: boolean, landing: boolean) {
  return { s, x, y, z, spanIndex, gap, landing };
}

type RawPoint = ReturnType<typeof makePoint>;

export function solveLayout(trace: TraceResult): Layout {
  const hops = trace.hops;
  if (hops.length < 2) throw new Error('LayoutSolver: 至少需要 2 跳才能生成主干道');

  const spans: LayoutSpan[] = [];
  const points: RawPoint[] = [];
  const features: LayoutFeature[] = [];

  let pos = { x: 0, y: 0, z: 0 };
  let heading = 0;
  let s = 0;
  points.push(makePoint(0, 0, 0, 0, 0, false, false));

  for (let i = 0; i < hops.length - 1; i += 1) {
    const from = hops[i];
    const to = hops[i + 1];
    const deltaMs = from.avgMs !== null && to.avgMs !== null ? to.avgMs - from.avgMs : null;
    const length = segmentLength(to.avgMs);
    const pitchDeg = pitchForDelta(deltaMs);
    const turnDeg = turnForDelta(deltaMs, i);
    const kind = spanKindForHop(to);
    const sStart = s;
    const sEnd = sStart + length;

    const span: LayoutSpan = {
      index: i,
      ttlStart: from.ttl,
      ttlEnd: to.ttl,
      length,
      pitchDeg,
      turnDeg,
      kind,
      sStart,
      sEnd,
      avgMs: to.avgMs ?? 0,
      lossPct: to.lossPct,
      stddevMs: to.stddevMs,
      featureStartS: null,
      featureEndS: null,
      kickerStartS: null,
      gapStartS: null,
      gapEndS: null,
      landingEndS: null,
    };

    if (kind === 'pit' || kind === 'trampoline') {
      const featureLength = Math.min(
        kind === 'pit' ? TERRAIN.pitLength : TERRAIN.trampolineLength,
        Math.max(2, length * 0.5),
      );
      const center = sStart + length * 0.5;
      span.featureStartS = center - featureLength / 2;
      span.featureEndS = center + featureLength / 2;
      features.push({
        kind,
        spanIndex: i,
        startS: span.featureStartS,
        endS: span.featureEndS,
        depth: kind === 'pit' ? TERRAIN.pitDepth : 0,
      });
    }

    if (kind === 'jump') {
      const kickerLength = Math.min(TERRAIN.kickerLength, length * 0.45);
      span.kickerStartS = sEnd - kickerLength;
      features.push({
        kind: 'jump',
        spanIndex: i,
        startS: span.kickerStartS,
        endS: sEnd + TERRAIN.jumpGap + TERRAIN.landingLength,
        depth: TERRAIN.landingDrop,
      });
    }

    // —— 段内采样：坡度 + 弧线转向 + 特征高度 ——
    const n = Math.max(2, Math.round(length / TERRAIN.sampleStep));
    const ds = length / n;
    const pitchRad = pitchDeg * DEG;
    const turnRad = turnDeg * DEG;
    const dHeading = turnRad / n;
    const pitDepth = kind === 'pit' ? TERRAIN.pitDepth : 0;

    for (let k = 0; k < n; k += 1) {
      const sLocal = k * ds;
      const extraSlope =
        kind === 'jump' && span.kickerStartS !== null && sStart + sLocal >= span.kickerStartS
          ? TERRAIN.kickerRise / Math.max(1e-6, sEnd - span.kickerStartS)
          : 0;
      const dip = pitDepth > 0 ? pitOffset(sStart + sLocal, span) : 0;
      const dipNext = pitDepth > 0 ? pitOffset(sStart + sLocal + ds, span) : 0;
      const midHeading = heading + dHeading * 0.5;
      pos = {
        x: pos.x + Math.sin(midHeading) * ds,
        y: pos.y + Math.tan(pitchRad) * ds + extraSlope * ds + (dipNext - dip),
        z: pos.z + Math.cos(midHeading) * ds,
      };
      heading += dHeading;
      s += ds;
      points.push(makePoint(s, pos.x, pos.y, pos.z, i, false, false));
    }

    if (kind === 'jump' && span.kickerStartS !== null) {
      // 断口：无路面的空中段，保持起跳高度继续累积弧长。
      const gapStart = s;
      span.gapStartS = gapStart;
      const gapSteps = Math.max(2, Math.round(TERRAIN.jumpGap / TERRAIN.sampleStep));
      const gapDs = TERRAIN.jumpGap / gapSteps;
      const launchY = pos.y;
      for (let k = 0; k < gapSteps; k += 1) {
        pos = {
          x: pos.x + Math.sin(heading) * gapDs,
          y: launchY,
          z: pos.z + Math.cos(heading) * gapDs,
        };
        s += gapDs;
        points.push(makePoint(s, pos.x, pos.y, pos.z, i, true, false));
      }
      span.gapEndS = s;
      const landingStartY = launchY - TERRAIN.landingDrop;
      pos = { x: pos.x, y: landingStartY, z: pos.z };
      const landSteps = Math.max(2, Math.round(TERRAIN.landingLength / TERRAIN.sampleStep));
      const landDs = TERRAIN.landingLength / landSteps;
      for (let k = 0; k < landSteps; k += 1) {
        pos = {
          x: pos.x + Math.sin(heading) * landDs,
          y: landingStartY,
          z: pos.z + Math.cos(heading) * landDs,
        };
        s += landDs;
        points.push(makePoint(s, pos.x, pos.y, pos.z, i, false, true));
      }
      span.landingEndS = s;
    }

    spans.push(span);
  }

  // —— 采样点框架（切线 / 横向 / 上向） ——
  const samples: PathSample[] = points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    let tz = next.z - prev.z;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // side = worldUp × tangent（水平）
    let sx = tz;
    let sz = -tx;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl;
    sz /= sl;
    // up = tangent × side
    let ux = ty * sz - tz * 0;
    let uy = tz * sx - tx * sz;
    let uz = tx * 0 - ty * sx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    return {
      s: p.s,
      x: p.x,
      y: p.y,
      z: p.z,
      tx,
      ty,
      tz,
      sx,
      sy: 0,
      sz,
      ux,
      uy,
      uz,
      spanIndex: p.spanIndex,
      gap: p.gap,
      landing: p.landing,
    };
  });

  // —— 检查点：每段起点（跳台前必然有一个，掉下去从最近段起点重来） ——
  const checkpoints: Vec3[] = [];
  for (const span of spans) {
    const sample = sampleAtS(samples, span.sStart);
    if (!sample) continue;
    const last = checkpoints[checkpoints.length - 1];
    if (last && Math.hypot(last.x - sample.x, last.z - sample.z) < 1) continue;
    checkpoints.push({
      x: sample.x,
      y: sample.y + TERRAIN.spawnHeight,
      z: sample.z,
    });
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const totalLength = s;

  // —— 每跳一个节点：路牌、建筑顶灯、HUD 都读这里 ——
  const nodes: LayoutNode[] = hops.map((h, i) => {
    const at = i === 0 ? 0 : spans[i - 1].sEnd;
    const p = sampleAtS(samples, at) ?? samples[0];
    return {
      ttl: h.ttl,
      index: i,
      s: at,
      x: p.x,
      y: p.y,
      z: p.z,
      addresses: h.addresses,
      anonymous: h.anonymous,
      as: h.as,
      geo: h.geo,
    };
  });

  // —— ASN 分区：as → geo → 按 TTL 均分（缺失时的兜底），连续同键合并 ——
  const zones: LayoutZone[] = [];
  const bucket = Math.max(1, Math.ceil(hops.length / 4));
  const keyOf = (h: HopResult, i: number): string => h.as ?? h.geo ?? `ttl-${Math.floor(i / bucket)}`;
  for (let i = 0; i < hops.length; i += 1) {
    const key = keyOf(hops[i], i);
    let j = i;
    while (j + 1 < hops.length && keyOf(hops[j + 1], j + 1) === key) j += 1;
    const startS = Math.min(totalLength, i === 0 ? 0 : spans[i - 1].sEnd);
    const endS = Math.max(startS, j >= spans.length ? totalLength : spans[j].sEnd);
    zones.push({
      index: zones.length,
      key,
      ttlStart: hops[i].ttl,
      ttlEnd: hops[j].ttl,
      startS,
      endS,
      color: ZONE_COLORS[zones.length % ZONE_COLORS.length],
    });
    i = j;
  }

  // 末跳没有出站段：单独成区时长度为 0，把最后一个区间让给它（终点 AS 的颜色覆盖最后一段进近）
  const tailZone = zones[zones.length - 1];
  if (tailZone && tailZone.index > 0 && tailZone.endS - tailZone.startS < 1 && spans.length >= 2) {
    const newStart = spans[spans.length - 2].sEnd;
    const prev = zones[zones.length - 2];
    if (prev && newStart > prev.startS) {
      prev.endS = newStart;
      tailZone.startS = newStart;
      tailZone.endS = totalLength;
    }
  }

  // —— 连续匿名跳 → 单条迷雾隧道（>=4 跳；短匿名段不生成雾墙） ——
  const fogTunnels: FogTunnel[] = [];
  for (let i = 0; i < hops.length; i += 1) {
    if (!hops[i].anonymous) continue;
    let j = i;
    while (j + 1 < hops.length && hops[j + 1].anonymous) j += 1;
    if (j - i + 1 >= 4) {
      const startS = Math.min(totalLength, i === 0 ? 0 : spans[i - 1].sEnd);
      const endS = Math.max(startS, j === 0 ? startS : spans[j - 1].sEnd);
      if (endS > startS + 1) {
        fogTunnels.push({
          index: fogTunnels.length,
          ttlStart: hops[i].ttl,
          ttlEnd: hops[j].ttl,
          startS,
          endS,
        });
      }
    }
    i = j;
  }

  // —— 装饰语义：特征 / 关卡门 / 雾隧道 / 终点门 ——
  const decorations: LayoutDecoration[] = features.map((f) => ({
    kind: f.kind,
    spanIndex: f.spanIndex,
    startS: f.startS,
    endS: f.endS,
    color: f.kind === 'pit' ? '#8b8274' : f.kind === 'trampoline' ? '#ff2e88' : '#ff7a45',
  }));
  for (const zone of zones.slice(1)) {
    decorations.push({
      kind: 'gate',
      spanIndex: Math.max(0, zone.index - 1),
      startS: zone.startS,
      endS: zone.startS,
      color: zone.color,
    });
  }
  for (const tunnel of fogTunnels) {
    decorations.push({ kind: 'fog', spanIndex: 0, startS: tunnel.startS, endS: tunnel.endS, color: '#0b0818' });
  }
  decorations.push({
    kind: 'finish',
    spanIndex: spans.length - 1,
    startS: Math.max(0, totalLength - 4),
    endS: totalLength,
    color: '#ffe447',
  });

  // 出生点放在起点封口墙之后（墙在 s=0），否则球会卡进墙里被弹飞
  const spawnSample = sampleAtS(samples, 9) ?? samples[0];

  return {
    width: TERRAIN.width,
    totalLength,
    spans,
    samples,
    features,
    nodes,
    zones,
    fogTunnels,
    decorations,
    spawn: { x: spawnSample.x, y: spawnSample.y + TERRAIN.spawnHeight, z: spawnSample.z },
    checkpoints,
    minY,
    maxY,
    fallY: minY - TERRAIN.fallDepth,
  };
}

/** 坑洞剖面：0 → 深 → 0 的梯形凹陷，入口/出口各 1.5m 斜坡。 */
function pitOffset(s: number, span: LayoutSpan): number {
  if (span.featureStartS === null || span.featureEndS === null) return 0;
  if (s <= span.featureStartS || s >= span.featureEndS) return 0;
  const t = s - span.featureStartS;
  const u = span.featureEndS - s;
  const ramp = TERRAIN.pitRampLength;
  return -TERRAIN.pitDepth * clamp(Math.min(t, u) / ramp, 0, 1);
}

/** 二分查找最近于弧长 s 的采样点。 */
export function sampleAtS(samples: PathSample[], s: number): PathSample | null {
  if (samples.length === 0) return null;
  let lo = 0;
  let hi = samples.length - 1;
  if (s <= samples[0].s) return samples[0];
  if (s >= samples[hi].s) return samples[hi];
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= s) lo = mid;
    else hi = mid;
  }
  return s - samples[lo].s <= samples[hi].s - s ? samples[lo] : samples[hi];
}

/** 用弧长取路面点（跳过跳台断口）。 */
export function drivableSampleAtS(samples: PathSample[], s: number): PathSample | null {
  const base = sampleAtS(samples, s);
  if (!base) return null;
  const idx = samples.indexOf(base);
  const dir = idx + 1 < samples.length && samples[idx + 1].s > s ? 1 : -1;
  for (let i = idx, guard = 0; i >= 0 && i < samples.length && guard < 200; i += dir, guard += 1) {
    if (!samples[i].gap) return samples[i];
  }
  return null;
}

/** 相机 / 调试用的最近路面高度；只用水平距离，误差在 9m 宽路面内可接受。 */
export function groundAt(layout: Layout, x: number, z: number): number | null {
  let best: PathSample | null = null;
  let bestD = Infinity;
  for (const p of layout.samples) {
    if (p.gap) continue;
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? best.y : null;
}

/** 最近的可行路面采样点（自动测试 / DEV 自动驾驶用）。 */
export function nearestSample(layout: Layout, x: number, z: number, includeGap = false): PathSample | null {
  let best: PathSample | null = null;
  let bestD = Infinity;
  for (const p of layout.samples) {
    if (p.gap && !includeGap) continue;
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** 弧长 → 段序号。 */
export function spanIndexAtS(layout: Layout, s: number): number {
  for (let i = layout.spans.length - 1; i >= 0; i -= 1) {
    if (s >= layout.spans[i].sStart) return i;
  }
  return 0;
}

/** 弧长 → 分区（ASN / geo / TTL 兜底）。 */
export function zoneAtS(layout: Layout, s: number): LayoutZone {
  for (let i = layout.zones.length - 1; i >= 0; i -= 1) {
    if (s >= layout.zones[i].startS) return layout.zones[i];
  }
  return layout.zones[0] ?? {
    index: 0,
    key: 'unknown',
    ttlStart: 1,
    ttlEnd: 1,
    startS: 0,
    endS: 0,
    color: ZONE_COLORS[0],
  };
}
