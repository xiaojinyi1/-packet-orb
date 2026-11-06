# CHANGELOG

本项目的里程碑按可验收的能力划分，而不是按日期。

## P4 — 可分享与上线收尾（当前）

- 新增 `data/ShareCodec.ts`：自实现 LZSS + base64url，把 `TraceResult` 编进 URL hash；
  超 8KB 自动降级为 target + 每跳摘要，布局仍完全一致。
- 终端与结算面板增加「复制分享链接」；启动时读取 hash 还原世界（无痕窗口已验证同一布局）。
- 新增 `ui/Recorder.ts`：到站后用 MediaRecorder 录 8 秒 canvas → WebM 下载；
  不支持或失败时退回静态结算截图。
- 启动页演出：球从空中掉落、弹两下，镜头拉起；`prefers-reduced-motion` 时跳过。
- `index.html` 增加 title / description / OG / Twitter 卡片；新增 `public/og.png`。
- `__PO_METRICS` 增加 `firstFrameMs` / `firstInteractiveMs`。
- 新增 README（含数据准确性让步清单）、本 CHANGELOG、`vercel.json`、GitHub Pages workflow。
- 测试：16 个用例（解析 8 / 分享 4 / 物理 4）。

## P3 — 作品集视觉与输入

- matcap 图集（1024²，2×2 球面）、Night / Day 双主题、每 ASN 主题色。
- 球体拖尾（additive ribbon）、碰撞烟尘（圆形软点）、隧道内霓虹引导线呼吸。
- 文字图集：地面涂装 + 路牌（ttl / IP / RTT / loss / 城市）。
- 电影镜头：到站慢镜、隧道出口拉升、轨道投递模式。
- 三输入：键盘 / 触屏左摇杆 / Gamepad；输入源切换提示。
- 12 条成就彩蛋（右下轻提示）、howler 运行时合成音效。
- 画质三档 + WebGL 不可用时 SVG 俯视迷宫降级。
- 修复：共享 matcap 材质在重建世界时被 dispose、拖尾采样阈值、路面 matcap 格子过暗。

## P2 — 解析与完整迷宫生成

- `PasteParser`（Unix traceroute / Windows tracert）+ `MtrParser`（--json / -r）+ `Normalizer`。
- 5 条内置合成样本，标注 `synthetic`。
- `LayoutSolver` 输出节点、分区、雾隧道、装饰语义；连续 ≥4 匿名跳合并成一条 FogTunnel。
- `Terrain` / `Buildings`（InstancedMesh）/ `Props`（拱门、终点门、家园区）/ `FogTunnel`。
- 终端粘贴面板、1.2 秒内 gsap 形变重建世界；HUD 与到站结算瀑布图。
- 修复：家园区台地与路面共面导致的 z-fighting、建筑悬空、蹦床 pad 吃速度。

## P1 — 灰盒物理与镜头

- Vite + TS 骨架；rapier3d 在 Web Worker，固定 1/60 步长，transferable Float32Array 同步位姿，
  渲染侧插值。
- 球体：icosphere detail 2、半径 0.45、质量 1.2、70% 力矩 + 30% 直接力、
  drive assist 随速度衰减到 40%。
- 8 跳合成样本生成主干道：坡度、坑洞、蹦床、2.6m 断口跳台、拱门。
- 追尾镜头：0.18s 位置滞后、注视前方 4 单位、FOV 65→78、落地压镜。
- tweakpane 调参面板与重置按钮；30 秒自动驾驶回归测试。
