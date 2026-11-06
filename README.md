# Packet Orb

**线上地址**：https://xiaojinyi1.github.io/-packet-orb/ （GitHub Pages，仓库 `xiaojinyi1/-packet-orb`）

把一段 `traceroute` 结果变成可驾驶的 low-poly 3D 网络迷宫。
延迟是坡度，丢包是坑洞，抖动是蹦床，匿名跳是迷雾隧道，ASN 变化是拱门与换色。

纯前端、零后端、可静态托管。渲染 `three`，物理 `rapier3d`（Web Worker，固定 1/60 步长），
UI `vanilla TS` + `tweakpane`。

## 快速开始

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # tsc --noEmit + vite build → dist/
npm run preview
npm test           # vitest：解析 / 分享编码 / 物理自动驾驶
```

Node 20+。构建产物在 `dist/`，可直接丢到任何静态托管。

## 怎么玩

| 输入 | 作用 |
| --- | --- |
| `W A S D` / 方向键 | 驾驶 |
| `空格` | 轨道投递模式下蓄力 / 投递 |
| `Tab` | 自由驾驶 ↔ 轨道投递 |
| `R` | 重置到起点；长按 3 秒反向播放 |
| `/` | 呼出 / 收起调参面板 |
| `T` | Night / Day 主题 |
| `F` ×3 | 在雾隧道里关掉雾（彩蛋） |

触屏：左半屏虚拟摇杆；轨道投递模式下按住蓄力、松手投递。手柄：左摇杆 + A 键。
首次交互后才解锁音频（浏览器策略），静音按钮在右下角。

到站后自动播放慢镜并弹出结算：逐跳延迟瀑布图、最慢一跳高亮、丢包路段镜头回放。
结算面板可以**录制到站后 8 秒的 WebM**（MediaRecorder；不支持时退回静态结算截图）以及
**复制分享链接**。

## 分享链接

`data/ShareCodec.ts` 把 `TraceResult` 用自实现的 LZSS + base64url 压进 URL hash（`#t=...`），
不依赖第三方库。分享链接在无痕窗口打开会还原同一个世界：

- 常规体量：整份 trace 无损往返；
- 编码后超过 8KB：自动降级为「target + 每跳摘要」（ttl / 首个地址 / 平均 RTT / 丢包 / 抖动 /
  ASN / geo / 匿名），`quality.truncated` 置 true。摘要仍保留所有影响布局的字段，因此地图一致。

## 数据从哪来

浏览器**不能**自己执行 `traceroute`。本项目只提供两种数据入口，且都不伪造数据：

1. **粘贴**你自己终端里的原始输出：Unix/BSD `traceroute`（含 `-A`、IPv6、`* * *`、多地址）、
   Windows `tracert`、`mtr --json`、`mtr -r` 宽表。整块识别格式，失败给示例与「强制解析」。
2. **内置合成样本**（5 条，用于展示不同地貌）。所有内置样本在数据里都带
   `source: "builtin"` 与 `synthetic: true`，界面上有「内置合成样本」角标，
   地址全部使用 RFC 5737 / 1918 / 100.64 文档保留段，不对应真实测量。

## 数据准确性让步清单（诚实说明）

这个项目的目标是「把网络数据变成好玩的空间」，**不是网络测量工具**。以下是有意的失真：

1. **段长做 sqrt 压缩**：`12 + 8·√avgMs` 米。否则 300ms 的一段会有几公里长，地图不可玩。
   代价是：距离之间的比例不再是线性的，不能靠目测比较 RTT。
2. **装饰地形没有数据支撑**：建筑高度、城市轮廓、路肩配色、远景剪影都是程序化装饰，
   不来自任何测量；只有「ASN 变化 → 色板/拱门切换」这一层与数据相关。
3. **隧道抹掉跳数粒度**：连续 ≥4 个匿名跳合并成一条 FogTunnel，内部不再逐跳分段；
   你看到的是「一段未知」，不是逐跳的拓扑。
4. **不做地理投影**：`geo` 只作为地面涂装与城市名，绝不按经纬度摆放。没有世界地图，
   也没有「从武汉到洛杉矶」的真实方位。
5. **结算只给相对结论**：瀑布条、最慢一跳、丢包回放都是相对比较；不提供带宽、路由策略、
   真实丢包原因的判断。私网地址一律落在家园区，不参与主干投影。

另外：`schema` 固定为 `packet-orb/1`；渲染层只消费 `TraceResult`，不读原始粘贴文本。
`as` / `geo` 为 `null` 时按 TTL 分桶兜底，不猜 ASN。

## 视觉与技术约束

- 场景内没有实时点光/聚光：matcap 图集 + 一张 2048 directional shadow map，远景用烘焙 AO 贴片。
- 所有几何 flatShading；建筑是 InstancedMesh；文字预烘焙进纹理图集，无运行时 SDF 字体。
- 画质三档：High（bloom + DOF + 粒子 + 阴影）/ Medium（bloom + 阴影，无 DOF）/ Low（仅 matcap）。
  自动按设备与 `prefers-reduced-motion` 调整，也可手动或 `?quality=medium` 指定。
- WebGL 不可用（或 `?nowebgl=1`）时，用同一份 `LayoutSolver` 输出渲染 SVG 俯视迷宫。
- 性能预算：静态场景 ≤120k 三角面、≤120 draw call、≤18 材质实例；首屏 gzip ≤4MB；
  桌面 High 60fps / 中端安卓 Medium 30fps。当前 dist 约 3.1MB（大头是 worker 里的 rapier wasm）。

## 目录

```
src/
  data/      Schema / PasteParser / MtrParser / Normalizer / BuiltinSamples / ShareCodec
  world/     LayoutSolver（唯一映射处）/ Terrain / RoadNetwork / Buildings / Props / Zones / FogTunnel
  sim/       PhysicsWorld（worker 门面）/ physicsWorker / SimCore / OrbController / Colliders / Triggers
  render/    Theme / MatcapMaterial / TextAtlas / Trail / Particles / PostFX / SvgFallback
  camera/    FollowRig / Cinematic
  ui/        TerminalPanel / HUD / ResultPanel / Achievements / InputMapper / TweakPanel / Recorder
  audio/     SfxBank（运行时合成 WAV，无音频资产）
tests/       解析夹具、分享编码、30 秒自动驾驶与跳台用例
```

数据 → 空间的唯一实现处是 `src/world/LayoutSolver.ts`；改地面几何等于改玩法，
必须重跑 `npm test`（30 秒自动驾驶 + 跳台用例）。只改建筑/材质/文字不影响物理。

## 无障碍

- 所有控件是可聚焦的原生 `button` / `select` / `textarea`，有可见焦点样式与 `aria-label`。
- canvas 标注 `role="img"` 与说明文本；状态行使用 `aria-live`。
- `prefers-reduced-motion: reduce` 时关闭镜头震动、到站慢镜与反放动画。
- 不依赖颜色传达唯一信息：TTL、毫秒、丢包率都有文本。

## 部署

### Vercel

仓库根的 `vercel.json` 已配置：构建 `npm run build`、输出 `dist/`、静态资源长缓存、
HTML 短缓存。Vercel 自动对文本资源做 brotli/gzip。

```bash
npx vercel --prod
```

### GitHub Pages

`.github/workflows/pages.yml` 会在 push 到 `main` 后构建并发布 `dist/`。
Vite `base` 是 `'./'`，所以 `/repo-name/` 子路径也能直接跑。

> GitHub Pages 不能自定义响应头（缓存头由平台决定）；需要严格的缓存策略时用 Vercel 或
> Cloudflare Pages。

## 已知限制

- 浏览器无法实时 traceroute；没有后端，也不调用外部 IP 定位 API。
- 移动端真机的 30fps 目标只在桌面 Chrome 上做过 CPU 降速代理测量，未覆盖真机。
- 分享链接的长度受浏览器 URL 限制；超长 trace 会降级为摘要（布局一致，逐跳细节减少）。

## 许可

代码为自制；不包含 bruno-simon.com / folio 等项目的模型、贴图或 matcap 资源。
三个依赖的许可证见 `package.json`（three / rapier3d / tweakpane 等）。
