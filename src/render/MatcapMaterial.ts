/**
 * 一张 matcap 图集复用全场景。
 *
 * 图集是 2×2 的程序化球体光照图（无外部资产）：
 *   0 soft    柔和高光——路面、地形
 *   1 metal   硬高光 + 暗部——建筑、栏杆
 *   2 rim     边缘发光——霓虹引导、球体外壳
 *   3 flat    近乎平涂——远景体块 / 涂装底
 *
 * 每个材质通过 onBeforeCompile 把 matcap 采样限制在对应格子里，
 * 因此全场景共用一个 texture、一个 shader 变体族，材质数量不随资产增长。
 */
import * as THREE from 'three';

export type MatcapCell = 0 | 1 | 2 | 3;

const ATLAS_SIZE = 1024;
const CELL_PX = ATLAS_SIZE / 2;

let atlasTexture: THREE.Texture | null = null;

function drawCell(ctx: CanvasRenderingContext2D, cell: number, x: number, y: number): void {
  const r = CELL_PX / 2 - 8;
  const cx = x + CELL_PX / 2;
  const cy = y + CELL_PX / 2;

  // 底色（含球外的中性灰，避免 mipmap 采样出黑边）
  ctx.fillStyle = '#8e8e8e';
  ctx.fillRect(x, y, CELL_PX, CELL_PX);

  const body = ctx.createRadialGradient(cx - r * 0.34, cy - r * 0.38, r * 0.05, cx, cy, r);
  if (cell === 0) {
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.35, '#e9e9e9');
    body.addColorStop(0.72, '#a9a9a9');
    body.addColorStop(1, '#3d3d3d');
  } else if (cell === 1) {
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.16, '#f2f2f2');
    body.addColorStop(0.36, '#b4b4b4');
    body.addColorStop(0.7, '#6a6a6a');
    body.addColorStop(1, '#1c1c1c');
  } else if (cell === 2) {
    body.addColorStop(0, '#5a5a5a');
    body.addColorStop(0.55, '#8a8a8a');
    body.addColorStop(0.86, '#d8d8d8');
    body.addColorStop(0.97, '#ffffff');
    body.addColorStop(1, '#9a9a9a');
  } else {
    body.addColorStop(0, '#f2f2f2');
    body.addColorStop(0.6, '#d2d2d2');
    body.addColorStop(1, '#9a9a9a');
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();

  // 一圈很弱的暗边，让低模边缘更“立”得住
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 10;
  ctx.stroke();
}

export function matcapAtlas(): THREE.Texture {
  if (atlasTexture) return atlasTexture;
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('matcap 图集：无法创建 2D canvas');
  for (let i = 0; i < 4; i += 1) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    drawCell(ctx, i, col * CELL_PX, row * CELL_PX);
  }
  atlasTexture = new THREE.CanvasTexture(canvas);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  // 不用 mipmap：图集格子在高 mip 级会互相渗色，路面在掠射角会整片发黑。
  atlasTexture.minFilter = THREE.LinearFilter;
  atlasTexture.magFilter = THREE.LinearFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.needsUpdate = true;
  return atlasTexture;
}

/** 屏幕空间球面 matcap 图集的格子偏移（2×2）。 */
export function cellOffset(cell: MatcapCell): THREE.Vector2 {
  const col = cell % 2;
  const row = Math.floor(cell / 2);
  // CanvasTexture 默认 flipY，所以行号从上往下要翻过来
  return new THREE.Vector2(col * 0.5, 1 - (row + 1) * 0.5);
}

export interface MatcapOptions {
  color?: THREE.ColorRepresentation;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  depthWrite?: boolean;
  polygonOffset?: boolean;
  fog?: boolean;
}

/**
 * 生成一个共享图集的 matcap 材质。同一个 cell / 参数组合会复用缓存，
 * 保证材质实例数不随段数增长。
 */
const cache = new Map<string, THREE.MeshMatcapMaterial>();

export function matcapMaterial(cell: MatcapCell, opts: MatcapOptions = {}): THREE.Material {
  const key = JSON.stringify({
    cell,
    color: opts.color ?? '#ffffff',
    vertexColors: opts.vertexColors ?? false,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
    depthWrite: opts.depthWrite ?? true,
    polygonOffset: opts.polygonOffset ?? false,
    fog: opts.fog ?? true,
  });
  const hit = cache.get(key);
  if (hit) return hit;

  // Node 侧（vitest）没有 canvas：用无光照材质兜底，碰撞体测试不关心外观。
  if (typeof document === 'undefined') {
    const plain = new THREE.MeshBasicMaterial({
      color: opts.color ?? '#ffffff',
      vertexColors: opts.vertexColors ?? false,
      side: opts.side ?? THREE.FrontSide,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      depthWrite: opts.depthWrite ?? true,
      fog: opts.fog ?? true,
    });
    plain.userData.poShared = true;
    cache.set(key, plain as unknown as THREE.MeshMatcapMaterial);
    return plain;
  }

  const offset = cellOffset(cell);
  const material = new THREE.MeshMatcapMaterial({
    matcap: matcapAtlas(),
    color: opts.color ?? '#ffffff',
    vertexColors: opts.vertexColors ?? false,
    flatShading: true,
    side: opts.side ?? THREE.FrontSide,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    depthWrite: opts.depthWrite ?? true,
    fog: opts.fog ?? true,
    polygonOffset: opts.polygonOffset ?? false,
    polygonOffsetFactor: opts.polygonOffset ? -1 : 0,
    polygonOffsetUnits: opts.polygonOffset ? -1 : 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMatcapScale = { value: new THREE.Vector2(0.5, 0.5) };
    shader.uniforms.uMatcapOffset = { value: offset };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'uniform sampler2D matcap;',
        'uniform sampler2D matcap;\nuniform vec2 uMatcapScale;\nuniform vec2 uMatcapOffset;',
      )
      .replace(
        'vec4 matcapColor = texture2D( matcap, uv );',
        'vec4 matcapColor = texture2D( matcap, uv * uMatcapScale + uMatcapOffset );',
      );
  };
  material.customProgramCacheKey = () => `po-matcap-${cell}`;
  // 共享材质：世界重建时只释放几何与贴图，不能 dispose 缓存里的材质，
  // 否则第二次粘贴会复用已销毁的 GPU 程序。
  material.userData.poShared = true;
  cache.set(key, material);
  return material;
}

export function disposeMatcapMaterials(): void {
  cache.forEach((m) => m.dispose());
  cache.clear();
  atlasTexture?.dispose();
  atlasTexture = null;
}
