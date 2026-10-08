import type { PixelBuffer, RGBA, Selection } from '../../core/contracts';

export interface BrushSettings {
  size: number;
  hardness: number; // 0..1
  opacity: number; // 0..1
  flow: number; // 0..1
  spacing: number; // fraction of size, default .25
  roundness: number; // 0..1
  angleDeg: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function falloff(distNorm: number, hardness: number): number {
  if (distNorm >= 1) return 0;
  const h = clamp01(hardness);
  if (distNorm <= h) return 1;
  if (h >= 1) return 0;
  const t = (1 - distNorm) / (1 - h); // 0..1
  // smoothstep for a soft feather
  return t * t * (3 - 2 * t);
}

export function stampBrush(
  buf: PixelBuffer,
  cx: number,
  cy: number,
  s: BrushSettings,
  color: RGBA,
  mode: 'paint' | 'erase',
  selection?: Selection,
): void {
  const size = Math.max(0, s.size);
  if (size <= 0) return;
  const rx = size / 2;
  const rad = (s.angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const extent = rx + 1;
  const x0 = Math.max(0, Math.floor(cx - extent));
  const x1 = Math.min(buf.width - 1, Math.ceil(cx + extent));
  const y0 = Math.max(0, Math.floor(cy - extent));
  const y1 = Math.min(buf.height - 1, Math.ceil(cy + extent));
  const baseStrength = clamp01(s.opacity) * clamp01(s.flow);
  if (baseStrength <= 0) return;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // pixel-center offset
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // rotate into brush space
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      const ryEff = s.roundness === 0 ? 0.0001 : rx * clamp01(s.roundness);
      const nx = localX / rx;
      const ny = localY / ryEff;
      const dist = Math.sqrt(nx * nx + ny * ny);
      if (dist >= 1) continue;
      const f = falloff(dist, s.hardness);
      if (f <= 0) continue;
      let strength = baseStrength * f;
      if (selection) {
        if (x < selection.width && y < selection.height) {
          const cov = selection.mask[y * selection.width + x] ?? 0;
          strength *= cov / 255;
        } else {
          continue;
        }
        if (strength <= 0) continue;
      }
      const idx = (y * buf.width + x) * 4;
      if (mode === 'erase') {
        const da = (buf.data[idx + 3] ?? 0) / 255;
        const outA = da * (1 - strength);
        buf.data[idx + 3] = Math.round(outA * 255);
        // rgb unchanged (spec: rgb unchanged where alpha > 0; we leave rgb untouched entirely)
      } else {
        const sa = (color.a / 255) * strength;
        if (sa <= 0) continue;
        const da = (buf.data[idx + 3] ?? 0) / 255;
        const outA = sa + da * (1 - sa);
        if (outA <= 0) {
          buf.data[idx] = 0;
          buf.data[idx + 1] = 0;
          buf.data[idx + 2] = 0;
          buf.data[idx + 3] = 0;
          continue;
        }
        const dr = buf.data[idx] ?? 0;
        const dg = buf.data[idx + 1] ?? 0;
        const db = buf.data[idx + 2] ?? 0;
        buf.data[idx] = (color.r * sa + dr * da * (1 - sa)) / outA;
        buf.data[idx + 1] = (color.g * sa + dg * da * (1 - sa)) / outA;
        buf.data[idx + 2] = (color.b * sa + db * da * (1 - sa)) / outA;
        buf.data[idx + 3] = outA * 255;
      }
    }
  }
}

export function interpolateStrokePoints(
  points: { x: number; y: number; pressure?: number }[],
  s: BrushSettings,
): { x: number; y: number; pressure: number }[] {
  if (points.length === 0) return [];
  const step = Math.max(1, s.size * (s.spacing || 0));
  const out: { x: number; y: number; pressure: number }[] = [];
  const first = points[0]!;
  out.push({ x: first.x, y: first.y, pressure: first.pressure ?? 1 });
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const p0 = prev.pressure ?? 1;
    const p1 = curr.pressure ?? 1;
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) continue;
    const n = Math.ceil(dist / step);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      // Avoid pushing a point identical to the last emitted one (zero-length segments)
      const nx = prev.x + dx * t;
      const ny = prev.y + dy * t;
      const last = out[out.length - 1]!;
      if (last.x === nx && last.y === ny) continue;
      out.push({ x: nx, y: ny, pressure: p0 + (p1 - p0) * t });
    }
  }
  return out;
}

export function paintStroke(
  buf: PixelBuffer,
  points: { x: number; y: number; pressure?: number }[],
  s: BrushSettings,
  color: RGBA,
  mode: 'paint' | 'erase',
  selection?: Selection,
): void {
  const stamps = interpolateStrokePoints(points, s);
  for (const p of stamps) {
    const pressure = p.pressure ?? 1;
    if (pressure <= 0) continue;
    const eff: BrushSettings = {
      ...s,
      size: Math.max(0.0001, s.size * pressure),
      opacity: clamp01(s.opacity * pressure),
    };
    stampBrush(buf, p.x, p.y, eff, color, mode, selection);
  }
}
