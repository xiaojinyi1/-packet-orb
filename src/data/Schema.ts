/**
 * 数据契约（CLAUDE.md 唯一权威定义的 TS 镜像）。
 * 渲染层与 world/ 只消费 TraceResult，禁止任何模块直接读原始粘贴文本。
 */
export interface HopResult {
  ttl: number;
  addresses: string[];
  ptr: string | null;
  private: boolean;
  samplesMs: number[];
  avgMs: number | null;
  bestMs: number | null;
  worstMs: number | null;
  stddevMs: number | null;
  lossPct: number;
  as: string | null;
  geo: string | null;
  anonymous: boolean;
}

export interface TraceResult {
  schema: 'packet-orb/1';
  source: 'paste' | 'builtin' | 'probe';
  /** 合成测试夹具标记：UI 必须显示"内置合成样本"，不得冒充真实测量。 */
  synthetic?: boolean;
  capturedAt: string;
  target: { host: string; ip: string | null };
  hops: HopResult[];
  quality: {
    parsed: number;
    anonymous: number;
    confidence: number;
    truncated: boolean;
  };
}
