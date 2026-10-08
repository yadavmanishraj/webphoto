import { describe, it, expect } from 'vitest';
import type { PixelBuffer } from '../../core/contracts';
import { gaussianBlur, sharpen, brightnessContrast, hueSaturation, invertBuffer, grayscaleBuffer, thresholdBuffer, posterizeBuffer, noiseBuffer, pixelateBuffer, embossBuffer, edgeDetectBuffer } from './filters';

const buf = (w: number, h: number, fill: [number, number, number, number]): PixelBuffer => {
  const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) { d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = fill[3]; }
  return { width: w, height: h, data: d };
};
const px = (b: PixelBuffer, x: number, y: number) => Array.from(b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));
const ALL = [gaussianBlur, sharpen];

describe('filters — immutability & identity cases', () => {
  it('every filter returns a NEW buffer and never mutates input', () => {
    const src = buf(4, 4, [100, 150, 200, 255]); const before = new Uint8ClampedArray(src.data);
    const outs = [gaussianBlur(src, 1), sharpen(src, 0.5), brightnessContrast(src, 10, 10), hueSaturation(src, 30, 0.1, 0), invertBuffer(src), grayscaleBuffer(src), thresholdBuffer(src, 128), posterizeBuffer(src, 4), noiseBuffer(src, 20, 42), pixelateBuffer(src, 2), embossBuffer(src), edgeDetectBuffer(src)];
    for (const o of outs) { expect(o).not.toBe(src); expect(o.data).not.toBe(src.data); }
    expect(src.data).toEqual(before);
    void ALL;
  });
  it('blur of uniform color = same color; sharpen of uniform = same', () => {
    const u = buf(5, 5, [80, 120, 160, 255]);
    expect(px(gaussianBlur(u, 2), 2, 2)).toEqual([80, 120, 160, 255]);
    expect(px(sharpen(u, 1), 2, 2)).toEqual([80, 120, 160, 255]);
    expect(Array.from(gaussianBlur(u, 0).data)).toEqual(Array.from(u.data));
  });
  it('blur spreads a single white pixel', () => {
    const s = buf(5, 5, [0, 0, 0, 255]); const i = (2 * 5 + 2) * 4; s.data[i] = s.data[i + 1] = s.data[i + 2] = 255;
    const out = gaussianBlur(s, 1);
    expect(px(out, 2, 2)[0]!).toBeLessThan(255); expect(px(out, 2, 2)[0]!).toBeGreaterThan(0);
    expect(px(out, 3, 2)[0]!).toBeGreaterThan(0); expect(px(out, 0, 0)[0]!).toBeLessThan(px(out, 3, 2)[0]!);
  });
});

describe('filters — point operations known values', () => {
  it('invert: 0 -> 255, alpha preserved', () => {
    expect(px(invertBuffer(buf(1, 1, [0, 10, 255, 200])), 0, 0)).toEqual([255, 245, 0, 200]);
  });
  it('grayscale uses luminance (pure red -> 76)', () => { expect(px(grayscaleBuffer(buf(1, 1, [255, 0, 0, 255])), 0, 0)).toEqual([76, 76, 76, 255]); });
  it('threshold boundary: value == t is white, t+1 is black', () => {
    const g = buf(1, 1, [128, 128, 128, 255]);
    expect(px(thresholdBuffer(g, 128), 0, 0)[0]).toBe(255); expect(px(thresholdBuffer(g, 129), 0, 0)[0]).toBe(0);
  });
  it('brightness/contrast identity at 0,0; brightness shifts value', () => {
    const g = buf(1, 1, [100, 100, 100, 255]);
    expect(px(brightnessContrast(g, 0, 0), 0, 0)).toEqual([100, 100, 100, 255]);
    expect(px(brightnessContrast(g, 50, 0), 0, 0)[0]).toBe(150);
    // Contrast pivots at mid-gray: a bright pixel gets brighter, a dark one darker.
    expect(px(brightnessContrast(buf(1, 1, [200, 200, 200, 255]), 0, 50), 0, 0)[0]).toBeGreaterThan(200);
    expect(px(brightnessContrast(g, 0, 50), 0, 0)[0]).toBeLessThan(100);
  });
  it('hue rotation: pure red +120deg becomes green', () => {
    const out = px(hueSaturation(buf(1, 1, [255, 0, 0, 255]), 120, 0, 0), 0, 0);
    expect(out[1]).toBe(255); expect(out[0]).toBe(0);
    expect(px(hueSaturation(buf(1, 1, [255, 0, 0, 255]), 0, -1, 0), 0, 0)).toEqual([128, 128, 128, 255]); // desaturated
  });
  it('posterize levels=2 maps to 0/255 only', () => {
    const out = posterizeBuffer(buf(2, 1, [100, 200, 30, 255]), 2);
    for (const v of [out.data[0], out.data[1], out.data[2]]) expect([0, 255]).toContain(v);
  });
});

describe('filters — noise / pixelate / emboss / edge', () => {
  it('noise: same seed = identical output, different seed differs, amount 0 = identity', () => {
    const g = buf(8, 8, [128, 128, 128, 255]);
    expect(Array.from(noiseBuffer(g, 30, 7).data)).toEqual(Array.from(noiseBuffer(g, 30, 7).data));
    expect(Array.from(noiseBuffer(g, 30, 7).data)).not.toEqual(Array.from(noiseBuffer(g, 30, 8).data));
    expect(Array.from(noiseBuffer(g, 0, 7).data)).toEqual(Array.from(g.data));
    expect(noiseBuffer(g, 30, 7).data.some((v, i) => i % 4 !== 3 && v !== 128)).toBe(true);
  });
  it('pixelate averages blocks', () => {
    const s = buf(2, 2, [0, 0, 0, 255]); s.data[0] = 100; // one bright red channel pixel
    expect(px(pixelateBuffer(s, 2), 1, 1)[0]).toBe(25);
    expect(Array.from(pixelateBuffer(s, 1).data)).toEqual(Array.from(s.data));
  });
  it('emboss of uniform field is uniform; edge detect of uniform field is black', () => {
    const u = buf(4, 4, [90, 90, 90, 255]); const e = embossBuffer(u);
    expect(new Set(Array.from(e.data.filter((_, i) => i % 4 !== 3))).size).toBe(1);
    expect(px(edgeDetectBuffer(u), 1, 1)).toEqual([0, 0, 0, 255]);
  });
  it('edge detect finds a vertical edge', () => {
    const s = buf(4, 4, [0, 0, 0, 255]); for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) { const i = (y * 4 + x) * 4; s.data[i] = s.data[i + 1] = s.data[i + 2] = 255; }
    expect(px(edgeDetectBuffer(s), 1, 1)[0]!).toBeGreaterThan(0);
  });
});
