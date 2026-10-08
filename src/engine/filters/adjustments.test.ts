import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../../core/contracts';
import { applyAdjustment } from './adjustments';

function makeBuf(pixels: Array<[number, number, number, number]>): PixelBuffer {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  });
  return { width: pixels.length, height: 1, data };
}

describe('applyAdjustment', () => {
  it('levels with identity params leaves pixels unchanged', () => {
    const buf = makeBuf([[0, 17, 128, 255], [255, 64, 200, 128]]);
    const out = applyAdjustment(buf, {
      kind: 'levels',
      params: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
    });
    expect(Array.from(out.data)).toEqual(Array.from(buf.data));
  });

  it('gamma 1 is identity', () => {
    const buf = makeBuf([[10, 99, 250, 255], [0, 255, 33, 77]]);
    const out = applyAdjustment(buf, { kind: 'gamma', params: { gamma: 1 } });
    expect(Array.from(out.data)).toEqual(Array.from(buf.data));
  });

  it('color-balance +r raises only the red channel', () => {
    const buf = makeBuf([[10, 20, 30, 255]]);
    const out = applyAdjustment(buf, {
      kind: 'color-balance',
      params: { r: 50, g: 0, b: 0 },
    });
    expect(out.data[0]!).toBeGreaterThan(10);
    expect(out.data[1]).toBe(20);
    expect(out.data[2]).toBe(30);
    expect(out.data[3]).toBe(255);
  });

  it('does not mutate the input buffer and returns a new buffer', () => {
    const buf = makeBuf([[100, 150, 200, 255]]);
    const before = Array.from(buf.data);
    const out = applyAdjustment(buf, { kind: 'invert', params: {} });
    expect(out).not.toBe(buf);
    expect(out.data).not.toBe(buf.data);
    expect(Array.from(buf.data)).toEqual(before);
    expect(Array.from(out.data)).toEqual([155, 105, 55, 255]);
  });

  it('grayscale produces equal channels and preserves alpha', () => {
    const buf = makeBuf([[255, 0, 0, 42]]);
    const out = applyAdjustment(buf, { kind: 'grayscale', params: {} });
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[1]).toBe(out.data[2]);
    expect(out.data[3]).toBe(42);
  });

  it('threshold snaps to black/white by luminance', () => {
    const buf = makeBuf([[10, 10, 10, 255], [240, 240, 240, 255]]);
    const out = applyAdjustment(buf, { kind: 'threshold', params: { threshold: 128 } });
    expect(Array.from(out.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('posterize quantizes channel values', () => {
    const buf = makeBuf([[100, 100, 100, 255]]);
    const out = applyAdjustment(buf, { kind: 'posterize', params: { levels: 2 } });
    // 100/255 rounds to level 0 of 0..1 -> 0
    expect(out.data[0]).toBe(0);
  });

  it('brightness-contrast at 0/0 is identity', () => {
    const buf = makeBuf([[13, 128, 250, 255]]);
    const out = applyAdjustment(buf, {
      kind: 'brightness-contrast',
      params: { brightness: 0, contrast: 0 },
    });
    expect(Array.from(out.data)).toEqual(Array.from(buf.data));
  });

  it('hue-saturation with zero params is (near-)identity for a saturated color', () => {
    const buf = makeBuf([[200, 80, 40, 255]]);
    const out = applyAdjustment(buf, {
      kind: 'hue-saturation',
      params: { hue: 0, saturation: 0, lightness: 0 },
    });
    expect(Math.abs(out.data[0]! - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[1]! - 80)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.data[2]! - 40)).toBeLessThanOrEqual(1);
  });

  it('throws on an unknown adjustment kind', () => {
    const buf = makeBuf([[0, 0, 0, 255]]);
    expect(() =>
      applyAdjustment(buf, { kind: 'bogus' as never, params: {} }),
    ).toThrow(Error);
  });
});
