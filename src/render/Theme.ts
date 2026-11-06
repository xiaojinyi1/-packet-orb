/**
 * 双主题色板（Night / Day）。
 * 所有世界生成器都从这里取色，切换主题时重建世界即可生效；
 * 主题切换不触碰数据契约与布局算法。
 */

export type ThemeName = 'night' | 'day';

export interface Palette {
  name: ThemeName;
  /** 天空/背景渐变（渲染时用 scene.background 纯色即可，远景色用雾） */
  skyTop: string;
  skyBottom: string;
  fog: string;
  ground: string;
  grid: string;
  gridMajor: string;
  road: string;
  pit: string;
  ramp: string;
  landing: string;
  wall: string;
  guide: string;
  danger: string;
  finish: string;
  trampoline: string;
  buildings: string[];
  /** 地面涂装/路牌文字颜色 */
  ink: string;
  inkDim: string;
}

export const THEMES: Record<ThemeName, Palette> = {
  night: {
    name: 'night',
    skyTop: '#161233',
    skyBottom: '#2E1F5B',
    fog: '#161233',
    ground: '#120e26',
    grid: '#241d47',
    gridMajor: '#382c6b',
    road: '#D9D2C5',
    pit: '#8B8274',
    ramp: '#FF7A45',
    landing: '#C6BFB1',
    wall: '#2A2350',
    guide: '#2ED3C6',
    danger: '#FF2E88',
    finish: '#FFE447',
    trampoline: '#FF2E88',
    buildings: ['#2ED3C6', '#FF7A45', '#FF2E88', '#FFE447', '#8F86FF'],
    ink: '#F4EFE2',
    inkDim: '#B9AFD6',
  },
  day: {
    name: 'day',
    skyTop: '#F6D7AE',
    skyBottom: '#E8B98C',
    fog: '#EBC9A3',
    ground: '#E7C79C',
    grid: '#D8B68C',
    gridMajor: '#C6A277',
    road: '#F4E9D6',
    pit: '#B08F6E',
    ramp: '#F06A3A',
    landing: '#E4D2B8',
    wall: '#7C6A9C',
    guide: '#2FB8A8',
    danger: '#E02A72',
    finish: '#FFC93C',
    trampoline: '#E02A72',
    buildings: ['#2FB8A8', '#F0743E', '#D94A8C', '#FFC93C', '#7F74E8'],
    ink: '#2A1F3D',
    inkDim: '#5B4B78',
  },
};

let active: ThemeName = 'night';

export function setTheme(name: ThemeName): void {
  active = name;
}

export function getThemeName(): ThemeName {
  return active;
}

export function palette(): Palette {
  return THEMES[active];
}

/** 某分区（ASN）的主题色：按分区序号在色板里循环，保证同 ASN 同色。 */
export function zonePaletteColor(index: number): string {
  const colors = palette().buildings;
  return colors[((index % colors.length) + colors.length) % colors.length];
}

/** 按主题给建筑一点明度扰动，避免整片死板。 */
export function buildingTint(zoneIndex: number, rand: number): string {
  const base = zonePaletteColor(zoneIndex);
  const c = base.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  // 建筑不要整城同色：向混凝土灰混 52%~64%，只保留 zone 的色相暗示。
  const k = 0.86 + rand * 0.26;
  const t = 0.52 + rand * 0.12;
  const mix = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v * (1 - t) + 176 * t) * k)));
  return `#${mix(r).toString(16).padStart(2, '0')}${mix(g).toString(16).padStart(2, '0')}${mix(b)
    .toString(16)
    .padStart(2, '0')}`;
}
