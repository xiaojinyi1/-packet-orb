/**
 * Packet Orb — M2：可以录屏的作品集页面。
 * 物理仍在 Worker；主线程只做渲染 / 镜头 / 输入 / 彩蛋 / UI。
 * 数据链路：原始粘贴只在 data/PasteParser 与终端面板里出现，渲染层只消费 TraceResult。
 */
import * as THREE from 'three';
import gsap from 'gsap';
import { BUILTIN_SAMPLES } from './data/BuiltinSamples';
import { parseTrace } from './data/PasteParser';
import { readShareHash, shareHash } from './data/ShareCodec';
import type { TraceResult } from './data/Schema';
import { clamp, nearestSample, sampleAtS, solveLayout, zoneAtS } from './world/LayoutSolver';
import type { Layout } from './world/LayoutSolver';
import { buildRoadNetwork, disposeRoadNetwork } from './world/RoadNetwork';
import type { RoadBuild } from './world/RoadNetwork';
import { buildTerrain, disposeTerrain } from './world/Terrain';
import { buildBuildings, disposeBuildings } from './world/Buildings';
import { buildProps, disposeProps } from './world/Props';
import { buildFogTunnels, disposeFogTunnels, fogAt } from './world/FogTunnel';
import { PhysicsWorld } from './sim/PhysicsWorld';
import { SIM_FLAG, defaultSimConfig } from './sim/protocol';
import type { SimConfig, WorldSpec } from './sim/protocol';
import { DEFAULT_FOLLOW, FollowRig } from './camera/FollowRig';
import { Cinematic } from './camera/Cinematic';
import { InputMapper } from './ui/InputMapper';
import { TweakPanel } from './ui/TweakPanel';
import type { Quality } from './ui/TweakPanel';
import { TerminalPanel } from './ui/TerminalPanel';
import { HUD } from './ui/HUD';
import { ResultPanel } from './ui/ResultPanel';
import { Recorder } from './ui/Recorder';
import { Achievements } from './ui/Achievements';
import { SfxBank } from './audio/SfxBank';
import { getThemeName, palette, setTheme } from './render/Theme';
import type { ThemeName } from './render/Theme';
import { matcapMaterial } from './render/MatcapMaterial';
import { buildTextAtlas } from './render/TextAtlas';
import { Trail, pulseFogGuide } from './render/Trail';
import { Particles } from './render/Particles';
import { PostFX } from './render/PostFX';
import { hasWebGL, renderSvgFallback } from './render/SvgFallback';

interface FrameMetrics {
  fps: number;
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  renderMs: number;
  frames: number;
  simSteps: number;
  nanEvents: number;
  respawns: number;
  drawCalls: number;
  triangles: number;
  rebuilds: number;
  lastRebuildMs: number;
  quality: string;
  mode: string;
  theme: string;
  achievements: number;
  firstFrameMs: number;
  firstInteractiveMs: number;
}

const metrics: FrameMetrics = {
  fps: 0,
  avgFrameMs: 0,
  p95FrameMs: 0,
  maxFrameMs: 0,
  renderMs: 0,
  frames: 0,
  simSteps: 0,
  nanEvents: 0,
  respawns: 0,
  drawCalls: 0,
  triangles: 0,
  rebuilds: 0,
  lastRebuildMs: 0,
  quality: 'high',
  mode: 'free',
  theme: getThemeName(),
  achievements: 0,
  firstFrameMs: 0,
  firstInteractiveMs: 0,
};
(window as unknown as { __PO_METRICS: FrameMetrics }).__PO_METRICS = metrics;

const params = new URLSearchParams(window.location.search);
const app = document.getElementById('app');
const boot = document.getElementById('boot');
if (!app) throw new Error('#app 容器缺失');
const appEl: HTMLElement = app;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let rig: FollowRig;
let sun: THREE.DirectionalLight;
let orb: THREE.Mesh;
let orbCore: THREE.Mesh;
let composer: PostFX;
let trail: Trail;
let particles: Particles;
let mapper: InputMapper;
let cinematic: Cinematic;
let achievements: Achievements;
let sfx: SfxBank;
let hud: HUD;
let result: ResultPanel;
let terminal: TerminalPanel;
let panel: TweakPanel;
let recorder: Recorder;

const config: SimConfig = defaultSimConfig();
let autopilot = params.get('autopilot') === '1';
let quality: Quality = coarsePointer ? 'medium' : 'high';
let rebuilding = false;
let replaying = false;
let lastRebuildStart = 0;
let lastTtl = -1;
let arrivalPlaying = false;
let introPlaying = false;
let firstFrameRecorded = false;
const bootAt = performance.now();

interface WorldHandle {
  trace: TraceResult;
  layout: Layout;
  road: RoadBuild;
  group: THREE.Group;
  physics: PhysicsWorld;
  atlas: ReturnType<typeof buildTextAtlas> | null;
  spawn: THREE.Vector3;
  startForward: THREE.Vector3;
  arrived: boolean;
  respawns: number;
  doorBumps: number;
  doorCooldown: number;
  fPresses: number;
  wasInFog: boolean;
  rerouted: boolean;
}

let current: WorldHandle | null = null;

function forwardAt(layout: Layout, s: number): THREE.Vector3 {
  const a = sampleAtS(layout.samples, s);
  const b = sampleAtS(layout.samples, s + 3);
  if (a && b) {
    const v = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    if (v.lengthSq() > 1e-6) return v.normalize();
  }
  return new THREE.Vector3(0, 0, 1);
}

async function createWorld(trace: TraceResult): Promise<WorldHandle> {
  const layout = solveLayout(trace);
  const road = buildRoadNetwork(layout);
  const group = new THREE.Group();
  group.name = 'po-world';
  // 分帧建场景：每帧只做一段，避免单个 >50ms 的长任务拖住首帧与 TBT。
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  group.add(buildTerrain(layout));
  group.add(road.group);
  await nextFrame();
  group.add(buildBuildings(layout));
  group.add(buildProps(layout));
  await nextFrame();
  group.add(buildFogTunnels(layout));

  const spawn = new THREE.Vector3(layout.spawn.x, layout.spawn.y, layout.spawn.z);
  const spec: WorldSpec = {
    colliders: road.colliders,
    zones: road.zones,
    spawn: { x: spawn.x, y: spawn.y, z: spawn.z },
    checkpoints: layout.checkpoints,
    fallY: layout.fallY,
  };
  const physics = await PhysicsWorld.create(spec, config);

  const handle: WorldHandle = {
    trace,
    layout,
    road,
    group,
    physics,
    atlas: null,
    spawn,
    startForward: forwardAt(layout, 9),
    arrived: false,
    respawns: 0,
    doorBumps: 0,
    doorCooldown: 0,
    fPresses: 0,
    wasInFog: false,
    rerouted: false,
  };

  // 地面文字只影响观感：等首屏稳定后再烘焙，避免把启动长任务再拖长 60ms+。
  setTimeout(() => {
    if (current !== handle) return;
    const atlas = buildTextAtlas(layout, trace);
    const applyOpacity = (value: number): void => {
      atlas.mesh.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.material) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          if ('opacity' in mat) {
            mat.transparent = true;
            mat.opacity = value;
            mat.needsUpdate = true;
          }
        }
      });
    };
    applyOpacity(0);
    group.add(atlas.mesh);
    const fade = { value: 0 };
    gsap.to(fade, {
      value: 1,
      duration: 0.45,
      ease: 'power1.out',
      onUpdate: () => applyOpacity(fade.value),
    });
    handle.atlas = atlas;
  }, 600);

  return handle;
}

function disposeWorld(world: WorldHandle): void {
  world.physics.dispose();
  scene.remove(world.group);
  const terrain = world.group.getObjectByName('packet-orb-terrain');
  const buildings = world.group.getObjectByName('packet-orb-buildings');
  const props = world.group.getObjectByName('packet-orb-props');
  const fog = world.group.getObjectByName('packet-orb-fog');
  if (terrain) disposeTerrain(terrain as THREE.Group);
  disposeRoadNetwork(world.road);
  if (buildings) disposeBuildings(buildings as THREE.Group);
  if (props) disposeProps(props as THREE.Group);
  if (fog) disposeFogTunnels(fog as THREE.Group);
  world.atlas?.dispose();
}

function hasDuplicateAddress(trace: TraceResult): boolean {
  const seen = new Set<string>();
  for (const hop of trace.hops) {
    for (const addr of hop.addresses) {
      if (seen.has(addr)) return true;
      seen.add(addr);
    }
  }
  return false;
}

async function rebuild(trace: TraceResult, info: { format: string; confidence: number }): Promise<void> {
  if (rebuilding) return;
  rebuilding = true;
  lastRebuildStart = performance.now();
  terminal.setBusy(true);
  result.hide();
  cinematic.cancel();
  arrivalPlaying = false;
  const old = current;
  if (old) old.physics.pause(true);

  let next: WorldHandle;
  try {
    next = await createWorld(trace);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    terminal.setStatus(`生成失败：${message}`, 'error');
    terminal.setBusy(false);
    if (old) old.physics.pause(false);
    rebuilding = false;
    return;
  }

  // 1.2s 内的形变重建：旧世界下沉，新世界从上方落位，物理 Worker 在动画前已经就绪
  next.group.position.y = 34;
  scene.add(next.group);
  const duration = 0.6;
  await new Promise<void>((resolve) => {
    const tl = gsap.timeline({ onComplete: resolve });
    if (old) tl.to(old.group.position, { y: old.group.position.y - 26, duration: 0.35, ease: 'power2.in' }, 0);
    if (old) tl.to(old.group.rotation, { y: 0.06, duration: duration, ease: 'power2.inOut' }, 0);
    tl.to(next.group.position, { y: 0, duration, ease: 'power3.out' }, 0.15);
  });

  if (old) disposeWorld(old);
  current = next;
  scene.add(orb);

  orb.position.copy(next.spawn);
  orb.quaternion.identity();
  rig.reset(next.spawn, next.startForward);
  trail.reset(orb.position);
  lastTtl = -1;
  applyQuality(quality);

  terminal.setSynthBadge(trace.synthetic === true);
  terminal.setBusy(false);
  terminal.setStatus(`${info.format} · ${trace.hops.length} 跳 · 世界已生成，可直接驾驶。`, 'ok');
  metrics.rebuilds += 1;
  metrics.lastRebuildMs = performance.now() - lastRebuildStart;
  writeShareHash(trace);

  if (hasDuplicateAddress(trace)) achievements.unlock('loop');
  if (trace.hops.length > 0 && trace.hops.every((h) => h.anonymous)) achievements.unlock('all_star');
  (window as unknown as { __PO_PHYSICS?: unknown }).__PO_PHYSICS = next.physics;
  rebuilding = false;
}

function applyQuality(next: Quality): void {
  quality = next;
  metrics.quality = next;
  const ratio =
    next === 'high'
      ? Math.min(window.devicePixelRatio || 1, 2)
      : next === 'medium'
        ? Math.min(window.devicePixelRatio || 1, 1.5)
        : 1;
  renderer.setPixelRatio(ratio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = next !== 'low';
  sun.castShadow = next === 'high' || next === 'medium';
  sun.shadow.mapSize.set(next === 'high' ? 2048 : 1024, next === 'high' ? 2048 : 1024);
  sun.shadow.map?.dispose();
  sun.shadow.map = null;
  composer.setLevel(next);
  composer.setSize(window.innerWidth, window.innerHeight);
  const fx = next !== 'low' && !reducedMotion;
  trail.setEnabled(fx);
  particles.setEnabled(fx);
  if (panel) {
    panel.state.quality = next;
  }
}

const overlay = document.createElement('div');
overlay.className = 'po-perf';
overlay.textContent = 'perf…';
document.body.appendChild(overlay);

function resetToStart(): void {
  if (!current) return;
  current.physics.reset();
  orb.position.copy(current.spawn);
  rig.reset(current.spawn, current.startForward);
  current.arrived = false;
  current.respawns = 0;
  trail.reset(orb.position);
  result.hide();
}

function worstLossHop(world: WorldHandle) {
  return [...world.trace.hops].sort((a, b) => {
    if (b.lossPct !== a.lossPct) return b.lossPct - a.lossPct;
    return (b.avgMs ?? 0) - (a.avgMs ?? 0);
  })[0];
}

/** 丢包路段回放：暂停物理，镜头沿最差跳前后 20m 推一段，结束后交还追尾镜头。 */
function replayWorstLoss(): void {
  const world = current;
  if (!world || replaying) return;
  const hop = worstLossHop(world);
  if (!hop) return;
  const node = world.layout.nodes.find((n) => n.ttl === hop.ttl) ?? world.layout.nodes[0];
  const from = clamp(node.s - 10, 0, world.layout.totalLength - 1);
  const to = clamp(node.s + 10, 1, world.layout.totalLength);
  result.hide();
  world.physics.pause(true);
  replaying = true;
  const resumeForward = new THREE.Vector3();
  rig.getPlanarForward(resumeForward);
  const time = { t: 0 };
  gsap.to(time, {
    t: 1,
    duration: 3.2,
    ease: 'sine.inOut',
    onUpdate: () => {
      const s = from + (to - from) * time.t;
      const p = sampleAtS(world.layout.samples, s);
      if (!p) return;
      const ahead = sampleAtS(world.layout.samples, s + 6) ?? p;
      camera.position.set(p.x - p.tx * 7 + p.sx * 1.4, p.y + 3.6, p.z - p.tz * 7 + p.sz * 1.4);
      camera.lookAt(ahead.x, ahead.y + 1.2, ahead.z);
    },
    onComplete: () => {
      replaying = false;
      world.physics.pause(false);
      rig.reset(orb.position, resumeForward);
    },
  });
}

function shareUrl(trace: TraceResult): string {
  return `${location.origin}${location.pathname}${location.search}${shareHash(trace)}`;
}

function writeShareHash(trace: TraceResult): void {
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}${shareHash(trace)}`);
  } catch {
    /* 部分沙箱环境不允许改 history，分享按钮仍可用 */
  }
}

async function copyShareLink(): Promise<void> {
  const world = current;
  if (!world) return;
  const url = shareUrl(world.trace);
  let ok = false;
  try {
    await navigator.clipboard.writeText(url);
    ok = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = url;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  const note = ok ? '分享链接已复制' : '浏览器阻止了剪贴板，请手动复制地址栏';
  terminal.setStatus(`${note} · ${world.trace.hops.length} 跳 · ${url.length} 字符`, ok ? 'ok' : 'error');
}

function fallbackMedia(): void {
  try {
    renderer.render(scene, camera);
    const data = renderer.domElement.toDataURL('image/png');
    result.setMedia('静态结算截图（PNG）', data, 'packet-orb-arrival.png');
  } catch {
    result.setMedia('静态分享图（OG）', `${import.meta.env.BASE_URL}og.png`);
  }
}

function playIntro(world: WorldHandle): void {
  if (reducedMotion) return;
  introPlaying = true;
  world.physics.pause(true);
  const y0 = world.spawn.y;
  orb.position.y = y0 + 13;
  camera.position.set(world.spawn.x, y0 + 10, world.spawn.z - 13);
  const tl = gsap.timeline({
    onComplete: () => {
      introPlaying = false;
      world.physics.pause(false);
    },
  });
  tl.to(orb.position, { y: y0, duration: 0.55, ease: 'power2.in' }, 0)
    .to(orb.position, { y: y0 + 2.3, duration: 0.26, ease: 'power1.out' })
    .to(orb.position, { y: y0, duration: 0.3, ease: 'power2.in' })
    .to(orb.position, { y: y0 + 0.7, duration: 0.15, ease: 'power1.out' })
    .to(orb.position, { y: y0, duration: 0.2, ease: 'power2.in' });
}

function showArrival(world: WorldHandle): void {
  if (world.arrived || arrivalPlaying) return;
  world.arrived = true;
  arrivalPlaying = true;
  world.physics.pause(true);
  sfx.arrive();
  if (world.respawns === 0) achievements.unlock('zero_loss');
  recorder.start(renderer.domElement, (rec) => {
    if (rec) {
      result.setMedia(`下载 8 秒到站回放（WebM · ${(rec.ms / 1000).toFixed(1)}s）`, rec.url, 'packet-orb-arrival.webm');
    } else {
      fallbackMedia();
    }
  });
  const finish = world.layout.nodes[world.layout.nodes.length - 1];
  if (finish) particles.burstImpact(new THREE.Vector3(finish.x, finish.y + 0.6, finish.z), 0.8, 'road');
  cinematic.playArrival(world.layout, () => {
    arrivalPlaying = false;
    result.show(world.trace, {
      onReplay: replayWorstLoss,
      onRestart: () => {
        result.hide();
        world.physics.pause(false);
        resetToStart();
      },
      onClose: () => {
        result.hide();
        world.physics.pause(false);
      },
      onShare: () => void copyShareLink(),
    });
  });
}

function switchTheme(name: ThemeName): void {
  if (getThemeName() === name || rebuilding) return;
  setTheme(name);
  metrics.theme = name;
  document.documentElement.dataset.theme = name;
  scene.background = makeSkyTexture();
  (scene.fog as THREE.Fog).color = new THREE.Color(palette().fog);
  if (current) void rebuild(current.trace, { format: '主题切换', confidence: 1 });
}

function triggerRewind(): void {
  const world = current;
  if (!world || replaying) return;
  achievements.unlock('rewind');
  world.physics.pause(true);
  replaying = true;
  const resumeForward = new THREE.Vector3();
  rig.getPlanarForward(resumeForward);
  cinematic.playRewind(world.layout, () => {
    replaying = false;
    world.physics.pause(false);
    rig.reset(orb.position, resumeForward);
  });
}

/** 天空：两色纵向渐变，比纯色背景更像有大气。 */
function makeSkyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, palette().skyTop);
    g.addColorStop(0.72, palette().skyBottom);
    g.addColorStop(1, palette().fog);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function boot_(): Promise<void> {
  if (params.get('nowebgl') === '1' || !hasWebGL()) {
    const layout = solveLayout(BUILTIN_SAMPLES[0].trace);
    renderSvgFallback(appEl, layout);
    if (boot) {
      boot.dataset.ready = 'true';
      boot.textContent = '';
    }
    return;
  }

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.info.autoReset = false;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute(
    'aria-label',
    'Packet Orb 3D 迷宫：可驾驶的数据包球沿 traceroute 生成的路线前进',
  );
  appEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = makeSkyTexture();
  scene.fog = new THREE.Fog(palette().fog, 55, 190);
  document.documentElement.dataset.theme = getThemeName();

  // 规范：场景内不放实时点光/聚光。matcap 不需要光照，这里只保留一张
  // 2048 的 directional shadow map（强度 0，只用来投影）。
  sun = new THREE.DirectionalLight('#fff4d6', 0);
  sun.position.set(24, 38, 16);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 420);
  rig = new FollowRig(camera, { ...DEFAULT_FOLLOW });
  cinematic = new Cinematic(camera);
  composer = new PostFX(renderer, scene, camera);
  trail = new Trail();
  scene.add(trail.mesh);
  particles = new Particles();
  scene.add(particles.points);

  // Packet Orb：matcap 半透明外壳 + 自发光内核（规范只允许球与终点门 emissive）。
  const orbGeo = new THREE.IcosahedronGeometry(0.45, 2);
  orb = new THREE.Mesh(
    orbGeo,
    matcapMaterial(0, { color: '#57efe0' }),
  );
  orb.castShadow = true;
  orb.name = 'packet-orb';
  scene.add(orb);
  orbCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.24, 1),
    new THREE.MeshBasicMaterial({ color: '#bffff7' }),
  );
  orbCore.name = 'packet-orb-core';
  orb.add(orbCore);
  const orbWire = new THREE.LineSegments(
    new THREE.WireframeGeometry(orbGeo),
    new THREE.LineBasicMaterial({ color: '#ffe447', transparent: true, opacity: 0.26 }),
  );
  orb.add(orbWire);

  mapper = new InputMapper(document.body);
  sfx = new SfxBank(document.body);
  achievements = new Achievements(document.body);
  hud = new HUD(document.body);
  hud.element.appendChild(achievements.counter);
  result = new ResultPanel(document.body);
  terminal = new TerminalPanel(document.body, {
    onGenerate: (trace, info) => void rebuild(trace, info),
    onShare: () => void copyShareLink(),
    onBuiltin: (sample) => {
      void rebuild(sample.trace, { format: '内置样本', confidence: 1 });
    },
  });

  recorder = new Recorder();
  const shared = readShareHash(location.hash);
  const firstTrace = shared ?? BUILTIN_SAMPLES[0].trace;
  const first = await createWorld(firstTrace);
  current = first;
  scene.add(first.group);
  orb.position.copy(first.spawn);
  rig.reset(first.spawn, first.startForward);
  terminal.setSynthBadge(firstTrace.synthetic === true);
  if (shared) {
    terminal.setStatus(`已从分享链接还原 · ${firstTrace.hops.length} 跳 · 同一份布局。`, 'ok');
  } else {
    terminal.setStatus('已载入内置合成样本（非真实测量）。粘贴真实 traceroute 覆盖。', 'ok');
  }
  writeShareHash(firstTrace);
  const skipIntro = shared !== null || new URLSearchParams(location.search).has('nointro');
  if (skipIntro) {
    orb.position.copy(first.spawn);
    rig.reset(first.spawn, first.startForward);
  } else {
    playIntro(first);
  }

  panel = new TweakPanel(document.body, {
    config,
    camera: { ...rig.params },
    onPhysics: (partial) => current?.physics.setConfig(partial),
    onCamera: (params) => {
      rig.params = { ...params };
    },
    onQuality: (next) => applyQuality(next),
    onTheme: (next) => switchTheme(next),
    onReset: () => resetToStart(),
  });
  const q = params.get('quality');
  if (q === 'high' || q === 'medium' || q === 'low') quality = q;
  panel.state.quality = quality;
  panel.state.theme = getThemeName();
  panel.pane.element.style.zIndex = '20';
  applyQuality(quality);

  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5) achievements.unlock('night_owl');
  if (params.get('e') === '1') achievements.unlockAll();
  metrics.achievements = achievements.count;

  window.addEventListener('gamepadconnected', () => achievements.unlock('gamepad'));

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.key === 't' || event.key === 'T') {
      switchTheme(getThemeName() === 'night' ? 'day' : 'night');
      return;
    }
    if (event.code !== 'KeyF' || !current) return;
    const near = nearestSample(current.layout, orb.position.x, orb.position.z);
    if (!near || !fogAt(current.layout, near.s)) return;
    current.fPresses += 1;
    if (current.fPresses >= 3 && !achievements.has('fog_off')) {
      const fog = current.group.getObjectByName('packet-orb-fog');
      if (fog) fog.visible = false;
      achievements.unlock('fog_off');
    }
  });

  const forward = first.startForward.clone();
  const camForward = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const orbPos = new THREE.Vector3();
  const velDir = new THREE.Vector3();
  let lastFrameAt = performance.now();
  const frameTimes: number[] = [];
  let acc = 0;
  let lastSimStep = 0;
  let hudAcc = 0;

  function updateMetrics(frameMs: number): void {
    metrics.frames += 1;
    frameTimes.push(frameMs);
    if (frameTimes.length > 240) frameTimes.shift();
    acc += frameMs;
    if (acc < 500) return;
    acc = 0;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const sum = frameTimes.reduce((s, v) => s + v, 0);
    metrics.avgFrameMs = sum / frameTimes.length;
    metrics.fps = metrics.avgFrameMs > 0 ? 1000 / metrics.avgFrameMs : 0;
    metrics.p95FrameMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    metrics.maxFrameMs = sorted[sorted.length - 1];
    metrics.drawCalls = renderer.info.render.calls;
    metrics.triangles = renderer.info.render.triangles;
    metrics.achievements = achievements.count;
    overlay.textContent =
      `${metrics.fps.toFixed(1)} fps · ${metrics.avgFrameMs.toFixed(2)} ms avg · ` +
      `${metrics.p95FrameMs.toFixed(2)} ms p95 · ${metrics.drawCalls} calls · ` +
      `${(metrics.triangles / 1000).toFixed(0)}k tris · sim ${lastSimStep} · ${quality}/${achievements.count}◆`;
    overlay.style.display = panel.state.showStats ? '' : 'none';
  }

  function frame(): void {
    requestAnimationFrame(frame);
    const now = performance.now();
    const frameMs = now - lastFrameAt;
    lastFrameAt = now;
    const dt = Math.min(0.05, frameMs / 1000);
    const world = current;
    renderer.info.reset();

    if (!world) {
      composer.render(8);
      return;
    }

    pulseFogGuide(world.group.getObjectByName('packet-orb-fog') ?? null, now / 1000);

    if (replaying || arrivalPlaying || cinematic.busy) {
      composer.render(8);
      updateMetrics(Math.min(frameMs, 200));
      return;
    }

    const axis = mapper.read();
    metrics.mode = axis.mode;
    if (axis.interacted) sfx.unlock();
    if (axis.reset) resetToStart();
    if (axis.rewind) triggerRewind();
    if (axis.source === 'gamepad') achievements.unlock('gamepad');

    rig.cinematic = axis.mode === 'orbit';

    if (autopilot) {
      const near = nearestSample(world.layout, orb.position.x, orb.position.z);
      const s = near ? near.s + 7 : 0;
      const target = sampleAtS(world.layout.samples, s) ?? near;
      if (target && near) {
        dir.set(target.x - orb.position.x, 0, target.z - orb.position.z);
        if (dir.lengthSq() < 1e-4) dir.set(near.tx, 0, near.tz);
        dir.normalize();
      }
    } else if (axis.mode === 'orbit') {
      const near = nearestSample(world.layout, orb.position.x, orb.position.z);
      if (near) {
        const target = sampleAtS(world.layout.samples, near.s + 8 + axis.charge * 10) ?? near;
        dir.set(target.x - orb.position.x, 0, target.z - orb.position.z);
        if (dir.lengthSq() < 1e-4) dir.set(near.tx, 0, near.tz);
        dir.normalize();
      }
    } else if (axis.active) {
      rig.getPlanarForward(camForward);
      rig.getPlanarRight(camRight);
      dir.copy(camForward).multiplyScalar(axis.forward).addScaledVector(camRight, axis.right);
      if (dir.lengthSq() > 1e-6) dir.normalize();
    } else {
      dir.set(0, 0, 0);
    }

    const throttle = autopilot || axis.mode === 'orbit' ? 1 : axis.active ? 1 : 0;
    world.physics.sendInput({ dirX: dir.x, dirZ: dir.z, throttle });

    const pose = world.physics.sample(performance.now());
    orbPos.set(pose.x, pose.y, pose.z);
    if (!introPlaying) {
      orb.position.copy(orbPos);
      orb.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    }

    if (pose.speed > 1.2) {
      velDir.set(pose.vx, 0, pose.vz);
      if (velDir.lengthSq() > 1e-6) {
        velDir.normalize();
        forward.lerp(velDir, 1 - Math.exp(-dt * 7)).normalize();
      }
    } else if ((autopilot || axis.mode === 'orbit') && dir.lengthSq() > 1e-6) {
      forward.lerp(dir, 1 - Math.exp(-dt * 4)).normalize();
    }

    orbCore.scale.setScalar(1 + Math.min(0.22, pose.speed * 0.014));
    rig.update(dt, orbPos, forward, pose.speed, config.maxSpeed, pose.impact);
    sun.position.set(orbPos.x + 24, orbPos.y + 38, orbPos.z + 16);
    sun.target.position.copy(orbPos);

    trail.update(orb.position, pose.speed, dt);
    particles.update(dt);

    if (pose.impact > 0.25) {
      particles.burstImpact(orb.position, pose.impact, 'road');
      sfx.impact('road', pose.impact);
    }

    if (pose.flags & SIM_FLAG.NaN_GUARD) metrics.nanEvents += 1;
    if (pose.flags & SIM_FLAG.RESPAWN) {
      metrics.respawns += 1;
      world.respawns += 1;
      achievements.unlock('void');
    }
    const latest = world.physics.latest();
    if (latest && latest.step > lastSimStep) {
      metrics.simSteps += latest.step - lastSimStep;
      lastSimStep = latest.step;
    }

    hudAcc += frameMs;
    if (hudAcc > 100) {
      hudAcc = 0;
      const near = nearestSample(world.layout, orb.position.x, orb.position.z);
      if (near) {
        const node = world.layout.nodes.reduce((best, n) => (n.s <= near.s + 0.5 ? n : best), world.layout.nodes[0]);
        const hop = world.trace.hops.find((h) => h.ttl === node.ttl);
        const zone = zoneAtS(world.layout, near.s);
        const zoneLabel = zone.key.startsWith('ttl-')
          ? `区段 ${zone.index + 1}`
          : zone.key.length > 12
            ? `${zone.key.slice(0, 12)}…`
            : zone.key;
        hud.update({
          ttl: node.ttl,
          address: node.addresses[0] ?? (node.anonymous ? '* * *' : '—'),
          avgMs: hop?.avgMs ?? null,
          lossPct: hop?.lossPct ?? 0,
          progress: near.s / world.layout.totalLength,
          zoneLabel,
        });

        if (node.ttl !== lastTtl) {
          lastTtl = node.ttl;
          sfx.hop(node.ttl);
        }

        const lateral = Math.hypot(orb.position.x - near.x, orb.position.z - near.z);
        if (!world.rerouted && lateral > 6.5) {
          world.rerouted = true;
          achievements.unlock('reroute');
        }

        const insideFog = fogAt(world.layout, near.s);
        if (world.wasInFog && !insideFog) rig.pulseLift(1);
        world.wasInFog = insideFog;

        // 隧道内把雾拉近：可视距离压到 ~10m，出来再放开，形成“穿雾”的呼吸感。
        const fog = scene.fog as THREE.Fog;
        const fogK = Math.min(1, dt * 3.4);
        fog.near += ((insideFog ? 7 : 55) - fog.near) * fogK;
        fog.far += ((insideFog ? 36 : 190) - fog.far) * fogK;

        if (!world.arrived && near.s >= world.layout.totalLength - 4) showArrival(world);

        // 终点门连撞三次
        const finish = world.layout.nodes[world.layout.nodes.length - 1];
        if (finish && now > world.doorCooldown) {
          const dist = Math.hypot(orb.position.x - finish.x, orb.position.z - finish.z);
          if (dist < 6 && pose.speed > 3) {
            world.doorBumps += 1;
            world.doorCooldown = now + 700;
            if (world.doorBumps >= 3) {
              achievements.unlock('door3');
              const door = world.group.getObjectByName('finish-door');
              if (door) gsap.to(door.scale, { x: 1.12, y: 0.86, duration: 0.5, ease: 'power2.out' });
            }
          }
        }
      }
    }

    const focus = camera.position.distanceTo(orb.position);
    const submitStart = performance.now();
    composer.render(focus);
    metrics.renderMs = performance.now() - submitStart;
    if (!firstFrameRecorded) {
      firstFrameRecorded = true;
      metrics.firstFrameMs = performance.now() - bootAt;
      metrics.firstInteractiveMs = metrics.firstFrameMs;
    }
    updateMetrics(Math.min(frameMs, 200));
    if (boot && boot.dataset.ready !== 'true') {
      boot.dataset.ready = 'true';
      boot.textContent = '';
    }
  }

  document.addEventListener('visibilitychange', () => {
    current?.physics.pause(document.hidden);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  });

  (window as unknown as { __PO_PHYSICS?: unknown }).__PO_PHYSICS = current.physics;
  (window as unknown as { __PO_SET_AUTOPILOT?: (on: boolean) => void }).__PO_SET_AUTOPILOT = (on: boolean) => {
    autopilot = on;
  };
  (window as unknown as { __PO_SET_THEME?: (name: ThemeName) => void }).__PO_SET_THEME = (name: ThemeName) => {
    switchTheme(name);
  };
  (window as unknown as { __PO_SET_QUALITY?: (name: Quality) => void }).__PO_SET_QUALITY = (name: Quality) => {
    applyQuality(name);
  };
  (window as unknown as {
    __PO_REBUILD?: (trace: TraceResult) => Promise<void>;
    __PO_PASTE?: (text: string) => boolean;
    __PO_WORLD?: () => unknown;
  }).__PO_REBUILD = (trace: TraceResult) => rebuild(trace, { format: 'debug', confidence: 1 });
  (window as unknown as { __PO_SHARE?: () => string }).__PO_SHARE = () => (current ? shareUrl(current.trace) : '');
  (window as unknown as { __PO_COPY_SHARE?: () => Promise<void> }).__PO_COPY_SHARE = () => copyShareLink();
  (window as unknown as { __PO_PASTE?: (text: string) => boolean }).__PO_PASTE = (text: string) => {
    const outcome = parseTrace(text);
    if (!outcome.trace) return false;
    void rebuild(outcome.trace, { format: outcome.format, confidence: outcome.confidence });
    return true;
  };
  (window as unknown as { __PO_WORLD?: () => unknown }).__PO_WORLD = () => {
    if (!current) return null;
    return {
      totalLength: current.layout.totalLength,
      hops: current.trace.hops.length,
      zones: current.layout.zones.length,
      fogTunnels: current.layout.fogTunnels.length,
      spawn: { x: current.spawn.x, y: current.spawn.y, z: current.spawn.z },
      theme: getThemeName(),
    };
  };
  (window as unknown as { __PO_ACHIEVEMENTS?: () => unknown }).__PO_ACHIEVEMENTS = () => ({
    count: achievements.count,
    ids: achievements.has('void') ? 'void' : '',
  });

  lastFrameAt = performance.now();
  frame();
}

boot_().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[packet-orb] 启动失败', err);
  if (boot) {
    boot.textContent = `启动失败：${message}`;
    boot.style.opacity = '1';
  }
});
