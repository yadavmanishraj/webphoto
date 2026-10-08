import type { PixelBuffer } from '../../core/contracts';

/** Affine matrix [a,b,c,d,e,f]: x' = a*x + c*y + e ; y' = b*x + d*y + f */
export type Mat = [number, number, number, number, number, number];

export const matIdentity = (): Mat => [1, 0, 0, 1, 0, 0];

/** Apply n first, then m (i.e. m ∘ n). */
export function matMultiply(m: Mat, n: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = m; const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
  ];
}

export const matTranslate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];
export const matScale = (sx: number, sy: number = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function matRotate(deg: number): Mat {
  const rad = (deg * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  // Snap near-zero values so exact 90° rotations stay pixel-exact.
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return [snap(cos), snap(sin), snap(-sin), snap(cos), 0, 0];
}

export function matApply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function matInvert(m: Mat): Mat | null {
  const [a, b, c, d, e, f] = m; const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function transformedBounds(w: number, h: number, m: Mat): { x: number; y: number; w: number; h: number } {
  const pts = [matApply(m, 0, 0), matApply(m, w, 0), matApply(m, 0, h), matApply(m, w, h)];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  const x1 = Math.ceil(Math.max(...xs)), y1 = Math.ceil(Math.max(...ys));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function transformBuffer(src: PixelBuffer, m: Mat, outW: number, outH: number, interp: 'nearest' | 'bilinear'): PixelBuffer {
  const out: PixelBuffer = { width: outW, height: outH, data: new Uint8ClampedArray(outW * outH * 4) };
  const inv = matInvert(m); if (!inv) return out;
  const sw = src.width, sh = src.height, sd = src.data;
  for (let dy = 0; dy < outH; dy++) for (let dx = 0; dx < outW; dx++) {
    const s = matApply(inv, dx, dy); const oi = (dy * outW + dx) * 4;
    if (interp === 'nearest') {
      const sx = Math.round(s.x), sy = Math.round(s.y);
      if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;
      const si = (sy * sw + sx) * 4;
      for (let c = 0; c < 4; c++) out.data[oi + c] = sd[si + c]!;
    } else {
      const x0 = Math.floor(s.x), y0 = Math.floor(s.y);
      const fx = s.x - x0, fy = s.y - y0;
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        const corners: [number, number, number][] = [
          [x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)],
          [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy],
        ];
        for (const [cx, cy, wgt] of corners) {
          if (cx < 0 || cx >= sw || cy < 0 || cy >= sh) continue; // outside = transparent
          acc += sd[(cy * sw + cx) * 4 + c]! * wgt;
        }
        out.data[oi + c] = acc;
      }
    }
  }
  return out;
}
