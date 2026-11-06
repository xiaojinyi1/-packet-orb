/**
 * 分享编码：TraceResult → URL hash。
 *
 * 不新增依赖：自己实现 LZSS（4KB 窗口 / 3–18 字节匹配）+ base64url。
 * 编码超过 8KB 时降级为「target + 每跳摘要」，摘要保留布局必需的字段
 * （ttl / 地址 / 平均 RTT / 丢包 / 抖动 / AS / 城市 / 匿名 / 私网），
 * 因此降级链接仍能复现同一个迷宫，只是丢掉了逐次采样细节。
 */
import type { HopResult, TraceResult } from './Schema';

const MAGIC_0 = 0x50; // 'P'
const MAGIC_1 = 0x4f; // 'O'
const VERSION = 1;
const WINDOW = 4096;
const MIN_MATCH = 3;
const MAX_MATCH = 18;
const DEFAULT_MAX_BYTES = 8192;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i += 1) table[B64.charCodeAt(i)] = i;
  return table;
})();

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/g, '');
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) return null;
  const size = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_LOOKUP[clean.charCodeAt(i)];
    const c1 = B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c2 = i + 2 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const c3 = i + 3 < clean.length ? B64_LOOKUP[clean.charCodeAt(i + 3)] : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < size) out[o++] = (n >> 16) & 255;
    if (o < size) out[o++] = (n >> 8) & 255;
    if (o < size) out[o++] = n & 255;
  }
  return out;
}

/** LZSS：输出 ['P','O',版本, flag, tokens...]。 */
function compressBytes(input: Uint8Array): Uint8Array {
  const out: number[] = [MAGIC_0, MAGIC_1, VERSION];
  const heads = new Int32Array(1 << 16).fill(-1);
  let i = 0;
  while (i < input.length) {
    const flagIndex = out.length;
    out.push(0);
    let flags = 0;
    for (let bit = 0; bit < 8 && i < input.length; bit += 1) {
      let bestLen = 0;
      let bestDist = 0;
      if (i + MIN_MATCH <= input.length) {
        const key = (input[i] << 16) | (input[i + 1] << 8) | input[i + 2];
        const slot = ((key * 2654435761) >>> 16) & 0xffff;
        const cand = heads[slot];
        if (cand >= 0 && i - cand <= WINDOW) {
          const limit = Math.min(MAX_MATCH, input.length - i);
          let len = 0;
          while (len < limit && input[cand + len] === input[i + len]) len += 1;
          if (len >= MIN_MATCH) {
            bestLen = len;
            bestDist = i - cand;
          }
        }
        heads[slot] = i;
      }
      if (bestLen >= MIN_MATCH) {
        flags |= 1 << bit;
        const code = ((bestLen - MIN_MATCH) << 12) | (bestDist - 1);
        out.push(code & 255, (code >> 8) & 255);
        i += bestLen;
      } else {
        out.push(input[i]);
        i += 1;
      }
    }
    out[flagIndex] = flags;
  }
  return new Uint8Array(out);
}

function decodeCompressed(input: Uint8Array): Uint8Array | null {
  if (input.length < 4) return null;
  if (input[0] !== MAGIC_0 || input[1] !== MAGIC_1 || input[2] !== VERSION) return null;
  const out: number[] = [];
  let i = 3;
  while (i < input.length) {
    const flags = input[i++];
    for (let bit = 0; bit < 8 && i < input.length; bit += 1) {
      if (flags & (1 << bit)) {
        if (i + 1 >= input.length) return null;
        const code = input[i] | (input[i + 1] << 8);
        i += 2;
        const dist = (code & 0xfff) + 1;
        const len = (code >> 12) + MIN_MATCH;
        const start = out.length - dist;
        if (start < 0) return null;
        for (let k = 0; k < len; k += 1) {
          out.push(out[start + k]);
        }
      } else {
        out.push(input[i++]);
      }
    }
  }
  return new Uint8Array(out);
}

interface PackedHop {
  t: number;
  a: string[];
  p: string | null;
  v: number; // private 0/1
  s: number[];
  m: number | null;
  b: number | null;
  w: number | null;
  d: number | null;
  l: number;
  as: string | null;
  g: string | null;
  n: number; // anonymous 0/1
}

interface PackedTrace {
  v: 1;
  s: TraceResult['source'];
  c: string;
  t: [string, string | null];
  q: [number, number, number, boolean];
  y?: 1;
  h: PackedHop[];
}

interface PackedSummary {
  v: 1;
  d: 1;
  s: TraceResult['source'];
  c: string;
  t: [string, string | null];
  q: [number, number, number, boolean];
  y?: 1;
  h: Array<[number, string | null, number | null, number, number | null, string | null, string | null, number, number]>;
}

function packTrace(trace: TraceResult): PackedTrace {
  return {
    v: 1,
    s: trace.source,
    c: trace.capturedAt,
    t: [trace.target.host, trace.target.ip],
    q: [trace.quality.parsed, trace.quality.anonymous, trace.quality.confidence, trace.quality.truncated],
    ...(trace.synthetic ? { y: 1 as const } : {}),
    h: trace.hops.map((hop) => ({
      t: hop.ttl,
      a: hop.addresses,
      p: hop.ptr,
      v: hop.private ? 1 : 0,
      s: hop.samplesMs,
      m: hop.avgMs,
      b: hop.bestMs,
      w: hop.worstMs,
      d: hop.stddevMs,
      l: hop.lossPct,
      as: hop.as,
      g: hop.geo,
      n: hop.anonymous ? 1 : 0,
    })),
  };
}

function packSummary(trace: TraceResult): PackedSummary {
  return {
    v: 1,
    d: 1,
    s: trace.source,
    c: trace.capturedAt,
    t: [trace.target.host, trace.target.ip],
    q: [trace.quality.parsed, trace.quality.anonymous, trace.quality.confidence, true],
    ...(trace.synthetic ? { y: 1 as const } : {}),
    h: trace.hops.map((hop) => [
      hop.ttl,
      hop.addresses[0] ?? null,
      hop.avgMs,
      hop.lossPct,
      hop.stddevMs,
      hop.as,
      hop.geo,
      hop.anonymous ? 1 : 0,
      hop.private ? 1 : 0,
    ]),
  };
}

function bytesToCode(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

/** 编码；超过 maxBytes 时自动降级为摘要。 */
export function encodeShare(
  trace: TraceResult,
  maxBytes = DEFAULT_MAX_BYTES,
): { code: string; bytes: number; degraded: boolean } {
  const full = bytesToCode(compressBytes(new TextEncoder().encode(JSON.stringify(packTrace(trace)))));
  if (full.length <= maxBytes) return { code: full, bytes: full.length, degraded: false };
  const summary = bytesToCode(compressBytes(new TextEncoder().encode(JSON.stringify(packSummary(trace)))));
  return { code: summary, bytes: summary.length, degraded: true };
}

function unpackHop(hop: PackedHop): HopResult {
  return {
    ttl: hop.t,
    addresses: hop.a,
    ptr: hop.p,
    private: hop.v === 1,
    samplesMs: hop.s,
    avgMs: hop.m,
    bestMs: hop.b,
    worstMs: hop.w,
    stddevMs: hop.d,
    lossPct: hop.l,
    as: hop.as,
    geo: hop.g,
    anonymous: hop.n === 1,
  };
}

/** 解码失败（格式不对 / 损坏）返回 null，调用方回退到默认样本。 */
export function decodeShare(code: string): TraceResult | null {
  const bytes = fromBase64Url(code);
  if (!bytes) return null;
  const plain = decodeCompressed(bytes);
  if (!plain) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const packed = parsed as Partial<PackedTrace & PackedSummary>;
  if (packed.v !== 1 || !Array.isArray(packed.h) || !packed.t) return null;
  const quality = Array.isArray(packed.q)
    ? {
        parsed: Number(packed.q[0]) || 0,
        anonymous: Number(packed.q[1]) || 0,
        confidence: Number(packed.q[2]) || 0,
        truncated: Boolean(packed.q[3]),
      }
    : { parsed: packed.h.length, anonymous: 0, confidence: 0.5, truncated: false };

  if (packed.d === 1) {
    const hops: HopResult[] = (packed.h as PackedSummary['h']).map((row) => {
      const [ttl, addr, avg, loss, sd, as, geo, anon, priv] = row;
      const samples = avg === null ? [] : [avg];
      return {
        ttl,
        addresses: addr ? [addr] : [],
        ptr: null,
        private: priv === 1,
        samplesMs: samples,
        avgMs: avg,
        bestMs: avg,
        worstMs: avg,
        stddevMs: sd,
        lossPct: loss,
        as,
        geo,
        anonymous: anon === 1,
      };
    });
    return {
      schema: 'packet-orb/1',
      source: packed.s ?? 'paste',
      capturedAt: packed.c ?? new Date(0).toISOString(),
      target: { host: packed.t[0] ?? 'unknown', ip: packed.t[1] ?? null },
      hops,
      quality: { ...quality, truncated: true },
      ...(packed.y === 1 ? { synthetic: true } : {}),
    };
  }

  const hops = (packed.h as PackedHop[]).map(unpackHop);
  return {
    schema: 'packet-orb/1',
    source: packed.s ?? 'paste',
    capturedAt: packed.c ?? new Date(0).toISOString(),
    target: { host: packed.t[0] ?? 'unknown', ip: packed.t[1] ?? null },
    hops,
    quality,
    ...(packed.y === 1 ? { synthetic: true } : {}),
  };
}

/** 从 location.hash 里取出 `#t=<code>`（也接受裸 code）。 */
export function readShareHash(hash: string): TraceResult | null {
  const raw = hash.replace(/^#/, '').trim();
  if (!raw) return null;
  const code = raw.startsWith('t=') ? raw.slice(2) : raw;
  if (!code) return null;
  return decodeShare(code);
}

export function shareHash(trace: TraceResult, maxBytes = DEFAULT_MAX_BYTES): string {
  return `#t=${encodeShare(trace, maxBytes).code}`;
}
