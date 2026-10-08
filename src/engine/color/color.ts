/**
 * Color conversions. All RGBA channels are 0..255 (non-premultiplied).
 * Hue is 0..360 degrees; saturation / lightness / value are 0..1.
 * Alpha is preserved through HSL/HSV conversions.
 */
import type { RGBA } from '../../core/contracts';

export interface HSLA {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
  a: number; // 0..255
}

export interface HSVA {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
  a: number; // 0..255
}

const clamp255 = (n: number): number =>
  Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0;

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

/** Normalize a hue to [0, 360). */
const normalizeHue = (h: number): number => {
  if (!Number.isFinite(h)) return 0;
  const m = h % 360;
  return m < 0 ? m + 360 : m;
};

const toHex2 = (n: number): string =>
  Math.round(clamp255(n)).toString(16).padStart(2, '0');

/**
 * Convert RGBA to a lowercase hex string.
 * Returns `#rrggbb` when fully opaque, `#rrggbbaa` otherwise,
 * so the value always round-trips through hexToRgba.
 */
export function rgbaToHex(c: RGBA): string {
  const base = `#${toHex2(c.r)}${toHex2(c.g)}${toHex2(c.b)}`;
  return clamp255(c.a) === 255 ? base : `${base}${toHex2(c.a)}`;
}

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa` (leading `#` required).
 * Returns null for any malformed input.
 */
export function hexToRgba(s: string): RGBA | null {
  if (typeof s !== 'string') return null;
  const m = /^#([0-9a-fA-F]+)$/.exec(s.trim());
  if (!m) return null;
  const hex = m[1] as string;
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt((hex[0] as string) + (hex[0] as string), 16);
    const g = parseInt((hex[1] as string) + (hex[1] as string), 16);
    const b = parseInt((hex[2] as string) + (hex[2] as string), 16);
    const a =
      hex.length === 4
        ? parseInt((hex[3] as string) + (hex[3] as string), 16)
        : 255;
    return { r, g, b, a };
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    return { r, g, b, a };
  }
  return null;
}

/** RGB(A) -> HSL(A). Alpha is copied unchanged. */
export function rgbToHsl(c: RGBA): HSLA {
  const r = clamp255(c.r) / 255;
  const g = clamp255(c.g) / 255;
  const b = clamp255(c.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h: normalizeHue(h), s: clamp01(s), l: clamp01(l), a: clamp255(c.a) };
}

function hueToRgb(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL(A) -> RGB(A). `a` defaults to 255 (opaque) when omitted. */
export function hslToRgb(c: { h: number; s: number; l: number; a?: number }): RGBA {
  const h = normalizeHue(c.h) / 360;
  const s = clamp01(c.s);
  const l = clamp01(c.l);
  const a = c.a === undefined ? 255 : clamp255(c.a);
  let r: number;
  let g: number;
  let b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, h + 1 / 3);
    g = hueToRgb(p, q, h);
    b = hueToRgb(p, q, h - 1 / 3);
  }
  return {
    r: Math.round(clamp01(r) * 255),
    g: Math.round(clamp01(g) * 255),
    b: Math.round(clamp01(b) * 255),
    a,
  };
}

/** RGB(A) -> HSV(A). Alpha is copied unchanged. */
export function rgbToHsv(c: RGBA): HSVA {
  const r = clamp255(c.r) / 255;
  const g = clamp255(c.g) / 255;
  const b = clamp255(c.b) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const s = max === 0 ? 0 : d / max;
  return { h: normalizeHue(h), s: clamp01(s), v: clamp01(max), a: clamp255(c.a) };
}

/** HSV(A) -> RGB(A). `a` defaults to 255 (opaque) when omitted. */
export function hsvToRgb(c: { h: number; s: number; v: number; a?: number }): RGBA {
  const h = normalizeHue(c.h);
  const s = clamp01(c.s);
  const v = clamp01(c.v);
  const a = c.a === undefined ? 255 : clamp255(c.a);
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (h < 60) {
    rp = chroma; gp = x;
  } else if (h < 120) {
    rp = x; gp = chroma;
  } else if (h < 180) {
    gp = chroma; bp = x;
  } else if (h < 240) {
    gp = x; bp = chroma;
  } else if (h < 300) {
    rp = x; bp = chroma;
  } else {
    rp = chroma; bp = x;
  }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
    a,
  };
}

/**
 * Parse a color string: any hex form accepted by hexToRgba, or CSS-style
 * `rgb(r, g, b)` / `rgba(r, g, b, a)` where channels are 0..255 and the
 * CSS alpha is a 0..1 float. Returns null for anything else.
 */
export function parseColor(s: string): RGBA | null {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (trimmed.startsWith('#')) return hexToRgba(trimmed);

  const rgbMatch =
    /^rgb\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)$/i.exec(
      trimmed,
    );
  if (rgbMatch) {
    return {
      r: Math.round(clamp255(Number(rgbMatch[1]))),
      g: Math.round(clamp255(Number(rgbMatch[2]))),
      b: Math.round(clamp255(Number(rgbMatch[3]))),
      a: 255,
    };
  }
  const rgbaMatch =
    /^rgba\(\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\)$/i.exec(
      trimmed,
    );
  if (rgbaMatch) {
    return {
      r: Math.round(clamp255(Number(rgbaMatch[1]))),
      g: Math.round(clamp255(Number(rgbaMatch[2]))),
      b: Math.round(clamp255(Number(rgbaMatch[3]))),
      a: Math.round(clamp01(Number(rgbaMatch[4])) * 255),
    };
  }
  return null;
}
