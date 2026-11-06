/**
 * WebGL 不可用时的 2D 降级：用同一份 Layout 画俯视迷宫 SVG。
 * 不复制任何数据逻辑——只消费 solveLayout 的结果。
 */
import type { Layout } from '../world/LayoutSolver';
import { palette } from './Theme';

export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function renderSvgFallback(host: HTMLElement, layout: Layout): SVGSVGElement {
  const p = palette();
  const w = 1000;
  const h = 700;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of layout.samples) {
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x);
    minZ = Math.min(minZ, s.z);
    maxZ = Math.max(maxZ, s.z);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const scale = Math.min((w - 120) / spanX, (h - 120) / spanZ);
  const ox = (w - spanX * scale) / 2 - minX * scale;
  const oz = (h - spanZ * scale) / 2 - minZ * scale;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('class', 'po-svg-maze');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Packet Orb 迷宫俯视图（WebGL 不可用时的降级视图）');

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('fill', p.skyTop);
  svg.appendChild(bg);

  const points = layout.samples.map((s) => `${ox + s.x * scale},${oz + s.z * scale}`).join(' ');
  const outline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  outline.setAttribute('points', points);
  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', p.wall);
  outline.setAttribute('stroke-width', String(28));
  outline.setAttribute('stroke-linejoin', 'round');
  outline.setAttribute('stroke-linecap', 'round');
  svg.appendChild(outline);

  const road = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  road.setAttribute('points', points);
  road.setAttribute('fill', 'none');
  road.setAttribute('stroke', p.road);
  road.setAttribute('stroke-width', String(20));
  road.setAttribute('stroke-linejoin', 'round');
  road.setAttribute('stroke-linecap', 'round');
  svg.appendChild(road);

  const guide = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  guide.setAttribute('points', points);
  guide.setAttribute('fill', 'none');
  guide.setAttribute('stroke', p.guide);
  guide.setAttribute('stroke-width', '2');
  guide.setAttribute('stroke-dasharray', '10 8');
  svg.appendChild(guide);

  for (const node of layout.nodes) {
    const cx = ox + node.x * scale;
    const cy = oz + node.z * scale;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', String(cx));
    dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', node.anonymous ? '4' : '7');
    dot.setAttribute('fill', node.anonymous ? p.inkDim : p.finish);
    svg.appendChild(dot);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(cx + 10));
    label.setAttribute('y', String(cy - 10));
    label.setAttribute('fill', p.ink);
    label.setAttribute('font-size', '13');
    label.setAttribute('font-family', 'monospace');
    label.textContent = `T${node.ttl}`;
    svg.appendChild(label);
  }

  host.appendChild(svg);
  return svg;
}
