import type { GradientData, GradientStop, PixelBuffer, RGBA } from '../../core/contracts';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function sampleGradient(stops: GradientStop[], t: number): RGBA {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const ct = clamp01(t);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (sorted.length === 1 || ct <= first.offset) return { ...first.color };
  if (ct >= last.offset) return { ...last.color };
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (ct >= a.offset && ct <= b.offset) {
      const span = b.offset - a.offset;
      const local = span === 0 ? 0 : (ct - a.offset) / span;
      return {
        r: a.color.r + (b.color.r - a.color.r) * local,
        g: a.color.g + (b.color.g - a.color.g) * local,
        b: a.color.b + (b.color.b - a.color.b) * local,
        a: a.color.a + (b.color.a - a.color.a) * local,
      };
    }
  }
  return { ...last.color };
}

export function renderGradient(w: number, h: number, g: GradientData): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  const buffer: PixelBuffer = { width: w, height: h, data };
  if (w <= 0 || h <= 0) return buffer;
  const diag = Math.sqrt(w * w + h * h);
  const halfDiag = diag / 2;
  const cx = w / 2;
  const cy = h / 2;
  const rad = ((Number.isFinite(g.angleDeg) ? g.angleDeg : 0) * Math.PI) / 180;
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t: number;
      if (g.kind === 'radial') {
        const dist = Math.hypot(px - cx, py - cy);
        t = halfDiag === 0 ? 0 : dist / halfDiag;
      } else {
        const proj = (px - cx) * dirX + (py - cy) * dirY;
        t = diag === 0 ? 0.5 : 0.5 + proj / diag;
      }
      t = clamp01(t);
      if (g.reverse) t = 1 - t;
      const c = sampleGradient(g.stops, t);
      const idx = (y * w + x) * 4;
      data[idx] = c.r;
      data[idx + 1] = c.g;
      data[idx + 2] = c.b;
      data[idx + 3] = c.a;
    }
  }
  return buffer;
}
