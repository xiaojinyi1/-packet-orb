/**
 * mtr 解析：优先 --json，其次 --report / -r 宽表。
 * 只负责拆成 RawHop；统计量与契约归一在 Normalizer。
 */
import type { RawHop } from './Normalizer';

export interface MtrParseResult {
  rawHops: RawHop[];
  target: { host: string; ip: string | null };
  hopLines: number;
  formatMatched: boolean;
  error?: string;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function isIp(token: string): boolean {
  if (IPV4.test(token)) return token.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  return token.includes(':') && IPV6.test(token);
}

function cleanHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').trim();
}

interface MtrHub {
  count?: number;
  host?: string;
  ASN?: string | number;
  'Loss%'?: number | string;
  Snt?: number;
  Last?: number;
  Avg?: number;
  Best?: number;
  Wrst?: number;
  StDev?: number;
}

function hubToRaw(hub: MtrHub, fallbackTtl: number): RawHop | null {
  const ttl = Number(hub.count ?? fallbackTtl);
  if (!Number.isFinite(ttl) || ttl < 1) return null;
  const host = cleanHost(String(hub.host ?? '???'));
  const loss = Number(String(hub['Loss%'] ?? 0).replace('%', ''));
  const snt = Number(hub.Snt ?? 10);
  const avg = Number(hub.Avg ?? 0);
  const best = Number(hub.Best ?? 0);
  const worst = Number(hub.Wrst ?? 0);
  const lost = Number.isFinite(snt) ? Math.round((snt * (Number.isFinite(loss) ? loss : 0)) / 100) : 0;
  const samples: number[] = [];
  if (Number.isFinite(loss) && loss < 100 && Number.isFinite(avg) && avg > 0) {
    // mtr 不给逐包样本：用 Best / Avg / Worst 三个代表值，stddev 单独保留列。
    samples.push(best > 0 ? best : avg, avg, worst > 0 ? worst : avg);
  }
  const addresses = isIp(host) ? [host] : [];
  return {
    ttl,
    addresses,
    ptr: host === '???' || isIp(host) ? null : host,
    as: hub.ASN ? String(hub.ASN).toUpperCase().startsWith('AS') ? String(hub.ASN) : `AS${hub.ASN}` : null,
    samplesMs: samples,
    lost,
    lossPct: Number.isFinite(loss) ? loss : undefined,
    avgMs: Number.isFinite(avg) && avg > 0 ? avg : undefined,
    stddevMs: Number.isFinite(Number(hub.StDev)) ? Number(hub.StDev) : undefined,
  };
}

export function parseMtrJson(text: string): MtrParseResult | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const root = data as Record<string, unknown>;
  const report = (root.report ?? root) as Record<string, unknown>;
  const mtr = (report.mtr ?? report) as Record<string, unknown>;
  const hubs = (mtr.hubs ?? root.hubs) as MtrHub[] | undefined;
  if (!Array.isArray(hubs) || hubs.length === 0) return null;

  const rawHops: RawHop[] = [];
  hubs.forEach((hub, i) => {
    const raw = hubToRaw(hub, i + 1);
    if (raw) rawHops.push(raw);
  });
  if (rawHops.length === 0) return null;

  const dst = String(mtr.dst ?? report.dst ?? '');
  const dstHost = cleanHost(dst);
  return {
    rawHops,
    target: { host: dstHost || 'unknown', ip: isIp(dstHost) ? dstHost : null },
    hopLines: hubs.length,
    formatMatched: true,
  };
}

const NUMBER = /-?\d+(?:\.\d+)?/g;

export function parseMtrReport(text: string): MtrParseResult | null {
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find((line) => /^\s*HOST\b/i.test(line) && /Loss%/i.test(line));
  const rows = lines.filter((line) => /^\s*\d+\s*[.:|]/.test(line) && /--|\[|\S/.test(line));
  if (!headerLine && rows.length === 0) return null;

  const rawHops: RawHop[] = [];
  let hopLines = 0;
  for (const line of lines) {
    const m =
      line.match(/^\s*(\d+)\.\|--\s+(\S+)\s+(.*)$/) ??
      line.match(/^\s*(\d+):\s+(?:\[([^\]]+)\]|(\S+))\s+(.*)$/);
    if (!m) continue;
    hopLines += 1;
    const ttl = Number(m[1]);
    const host = cleanHost(m[2] ?? m[3] ?? '');
    const rest = m[m.length - 1];
    const numbers = rest.match(NUMBER)?.map(Number) ?? [];
    if (numbers.length < 3) continue;

    const lossToken = rest.match(/-?\d+(?:\.\d+)?\s*%/)?.[0];
    const loss = lossToken ? Number(lossToken.replace('%', '')) : numbers[0];
    // 有 Loss% 时，后面依次是 Snt Last Avg Best Wrst StDev；夹 WW 时多一列。
    const after = lossToken ? rest.slice(rest.indexOf(lossToken) + lossToken.length) : rest;
    const nums = (after.match(NUMBER)?.map(Number) ?? []).filter((v) => Number.isFinite(v));
    let snt = 10;
    let avg = 0;
    let best = 0;
    let worst = 0;
    let stdev = 0;
    if (nums.length >= 6) {
      // Snt Last Avg Best Wrst StDev
      [snt, , avg, best, worst, stdev] = nums;
    } else if (nums.length >= 5) {
      // 没有 Snt 列：Last Avg Best Wrst StDev
      [, avg, best, worst, stdev] = nums;
    } else if (nums.length >= 3) {
      [avg, best, worst] = nums;
    }
    const lost = Math.round((snt * loss) / 100);
    const samples: number[] = [];
    if (loss < 100 && avg > 0) samples.push(best > 0 ? best : avg, avg, worst > 0 ? worst : avg);
    const addresses = isIp(host) ? [host] : [];
    rawHops.push({
      ttl,
      addresses,
      ptr: host === '???' || isIp(host) ? null : host,
      as: null,
      samplesMs: samples,
      lost,
      lossPct: loss,
      avgMs: avg > 0 ? avg : undefined,
      stddevMs: Number.isFinite(stdev) ? stdev : undefined,
    });
  }
  if (rawHops.length === 0) return null;
  return {
    rawHops,
    target: { host: '', ip: null },
    hopLines: Math.max(hopLines, 1),
    formatMatched: Boolean(headerLine),
  };
}
