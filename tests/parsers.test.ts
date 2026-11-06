import { describe, expect, it } from 'vitest';
import linuxRaw from './fixtures/linux_traceroute.txt?raw';
import windowsRaw from './fixtures/windows_tracert.txt?raw';
import mtrRaw from './fixtures/mtr_report.txt?raw';
import { parseTrace } from '../src/data/PasteParser';
import { BUILTIN_SAMPLES, SYNTHETIC_FOG, SYNTHETIC_OCEAN } from '../src/data/BuiltinSamples';
import { solveLayout, zoneAtS } from '../src/world/LayoutSolver';

describe('PasteParser — 三段真实夹具', () => {
  it('解析 Unix traceroute（含 -A、全 *、每跳 1~3 样本、续行）', () => {
    const out = parseTrace(linuxRaw);
    expect(out.error).toBeUndefined();
    expect(out.format).toBe('traceroute');
    const trace = out.trace!;
    expect(trace.hops).toHaveLength(7);
    expect(trace.target.host).toBe('www.example.com');
    expect(trace.target.ip).toBe('104.16.132.249');

    expect(trace.hops[0].samplesMs).toHaveLength(3);
    expect(trace.hops[0].avgMs).toBeCloseTo(1.264, 2);
    expect(trace.hops[2].anonymous).toBe(true);
    expect(trace.hops[2].lossPct).toBe(100);
    expect(trace.hops[3].as).toBe('AS4134');
    expect(trace.hops[3].addresses[0]).toBe('202.97.60.1');
    expect(trace.hops[4].anonymous).toBe(true);
    expect(trace.hops[5].samplesMs).toHaveLength(2);
    expect(trace.hops[5].lossPct).toBeCloseTo(33.33, 1);
    expect(trace.hops[6].ptr).toBe('www.example.com');
    expect(trace.quality.parsed).toBe(7);
    expect(out.confidence).toBeGreaterThan(0.6);
  });

  it('解析 Windows tracert（跳过中文标题 / 请求超时 / Trace complete）', () => {
    const out = parseTrace(windowsRaw);
    expect(out.error).toBeUndefined();
    expect(out.format).toBe('tracert');
    const trace = out.trace!;
    expect(trace.hops).toHaveLength(5);
    expect(trace.hops[0].addresses[0]).toBe('192.168.1.1');
    expect(trace.hops[2].samplesMs).toHaveLength(2);
    expect(trace.hops[2].lossPct).toBeCloseTo(33.33, 1);
    expect(trace.hops[3].anonymous).toBe(true);
    expect(trace.hops[4].avgMs).toBeCloseTo(165, 0);
    expect(trace.quality.anonymous).toBe(1);
  });

  it('解析 mtr -r 宽表（Loss% / Snt / Avg / StDev / ???）', () => {
    const out = parseTrace(mtrRaw);
    expect(out.error).toBeUndefined();
    expect(out.format).toBe('mtr-report');
    const trace = out.trace!;
    expect(trace.hops).toHaveLength(5);
    expect(trace.hops[1].avgMs).toBeCloseTo(9.5, 1);
    expect(trace.hops[2].anonymous).toBe(true);
    expect(trace.hops[2].lossPct).toBe(100);
    expect(trace.hops[3].lossPct).toBe(30);
    expect(trace.hops[3].stddevMs).toBeCloseTo(7.2, 1);
    expect(trace.quality.truncated).toBe(false);
  });

  it('跳数 >30 时截断并标记 truncated', () => {
    const lines = ['traceroute to trunc.example.test (198.51.100.9), 64 hops max, 60 byte packets'];
    for (let ttl = 1; ttl <= 35; ttl += 1) {
      lines.push(` ${ttl}  10.0.${ttl}.1 (10.0.${ttl}.1)  ${ttl}.1 ms  ${ttl}.2 ms  ${ttl}.3 ms`);
    }
    const out = parseTrace(lines.join('\n'));
    expect(out.trace).toBeDefined();
    expect(out.trace!.hops).toHaveLength(30);
    expect(out.trace!.quality.truncated).toBe(true);
  });

  it('无法识别时给出错误而不是抛异常；forceParse 也不伪造成功', () => {
    const out = parseTrace('hello world\nthis is not a trace');
    expect(out.trace).toBeNull();
    expect(out.error).toContain('traceroute');
    const forced = parseTrace('hello world\nthis is not a trace', { forceParse: true });
    expect(forced.trace).toBeNull();
  });
});

describe('LayoutSolver — 匿名合并 / 分区 / 装饰', () => {
  it('连续 4 跳匿名只生成一条迷雾隧道', () => {
    const layout = solveLayout(SYNTHETIC_FOG);
    expect(layout.fogTunnels).toHaveLength(1);
    const tunnel = layout.fogTunnels[0];
    expect(tunnel.ttlStart).toBe(2);
    expect(tunnel.ttlEnd).toBe(5);
    expect(tunnel.endS - tunnel.startS).toBeGreaterThan(20);
    expect(layout.decorations.filter((d) => d.kind === 'fog')).toHaveLength(1);
    expect(layout.nodes).toHaveLength(7);
  });

  it('ASN 变化切开分区，每个边界一道拱门', () => {
    const layout = solveLayout(SYNTHETIC_OCEAN);
    expect(layout.zones.length).toBeGreaterThanOrEqual(4);
    expect(layout.decorations.filter((d) => d.kind === 'gate')).toHaveLength(layout.zones.length - 1);
    for (const zone of layout.zones) {
      expect(zone.endS).toBeGreaterThan(zone.startS);
      expect(zone.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(zoneAtS(layout, zone.startS).index).toBe(zone.index);
    }
  });

  it('五条内置样本都能生成合法布局与终点门', () => {
    for (const sample of BUILTIN_SAMPLES) {
      expect(sample.synthetic).toBe(true);
      expect(sample.trace.synthetic).toBe(true);
      const layout = solveLayout(sample.trace);
      expect(layout.totalLength).toBeGreaterThan(100);
      expect(layout.nodes).toHaveLength(sample.trace.hops.length);
      expect(layout.decorations.some((d) => d.kind === 'finish')).toBe(true);
      expect(layout.spawn.y).toBeGreaterThan(layout.minY);
    }
  });
});
