/**
 * Blend modes + alpha compositing, per W3C "Compositing and Blending
 * Level 1". All pixel data is NON-premultiplied RGBA (see contracts.ts).
 *
 * For a source (blend) color Cs with effective alpha `as` over a backdrop
 * (destination) color Cb with alpha `ab`:
 *   ao = as + ab * (1 - as)
 *   co = as*(1-ab)*Cs + as*ab*B(Cb, Cs) + (1-as)*ab*Cb   (premultiplied)
 *   Co = ao === 0 ? 0 : co / ao                          (non-premultiplied)
 * where B is the separable blend function implemented by blendChannel.
 */
import type { BlendMode, MaskBuffer, PixelBuffer } from '../../core/contracts';

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

/** The D(cb) helper of the W3C soft-light formula. Inputs/outputs 0..1. */
function softLightD(cb: number): number {
  return cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
}

/** Blend function on normalized (0..1) channels. */
function blendNormalized(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal':
      return cs;
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay':
      // overlay(cb, cs) = hard-light(cs, cb)
      return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'color-dodge':
      if (cb === 0) return 0;
      if (cs === 1) return 1;
      return Math.min(1, cb / (1 - cs));
    case 'color-burn':
      if (cb === 1) return 1;
      if (cs === 0) return 0;
      return 1 - Math.min(1, (1 - cb) / cs);
    case 'hard-light':
      return cs <= 0.5
        ? 2 * cb * cs
        : 1 - 2 * (1 - cb) * (1 - cs);
    case 'soft-light':
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      return cb + (2 * cs - 1) * (softLightD(cb) - cb);
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    default: {
      // Exhaustiveness guard: BlendMode is a closed union.
      const neverMode: never = mode;
      return neverMode;
    }
  }
}

/**
 * Blend a single channel. `base` is the backdrop/destination channel and
 * `blend` is the source channel; both are 0..255 floats and the result is
 * a 0..255 float (not rounded — callers storing to a Uint8ClampedArray
 * get rounding from the array).
 */
export function blendChannel(mode: BlendMode, base: number, blend: number): number {
  const cb = clamp01((Number.isFinite(base) ? base : 0) / 255);
  const cs = clamp01((Number.isFinite(blend) ? blend : 0) / 255);
  return clamp01(blendNormalized(mode, cb, cs)) * 255;
}

/**
 * Composite `src` onto `dst` in place, at offset (0, 0), clipped to the
 * overlap of the two buffers. `opacity` (0..1, clamped) and, when given,
 * `mask` coverage (sampled at source coordinates; a mask pixel of 0 means
 * no paint) multiply the source alpha. `dst` alpha/color follow the W3C
 * formula in the file header. Buffers are never resized or reallocated.
 */
export function compositeBuffers(
  dst: PixelBuffer,
  src: PixelBuffer,
  opacity: number,
  mode: BlendMode,
  mask?: MaskBuffer,
): void {
  const op = clamp01(opacity);
  if (op === 0) return;
  const w = Math.min(dst.width, src.width);
  const h = Math.min(dst.height, src.height);
  if (w <= 0 || h <= 0) return;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * src.width + x) * 4;
      const di = (y * dst.width + x) * 4;

      // Mask semantics (fixed after red-team RT-3 probe): when a mask is
      // supplied, pixels OUTSIDE the mask's bounds are treated as covered
      // (coverage 0, hidden) — never as fully revealed. A stale/undersized
      // mask must fail safe (hide), not silently reveal the whole layer.
      let coverage = 1;
      if (mask) {
        coverage = x < mask.width && y < mask.height
          ? (mask.data[y * mask.width + x] ?? 0) / 255
          : 0;
      }
      const as = clamp01(((src.data[si + 3] ?? 0) / 255) * op * coverage);
      if (as === 0) continue; // transparent source leaves dst untouched

      const ab = clamp01((dst.data[di + 3] ?? 0) / 255);
      const ao = as + ab * (1 - as);
      if (ao === 0) {
        dst.data[di] = 0;
        dst.data[di + 1] = 0;
        dst.data[di + 2] = 0;
        dst.data[di + 3] = 0;
        continue;
      }
      for (let ch = 0; ch < 3; ch++) {
        const cs = (src.data[si + ch] ?? 0) / 255;
        const cb = (dst.data[di + ch] ?? 0) / 255;
        const blended = blendNormalized(mode, cb, cs);
        const co = as * (1 - ab) * cs + as * ab * blended + (1 - as) * ab * cb;
        dst.data[di + ch] = (co / ao) * 255;
      }
      dst.data[di + 3] = ao * 255;
    }
  }
}
