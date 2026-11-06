import { describe, expect, it } from 'vitest';
import { BUILTIN_SAMPLES } from '../src/data/BuiltinSamples';
import { sampleAtS, segmentLength, solveLayout } from '../src/world/LayoutSolver';
import type { Layout, PathSample } from '../src/world/LayoutSolver';
import { buildRoadNetwork } from '../src/world/RoadNetwork';
import { createSimCore } from '../src/sim/SimCore';
import { defaultSimConfig } from '../src/sim/protocol';
import type { WorldSpec } from '../src/sim/protocol';

const layout: Layout = solveLayout(BUILTIN_SAMPLES[0].trace);
const road = buildRoadNetwork(layout);

const spec: WorldSpec = {
  colliders: road.colliders,
  zones: road.zones,
  spawn: layout.spawn,
  checkpoints: layout.checkpoints,
  fallY: layout.fallY,
};

function nearestAhead(samples: PathSample[], x: number, z: number, fromS: number, window = 40): PathSample | null {
  let best: PathSample | null = null;
  let bestD = Infinity;
  for (const sample of samples) {
    if (sample.s < fromS - 1 || sample.s > fromS + window) continue;
    const d = (sample.x - x) ** 2 + (sample.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = sample;
    }
  }
  return best;
}

describe('LayoutSolver', () => {
  it('8 跳样本生成 7 段，段长遵守 12 + 8·sqrt(avgMs)', () => {
    expect(layout.spans).toHaveLength(7);
    for (const span of layout.spans) {
      expect(span.length).toBeCloseTo(segmentLength(span.avgMs), 5);
    }
    expect(layout.features.map((f) => f.kind).sort()).toEqual(['jump', 'pit', 'trampoline']);
  });

  it('主干道有坡度、有断口、有落地区', () => {
    expect(layout.maxY - layout.minY).toBeGreaterThan(3);
    expect(layout.samples.some((s) => s.gap)).toBe(true);
    expect(layout.samples.some((s) => s.landing)).toBe(true);
  });
});

describe('SimCore 30 秒自动驾驶', () => {
  it('不穿地、不越墙、不卡死、跳台有腾空与落地', async () => {
    const sim = await createSimCore(spec, defaultSimConfig());
    const start = layout.samples[0];
    let progressS = 0;
    let airFrames = 0;
    let maxSpeed = 0;
    let sumSpeed = 0;
    let speedSamples = 0;
    let maxLateral = 0;
    let maxImpact = 0;
    let respawns = 0;
    let nanGuard = 0;
    let belowGround = 0;
    let minAboveGround = Infinity;
    let stuckFrames = 0;
    let lowSpeedRun = 0;

    for (let i = 0; i < 1800; i += 1) {
      const p = sim.body.translation();
      const near = nearestAhead(layout.samples, p.x, p.z, progressS);
      if (near) progressS = Math.max(progressS, near.s);
      const target = nearestAhead(layout.samples, p.x, p.z, progressS + 6, 20) ?? near;
      let dx = 0;
      let dz = 0;
      if (target) {
        dx = target.x - p.x;
        dz = target.z - p.z;
      }
      const len = Math.hypot(dx, dz) || 1;
      const result = sim.step({ dirX: dx / len, dirZ: dz / len, throttle: 1 });

      if (result.flags & 1) respawns += 1;
      if (result.flags & 4) nanGuard += 1;
      if (result.impact > maxImpact) maxImpact = result.impact;
      if (!result.grounded) airFrames += 1;
      maxSpeed = Math.max(maxSpeed, result.speed);
      sumSpeed += result.speed;
      speedSamples += 1;
      if (i > 120) {
        if (result.speed < 1) lowSpeedRun += 1;
        else lowSpeedRun = 0;
        if (lowSpeedRun > 90) stuckFrames = lowSpeedRun;
      }

      if (near) {
        const lateral = Math.abs(
          (p.x - near.x) * near.sx + (p.z - near.z) * near.sz,
        );
        if (lateral > maxLateral) maxLateral = lateral;
        const above = p.y - near.y;
        if (above < minAboveGround) minAboveGround = above;
        if (result.grounded && above < 0.2) belowGround += 1;
      }
    }

    const end = sim.body.translation();
    const avgSpeed = sumSpeed / speedSamples;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      steps: 1800,
      progressS: +progressS.toFixed(1),
      startX: +start.x.toFixed(1),
      endX: +end.x.toFixed(1),
      endY: +end.y.toFixed(2),
      maxSpeed: +maxSpeed.toFixed(2),
      avgSpeed: +avgSpeed.toFixed(2),
      airFrames,
      maxImpact: +maxImpact.toFixed(2),
      maxLateral: +maxLateral.toFixed(2),
      minAboveGround: +minAboveGround.toFixed(2),
      belowGround,
      respawns,
      nanGuard,
      stuck: stuckFrames > 0,
    }, null, 2));

    expect(nanGuard).toBe(0);
    expect(respawns).toBe(0);
    expect(belowGround).toBe(0);
    expect(progressS).toBeGreaterThan(120);
    expect(avgSpeed).toBeGreaterThan(3);
    expect(maxSpeed).toBeLessThan(30);
    // 球心与路面中心的水平偏移：路面半宽 4.5，球半径 0.45，留 0.2 容差
    expect(maxLateral).toBeLessThan(4.6);
    // 断裂跳台必须真的腾空过
    expect(airFrames).toBeGreaterThan(20);
    expect(maxImpact).toBeGreaterThan(0.1);
    expect(stuckFrames).toBe(0);
  }, 120_000);

  it('断裂跳台：从跳台前起步能飞过断口并落在落地区', async () => {
    const jumpSpan = layout.spans.find((s) => s.kind === 'jump');
    expect(jumpSpan).toBeTruthy();
    const startS = (jumpSpan!.kickerStartS ?? jumpSpan!.sStart) - 14;
    const startSample = sampleAtS(layout.samples, startS);
    expect(startSample).toBeTruthy();
    const jumpSpec: WorldSpec = {
      ...spec,
      spawn: { x: startSample!.x, y: startSample!.y + 0.9, z: startSample!.z },
    };
    const sim = await createSimCore(jumpSpec, defaultSimConfig());
    let progressS = startS;
    let airFrames = 0;
    let maxImpact = 0;
    let respawns = 0;
    let nanGuard = 0;

    for (let i = 0; i < 600; i += 1) {
      const p = sim.body.translation();
      const near = nearestAhead(layout.samples, p.x, p.z, progressS);
      if (near) progressS = Math.max(progressS, near.s);
      const target = nearestAhead(layout.samples, p.x, p.z, progressS + 6, 20) ?? near;
      let dx = 0;
      let dz = 0;
      if (target) {
        dx = target.x - p.x;
        dz = target.z - p.z;
      }
      const len = Math.hypot(dx, dz) || 1;
      const result = sim.step({ dirX: dx / len, dirZ: dz / len, throttle: 1 });
      if (result.flags & 1) respawns += 1;
      if (result.flags & 4) nanGuard += 1;
      if (result.impact > maxImpact) maxImpact = result.impact;
      if (!result.grounded) airFrames += 1;
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      jumpStartS: +startS.toFixed(1),
      gapStartS: jumpSpan!.gapStartS,
      landingEndS: jumpSpan!.landingEndS,
      progressS: +progressS.toFixed(1),
      airFrames,
      maxImpact: +maxImpact.toFixed(2),
      respawns,
      nanGuard,
    }, null, 2));

    expect(jumpSpan!.gapStartS).not.toBeNull();
    expect(jumpSpan!.landingEndS).not.toBeNull();
    expect(nanGuard).toBe(0);
    expect(respawns).toBe(0);
    expect(airFrames).toBeGreaterThan(10);
    expect(maxImpact).toBeGreaterThan(0.1);
    expect(progressS).toBeGreaterThan((jumpSpan!.landingEndS ?? Infinity) - 1);
  }, 60_000);
});
