import type { PixelBuffer, RGBA, ShapeData } from '../../core/contracts';

function pointInPolygon(px: number, py: number, verts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i]!.x;
    const yi = verts[i]!.y;
    const xj = verts[j]!.x;
    const yj = verts[j]!.y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonVertices(w: number, h: number, sides: number): { x: number; y: number }[] {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2;
  const n = Math.max(3, Math.floor(sides));
  const verts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    verts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
  }
  return verts;
}

function insideRounded(x: number, y: number, w: number, h: number, r: number): boolean {
  if (x < 0 || x > w || y < 0 || y > h) return false;
  if (r <= 0) return true;
  if (x >= r && x <= w - r) return true;
  if (y >= r && y <= h - r) return true;
  const ccx = x < r ? r : w - r;
  const ccy = y < r ? r : h - r;
  const dx = x - ccx;
  const dy = y - ccy;
  return dx * dx + dy * dy <= r * r;
}

/** Is point (x,y) inside the shape geometry defined in a w×h box at origin? */
function insideGeometry(shape: ShapeData, w: number, h: number, x: number, y: number): boolean {
  if (w <= 0 || h <= 0) return false;
  switch (shape.kind) {
    case 'rectangle':
      return x >= 0 && x < w && y >= 0 && y < h;
    case 'rounded-rectangle': {
      const r = Math.min(shape.cornerRadius, w / 2, h / 2);
      return insideRounded(x, y, w, h, r);
    }
    case 'ellipse': {
      const rx = w / 2;
      const ry = h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const nx = (x - rx) / rx;
      const ny = (y - ry) / ry;
      return nx * nx + ny * ny <= 1;
    }
    case 'polygon':
      return pointInPolygon(x, y, polygonVertices(w, h, shape.sides));
    case 'line': {
      const thickness = shape.strokeWidth || 2;
      return x >= 0 && x < w && Math.abs(y - h / 2) <= thickness / 2;
    }
    default:
      return false;
  }
}

export function pointInShape(shape: ShapeData, x: number, y: number): boolean {
  return insideGeometry(shape, shape.w, shape.h, x, y);
}

function setPixel(data: Uint8ClampedArray, w: number, x: number, y: number, c: RGBA): void {
  const idx = (y * w + x) * 4;
  data[idx] = c.r;
  data[idx + 1] = c.g;
  data[idx + 2] = c.b;
  data[idx + 3] = c.a;
}

export function rasterizeShape(shape: ShapeData): PixelBuffer {
  const w = Math.max(0, Math.floor(shape.w));
  const h = Math.max(0, Math.floor(shape.h));
  const data = new Uint8ClampedArray(w * h * 4);
  const buffer: PixelBuffer = { width: w, height: h, data };
  if (w <= 0 || h <= 0) return buffer;

  if (shape.kind === 'line') {
    const color: RGBA | null = shape.fill ?? shape.stroke;
    if (!color) return buffer;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (insideGeometry(shape, w, h, x + 0.5, y + 0.5)) setPixel(data, w, x, y, color);
      }
    }
    return buffer;
  }

  // Stroke ring exists only when a stroke color is actually set.
  const sw = shape.stroke && shape.strokeWidth > 0 ? shape.strokeWidth : 0;
  const innerW = w - 2 * sw;
  const innerH = h - 2 * sw;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (!insideGeometry(shape, w, h, px, py)) continue;
      let isStroke = false;
      if (sw > 0) {
        if (innerW <= 0 || innerH <= 0) {
          isStroke = true;
        } else {
          const innerShape: ShapeData = {
            ...shape,
            w: innerW,
            h: innerH,
            cornerRadius: Math.max(0, shape.cornerRadius - sw),
          };
          isStroke = !insideGeometry(innerShape, innerW, innerH, px - sw, py - sw);
        }
      }
      if (isStroke) {
        if (shape.stroke) setPixel(data, w, x, y, shape.stroke);
      } else if (shape.fill) {
        setPixel(data, w, x, y, shape.fill);
      }
    }
  }
  return buffer;
}
