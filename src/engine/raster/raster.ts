/**
 * Raster core: creation and manipulation of PixelBuffers.
 * Pixel data is NON-premultiplied RGBA, row-major, Uint8ClampedArray,
 * length = width * height * 4 (see contracts.ts). No UI code here.
 */
import { LIMITS } from '../../core/contracts';
import type { PixelBuffer, RGBA } from '../../core/contracts';

function assertDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > LIMITS.maxDimension) {
    throw new RangeError(
      `${name} must be an integer in 1..${LIMITS.maxDimension}, got ${value}`,
    );
  }
}

const clamp255 = (n: number): number =>
  Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : 0;

/** Create a buffer, optionally filled with `fill` (default: transparent). */
export function createBuffer(w: number, h: number, fill?: RGBA): PixelBuffer {
  assertDimension(w, 'width');
  assertDimension(h, 'height');
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) {
    const r = clamp255(fill.r);
    const g = clamp255(fill.g);
    const b = clamp255(fill.b);
    const a = clamp255(fill.a);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

/** Deep copy: the clone shares no storage with the source. */
export function cloneBuffer(buf: PixelBuffer): PixelBuffer {
  return {
    width: buf.width,
    height: buf.height,
    data: new Uint8ClampedArray(buf.data),
  };
}

const inBounds = (buf: PixelBuffer, x: number, y: number): boolean =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  x >= 0 &&
  y >= 0 &&
  x < buf.width &&
  y < buf.height;

/** Read a pixel. Out-of-bounds reads return transparent black. */
export function getPixel(buf: PixelBuffer, x: number, y: number): RGBA {
  if (!inBounds(buf, x, y)) return { r: 0, g: 0, b: 0, a: 0 };
  const i = (y * buf.width + x) * 4;
  return {
    r: buf.data[i] ?? 0,
    g: buf.data[i + 1] ?? 0,
    b: buf.data[i + 2] ?? 0,
    a: buf.data[i + 3] ?? 0,
  };
}

/** Write a pixel (channels clamped/rounded). Out-of-bounds writes are ignored. */
export function setPixel(buf: PixelBuffer, x: number, y: number, color: RGBA): void {
  if (!inBounds(buf, x, y)) return;
  const i = (y * buf.width + x) * 4;
  buf.data[i] = clamp255(color.r);
  buf.data[i + 1] = clamp255(color.g);
  buf.data[i + 2] = clamp255(color.b);
  buf.data[i + 3] = clamp255(color.a);
}

/** Fill a rectangle, clipped to the buffer. Non-positive w/h is a no-op. */
export function fillRect(
  buf: PixelBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGBA,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(buf.width, Math.floor(x) + Math.floor(w));
  const y1 = Math.min(buf.height, Math.floor(y) + Math.floor(h));
  if (x1 <= x0 || y1 <= y0) return;
  const r = clamp255(color.r);
  const g = clamp255(color.g);
  const b = clamp255(color.b);
  const a = clamp255(color.a);
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * buf.width + x0) * 4;
    for (let xx = x0; xx < x1; xx++) {
      buf.data[i] = r;
      buf.data[i + 1] = g;
      buf.data[i + 2] = b;
      buf.data[i + 3] = a;
      i += 4;
    }
  }
}

/** Set every pixel to transparent black. */
export function clearBuffer(buf: PixelBuffer): void {
  buf.data.fill(0);
}

/**
 * Crop to the rectangle (x, y, w, h). Pixels of the crop rectangle that
 * fall outside the source are transparent. Throws on non-positive /
 * oversized w or h (same rule as createBuffer).
 */
export function cropBuffer(
  buf: PixelBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
): PixelBuffer {
  const out = createBuffer(w, h); // validates w/h
  const sx0 = Math.max(0, Math.floor(x));
  const sy0 = Math.max(0, Math.floor(y));
  const sx1 = Math.min(buf.width, Math.floor(x) + w);
  const sy1 = Math.min(buf.height, Math.floor(y) + h);
  if (sx1 <= sx0 || sy1 <= sy0) return out;
  const offsetX = sx0 - Math.floor(x);
  const offsetY = sy0 - Math.floor(y);
  const rowPx = sx1 - sx0;
  for (let row = 0; row < sy1 - sy0; row++) {
    const srcStart = ((sy0 + row) * buf.width + sx0) * 4;
    const dstStart = ((offsetY + row) * w + offsetX) * 4;
    out.data.set(buf.data.subarray(srcStart, srcStart + rowPx * 4), dstStart);
  }
  return out;
}

/** Return a new buffer flipped horizontally ('h') or vertically ('v'). */
export function flipBuffer(buf: PixelBuffer, dir: 'h' | 'v'): PixelBuffer {
  const out = createBuffer(buf.width, buf.height);
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const dx = dir === 'h' ? buf.width - 1 - x : x;
      const dy = dir === 'v' ? buf.height - 1 - y : y;
      const si = (y * buf.width + x) * 4;
      const di = (dy * buf.width + dx) * 4;
      out.data[di] = buf.data[si] ?? 0;
      out.data[di + 1] = buf.data[si + 1] ?? 0;
      out.data[di + 2] = buf.data[si + 2] ?? 0;
      out.data[di + 3] = buf.data[si + 3] ?? 0;
    }
  }
  return out;
}

/**
 * Resize to (newW, newH). Throws on invalid target dimensions.
 * - 'nearest': each destination pixel copies the nearest source pixel.
 * - 'bilinear': pixel-center mapping, src = (dst + 0.5) * (srcSize/dstSize) - 0.5,
 *   clamped to the source extent, linear interpolation per channel
 *   (including alpha, on non-premultiplied values).
 */
export function resizeBuffer(
  buf: PixelBuffer,
  newW: number,
  newH: number,
  method: 'nearest' | 'bilinear',
): PixelBuffer {
  const out = createBuffer(newW, newH); // validates newW/newH
  const { width: sw, height: sh, data } = buf;

  if (method === 'nearest') {
    for (let y = 0; y < newH; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / newH));
      for (let x = 0; x < newW; x++) {
        const sx = Math.min(sw - 1, Math.floor((x * sw) / newW));
        const si = (sy * sw + sx) * 4;
        const di = (y * newW + x) * 4;
        out.data[di] = data[si] ?? 0;
        out.data[di + 1] = data[si + 1] ?? 0;
        out.data[di + 2] = data[si + 2] ?? 0;
        out.data[di + 3] = data[si + 3] ?? 0;
      }
    }
    return out;
  }

  // bilinear
  for (let y = 0; y < newH; y++) {
    const srcY = Math.min(
      sh - 1,
      Math.max(0, ((y + 0.5) * sh) / newH - 0.5),
    );
    const y0 = Math.floor(srcY);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = srcY - y0;
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(
        sw - 1,
        Math.max(0, ((x + 0.5) * sw) / newW - 0.5),
      );
      const x0 = Math.floor(srcX);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = srcX - x0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const di = (y * newW + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top =
          (data[i00 + ch] ?? 0) * (1 - fx) + (data[i10 + ch] ?? 0) * fx;
        const bottom =
          (data[i01 + ch] ?? 0) * (1 - fx) + (data[i11 + ch] ?? 0) * fx;
        out.data[di + ch] = top * (1 - fy) + bottom * fy;
      }
    }
  }
  return out;
}
