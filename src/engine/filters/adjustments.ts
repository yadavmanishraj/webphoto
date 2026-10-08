/**
 * Adjustment operations (prompt §29). Each takes a PixelBuffer and an
 * AdjustmentData and returns a NEW PixelBuffer; the input is never
 * mutated. Alpha is preserved by every adjustment. All pixel data is
 * non-premultiplied RGBA.
 *
 * Param conventions:
 *  - brightness-contrast: brightness -100..100 (additive, scaled to 255),
 *    contrast -100..100 (standard contrast factor curve).
 *  - hue-saturation: hue in degrees (-180..180), saturation -100..100
 *    (percent scale), lightness -100..100 (additive percent of range).
 *  - levels: { inBlack, inWhite, gamma, outBlack, outWhite } in 0..255
 *    (gamma is a plain exponent divisor, typically 0.1..10).
 *  - gamma: { gamma } — out = 255 * (in/255)^(1/gamma).
 *  - color-balance: { r, g, b } shifts -100..100, scaled to 255.
 *  - posterize: { levels } number of levels per channel (>= 2).
 *  - threshold: { threshold } 0..255 luminance cut-off.
 */
import type { AdjustmentData, PixelBuffer } from '../../core/contracts';

function param(params: Record<string, number>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** RGB (0..255) -> HSL (h 0..360, s 0..1, l 0..1). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

/** HSL (h 0..360, s 0..1, l 0..1) -> RGB (0..255). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hn = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return (p + (q - p) * 6 * tn) * 255;
    if (tn < 1 / 2) return q * 255;
    if (tn < 2 / 3) return (p + (q - p) * (2 / 3 - tn) * 6) * 255;
    return p * 255;
  };
  return [channel(hn + 1 / 3), channel(hn), channel(hn - 1 / 3)];
}

type ChannelFn = (r: number, g: number, b: number, i: number) => [number, number, number];

function mapPixels(buf: PixelBuffer, fn: ChannelFn): PixelBuffer {
  const out = new Uint8ClampedArray(buf.data.length);
  const src = buf.data;
  for (let i = 0; i < src.length; i += 4) {
    const [r, g, b] = fn(src[i]!, src[i + 1]!, src[i + 2]!, i);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = src[i + 3]!;
  }
  return { width: buf.width, height: buf.height, data: out };
}

export function applyAdjustment(buf: PixelBuffer, adj: AdjustmentData): PixelBuffer {
  const p = adj.params;
  switch (adj.kind) {
    case 'brightness-contrast': {
      const brightness = param(p, 'brightness', 0);
      const contrast = param(p, 'contrast', 0);
      const offset = (brightness / 100) * 255;
      const c = (contrast / 100) * 255;
      const factor = (259 * (c + 255)) / (255 * (259 - c));
      return mapPixels(buf, (r, g, b) => [
        factor * (r - 128) + 128 + offset,
        factor * (g - 128) + 128 + offset,
        factor * (b - 128) + 128 + offset,
      ]);
    }
    case 'hue-saturation': {
      const hue = param(p, 'hue', 0);
      const saturation = param(p, 'saturation', 0);
      const lightness = param(p, 'lightness', 0);
      return mapPixels(buf, (r, g, b) => {
        const [h, s, l] = rgbToHsl(r, g, b);
        const ns = Math.min(1, Math.max(0, saturation >= 0
          ? s + (1 - s) * (saturation / 100)
          : s * (1 + saturation / 100)));
        const nl = Math.min(1, Math.max(0, l + lightness / 100));
        return hslToRgb(h + hue, ns, nl);
      });
    }
    case 'levels': {
      const inBlack = param(p, 'inBlack', 0);
      const inWhite = param(p, 'inWhite', 255);
      const gamma = param(p, 'gamma', 1);
      const outBlack = param(p, 'outBlack', 0);
      const outWhite = param(p, 'outWhite', 255);
      if (gamma <= 0) throw new Error('levels: gamma must be > 0');
      const range = inWhite - inBlack;
      const apply = (v: number): number => {
        const t = range > 0 ? Math.min(1, Math.max(0, (v - inBlack) / range)) : 0;
        return outBlack + Math.pow(t, 1 / gamma) * (outWhite - outBlack);
      };
      return mapPixels(buf, (r, g, b) => [apply(r), apply(g), apply(b)]);
    }
    case 'gamma': {
      const gamma = param(p, 'gamma', 1);
      if (gamma <= 0) throw new Error('gamma: gamma must be > 0');
      const apply = (v: number): number => 255 * Math.pow(v / 255, 1 / gamma);
      return mapPixels(buf, (r, g, b) => [apply(r), apply(g), apply(b)]);
    }
    case 'color-balance': {
      const dr = (param(p, 'r', 0) / 100) * 255;
      const dg = (param(p, 'g', 0) / 100) * 255;
      const db = (param(p, 'b', 0) / 100) * 255;
      return mapPixels(buf, (r, g, b) => [r + dr, g + dg, b + db]);
    }
    case 'invert':
      return mapPixels(buf, (r, g, b) => [255 - r, 255 - g, 255 - b]);
    case 'grayscale':
      return mapPixels(buf, (r, g, b) => {
        const y = luminance(r, g, b);
        return [y, y, y];
      });
    case 'posterize': {
      const levels = Math.max(2, Math.floor(param(p, 'levels', 4)));
      const apply = (v: number): number =>
        (Math.round((v / 255) * (levels - 1)) / (levels - 1)) * 255;
      return mapPixels(buf, (r, g, b) => [apply(r), apply(g), apply(b)]);
    }
    case 'threshold': {
      const t = param(p, 'threshold', 128);
      return mapPixels(buf, (r, g, b) => {
        const v = luminance(r, g, b) >= t ? 255 : 0;
        return [v, v, v];
      });
    }
    default:
      throw new Error(`Unknown adjustment kind: ${String((adj as AdjustmentData).kind)}`);
  }
}
