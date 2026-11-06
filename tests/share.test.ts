import { describe, expect, it } from 'vitest';
import { BUILTIN_SAMPLES } from '../src/data/BuiltinSamples';
import { decodeShare, encodeShare, readShareHash, shareHash } from '../src/data/ShareCodec';
import { solveLayout } from '../src/world/LayoutSolver';

describe('ShareCodec', () => {
  it('内置样本无损往返', () => {
    for (const sample of BUILTIN_SAMPLES) {
      const { code, degraded } = encodeShare(sample.trace);
      expect(degraded).toBe(false);
      expect(decodeShare(code)).toEqual(sample.trace);
    }
  });

  it('大 trace 超限后降级为摘要，仍能复现同一布局', () => {
    const trace = BUILTIN_SAMPLES[0].trace;
    const hops = Array.from({ length: 30 }, (_, i) => ({
      ...trace.hops[i % trace.hops.length],
      ttl: i + 1,
      addresses: [`10.20.${i}.${i + 1}`],
      samplesMs: [1.1, 2.2, 3.3, 4.4],
    }));
    const big = { ...trace, hops };
    const { code, degraded } = encodeShare(big, 700);
    expect(degraded).toBe(true);
    const restored = decodeShare(code);
    expect(restored).not.toBeNull();
    expect(restored?.hops.length).toBe(30);
    expect(restored?.quality.truncated).toBe(true);

    const a = solveLayout(big);
    const b = solveLayout(restored!);
    expect(b.totalLength).toBeCloseTo(a.totalLength, 3);
    expect(b.nodes.length).toBe(a.nodes.length);
    expect(b.zones.length).toBe(a.zones.length);
  });

  it('正常大小不降级且 code 可控', () => {
    const { code, degraded, bytes } = encodeShare(BUILTIN_SAMPLES[3].trace);
    expect(degraded).toBe(false);
    expect(bytes).toBe(code.length);
    expect(code.length).toBeLessThan(8192);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hash 读写与坏数据', () => {
    const trace = BUILTIN_SAMPLES[1].trace;
    const hash = shareHash(trace);
    expect(hash.startsWith('#t=')).toBe(true);
    expect(readShareHash(hash)).toEqual(trace);
    expect(decodeShare('not-a-real-code')).toBeNull();
    expect(readShareHash('#t=')).toBeNull();
    expect(readShareHash('')).toBeNull();
  });
});
