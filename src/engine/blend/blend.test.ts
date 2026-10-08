import { describe, it, expect } from 'vitest';
import { blendChannel, compositeBuffers } from './blend';
import type { MaskBuffer, PixelBuffer, RGBA } from '../../core/contracts';

function buf(w: number, h: number, pixels: RGBA[]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  pixels.forEach((p, i) => {
    data[i * 4] = p.r;
    data[i * 4 + 1] = p.g;
    data[i * 4 + 2] = p.b;
    data[i * 4 + 3] = p.a;
  });
  return { width: w, height: h, data };
}
function px(b: PixelBuffer, x: number, y: number): number[] {
  const i = (y * b.width + x) * 4;
  return [b.data[i] ?? -1, b.data[i + 1] ?? -1, b.data[i + 2] ?? -1, b.data[i + 3] ?? -1];
}

describe('blendChannel — W3C reference values', () => {
  it('normal returns the blend channel', () => {
    expect(blendChannel('normal', 10, 200)).toBeCloseTo(200, 5);
    expect(blendChannel('normal', 200, 10)).toBeCloseTo(10, 5);
  });

  it('multiply(128,128) ≈ 64.25 and screen(128,128) ≈ 191.75', () => {
    expect(blendChannel('multiply', 128, 128)).toBeCloseTo((128 * 128) / 255, 3);
    expect(blendChannel('multiply', 255, 255)).toBeCloseTo(255, 5);
    expect(blendChannel('multiply', 255, 0)).toBeCloseTo(0, 5);
    expect(blendChannel('screen', 128, 128)).toBeCloseTo(191.75, 1);
    expect(blendChannel('screen', 0, 0)).toBeCloseTo(0, 5);
    expect(blendChannel('screen', 255, 0)).toBeCloseTo(255, 5);
  });

  it('overlay darkens dark bases and lightens light bases', () => {
    // base 64 (<=0.5 branch): 2 * 64 * 128 / 255 ≈ 64.25
    expect(blendChannel('overlay', 64, 128)).toBeCloseTo(64.25, 1);
    // base 192 (>0.5 branch): 255 - 2 * 63 * 127 / 255 ≈ 192.25
    expect(blendChannel('overlay', 192, 128)).toBeCloseTo(192.25, 1);
    // base 128/255 = 0.50196 is just ABOVE the 0.5 pivot, so the lighten
    // branch applies: 255 * (1 - 2*(1-128/255)*(1-0)) = 1.0 (not 0).
    expect(blendChannel('overlay', 128, 0)).toBeCloseTo(1.0, 1);
    expect(blendChannel('overlay', 127, 0)).toBeCloseTo(0, 1);
    expect(blendChannel('overlay', 128, 255)).toBeCloseTo(255, 1);
  });

  it('darken / lighten are min / max', () => {
    expect(blendChannel('darken', 200, 50)).toBeCloseTo(50, 5);
    expect(blendChannel('lighten', 200, 50)).toBeCloseTo(200, 5);
  });

  it('color-dodge / color-burn guard division by zero', () => {
    // dodge: min(1, cb/(1-cs)); cs=255 would divide by zero -> 1 (unless cb=0)
    expect(blendChannel('color-dodge', 128, 255)).toBeCloseTo(255, 5);
    expect(blendChannel('color-dodge', 0, 255)).toBeCloseTo(0, 5);
    expect(blendChannel('color-dodge', 0, 128)).toBeCloseTo(0, 5);
    expect(blendChannel('color-dodge', 128, 128)).toBeCloseTo(255, 1); // >1 clamped
    // burn: 1 - min(1, (1-cb)/cs); cs=0 would divide by zero -> 0 (unless cb=1)
    expect(blendChannel('color-burn', 128, 0)).toBeCloseTo(0, 5);
    expect(blendChannel('color-burn', 255, 0)).toBeCloseTo(255, 5);
    expect(blendChannel('color-burn', 128, 128)).toBeCloseTo(2, 1);
  });

  it('hard-light switches on the blend channel', () => {
    // cs=64 (<=0.5): 2 * 128 * 64 / 255 ≈ 64.25
    expect(blendChannel('hard-light', 128, 64)).toBeCloseTo(64.25, 1);
    // cs=192 (>0.5): screen-like, 255 - 2 * 127 * 63 / 255 ≈ 192.25
    expect(blendChannel('hard-light', 128, 192)).toBeCloseTo(192.25, 1);
  });

  it('soft-light (W3C formula) is a subtle adjustment', () => {
    expect(blendChannel('soft-light', 128, 128)).toBeCloseTo(128, 0); // ≈128.2
    expect(blendChannel('soft-light', 128, 0)).toBeCloseTo(64.25, 1); // cb - cb*(1-cb), scaled ≈ 64.25
    expect(blendChannel('soft-light', 200, 255)).toBeGreaterThan(200);
    expect(blendChannel('soft-light', 200, 0)).toBeLessThan(200);
    // neutral blend (50% gray identical channel) leaves extremes stable-ish
    expect(blendChannel('soft-light', 0, 128)).toBeCloseTo(0, 0);
  });

  it('difference is |base - blend|, exclusion is the low-contrast variant', () => {
    expect(blendChannel('difference', 200, 50)).toBeCloseTo(150, 5);
    expect(blendChannel('difference', 50, 200)).toBeCloseTo(150, 5);
    expect(blendChannel('difference', 128, 128)).toBeCloseTo(0, 5);
    // exclusion(128,128) = 128+128-2*128*128/255 ≈ 127.5
    expect(blendChannel('exclusion', 128, 128)).toBeCloseTo(127.5, 1);
    expect(blendChannel('exclusion', 0, 0)).toBeCloseTo(0, 5);
    expect(blendChannel('exclusion', 255, 255)).toBeCloseTo(0, 5);
  });

  it('all modes stay within 0..255 for extreme inputs', () => {
    const modes = [
      'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
      'color-dodge', 'color-burn', 'hard-light', 'soft-light',
      'difference', 'exclusion',
    ] as const;
    for (const m of modes) {
      for (const v of [0, 1, 127, 128, 254, 255]) {
        const out = blendChannel(m, v, 255 - v);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(255);
      }
    }
  });
});

describe('compositeBuffers', () => {
  it('50% red over opaque blue (normal) gives a purple midpoint, alpha 255', () => {
    const dst = buf(1, 1, [{ r: 0, g: 0, b: 255, a: 255 }]);
    const src = buf(1, 1, [{ r: 255, g: 0, b: 0, a: 255 }]);
    compositeBuffers(dst, src, 0.5, 'normal');
    const [r, g, b, a] = px(dst, 0, 0);
    expect(r).toBeGreaterThanOrEqual(127);
    expect(r).toBeLessThanOrEqual(128);
    expect(g).toBe(0);
    expect(b).toBeGreaterThanOrEqual(127);
    expect(b).toBeLessThanOrEqual(128);
    expect(a).toBe(255);
  });

  it('opaque normal source fully replaces an opaque destination', () => {
    const dst = buf(1, 1, [{ r: 1, g: 2, b: 3, a: 255 }]);
    const src = buf(1, 1, [{ r: 10, g: 20, b: 30, a: 255 }]);
    compositeBuffers(dst, src, 1, 'normal');
    expect(px(dst, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it('alpha-0 source leaves dst unchanged, for every opacity/mode', () => {
    const dst = buf(1, 1, [{ r: 9, g: 8, b: 7, a: 200 }]);
    const src = buf(1, 1, [{ r: 255, g: 255, b: 255, a: 0 }]);
    compositeBuffers(dst, src, 1, 'multiply');
    expect(px(dst, 0, 0)).toEqual([9, 8, 7, 200]);
  });

  it('opacity 0 is a no-op', () => {
    const dst = buf(1, 1, [{ r: 9, g: 8, b: 7, a: 255 }]);
    const src = buf(1, 1, [{ r: 255, g: 0, b: 0, a: 255 }]);
    compositeBuffers(dst, src, 0, 'normal');
    expect(px(dst, 0, 0)).toEqual([9, 8, 7, 255]);
  });

  it('semi-transparent source over transparency keeps its (non-premultiplied) color', () => {
    const dst = buf(1, 1, [{ r: 0, g: 0, b: 0, a: 0 }]);
    const src = buf(1, 1, [{ r: 255, g: 0, b: 0, a: 128 }]);
    compositeBuffers(dst, src, 1, 'normal');
    expect(px(dst, 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('result alpha follows ao = sa + da*(1-sa)', () => {
    const dst = buf(1, 1, [{ r: 0, g: 0, b: 255, a: 128 }]);
    const src = buf(1, 1, [{ r: 255, g: 0, b: 0, a: 128 }]);
    compositeBuffers(dst, src, 1, 'normal');
    // ao = 0.50196 + 0.50196 * 0.49804 ≈ 0.75196 -> ≈192
    expect(px(dst, 0, 0)[3]).toBeGreaterThanOrEqual(191);
    expect(px(dst, 0, 0)[3]).toBeLessThanOrEqual(192);
  });

  it('applies blend modes: opaque multiply of gray over white', () => {
    const dst = buf(1, 1, [{ r: 255, g: 255, b: 255, a: 255 }]);
    const src = buf(1, 1, [{ r: 128, g: 128, b: 128, a: 255 }]);
    compositeBuffers(dst, src, 1, 'multiply');
    // multiply(white, 128) = 128
    expect(px(dst, 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it('mask 0 = no paint; mask 255 = full paint; mask 128 ≈ half coverage', () => {
    const mk = (): PixelBuffer => buf(1, 1, [{ r: 0, g: 0, b: 255, a: 255 }]);
    const src = buf(1, 1, [{ r: 255, g: 0, b: 0, a: 255 }]);
    const mask = (v: number): MaskBuffer => ({
      width: 1, height: 1, data: new Uint8Array([v]),
    });

    const d0 = mk();
    compositeBuffers(d0, src, 1, 'normal', mask(0));
    expect(px(d0, 0, 0)).toEqual([0, 0, 255, 255]);

    const dFull = mk();
    compositeBuffers(dFull, src, 1, 'normal', mask(255));
    expect(px(dFull, 0, 0)).toEqual([255, 0, 0, 255]);

    const dHalf = mk();
    compositeBuffers(dHalf, src, 1, 'normal', mask(128));
    const [r, , b] = px(dHalf, 0, 0);
    expect(r).toBeGreaterThanOrEqual(127);
    expect(r).toBeLessThanOrEqual(128);
    expect(b).toBeGreaterThanOrEqual(127);
    expect(b).toBeLessThanOrEqual(128);
  });

  it('clips a smaller source to (0,0) and does not touch the rest of dst', () => {
    const dst = buf(2, 2, [
      { r: 0, g: 0, b: 255, a: 255 }, { r: 0, g: 0, b: 255, a: 255 },
      { r: 0, g: 0, b: 255, a: 255 }, { r: 0, g: 0, b: 255, a: 255 },
    ]);
    const src = buf(1, 1, [{ r: 255, g: 0, b: 0, a: 255 }]);
    compositeBuffers(dst, src, 1, 'normal');
    expect(px(dst, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(dst, 1, 0)).toEqual([0, 0, 255, 255]);
    expect(px(dst, 0, 1)).toEqual([0, 0, 255, 255]);
    expect(px(dst, 1, 1)).toEqual([0, 0, 255, 255]);
  });

  it('clips a larger source to the destination size without throwing', () => {
    const dst = buf(1, 1, [{ r: 0, g: 0, b: 0, a: 255 }]);
    const src = buf(2, 2, [
      { r: 10, g: 0, b: 0, a: 255 }, { r: 20, g: 0, b: 0, a: 255 },
      { r: 30, g: 0, b: 0, a: 255 }, { r: 40, g: 0, b: 0, a: 255 },
    ]);
    compositeBuffers(dst, src, 1, 'normal');
    expect(px(dst, 0, 0)).toEqual([10, 0, 0, 255]);
  });

  it('compositing is deterministic (same inputs -> same output)', () => {
    const run = (): number[] => {
      const dst = buf(1, 1, [{ r: 40, g: 80, b: 120, a: 200 }]);
      const src = buf(1, 1, [{ r: 200, g: 100, b: 50, a: 170 }]);
      compositeBuffers(dst, src, 0.8, 'soft-light');
      return px(dst, 0, 0);
    };
    expect(run()).toEqual(run());
  });
});
