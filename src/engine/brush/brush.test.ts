import { describe, expect, it } from 'vitest';
import type { PixelBuffer, RGBA } from '../../core/contracts';
import { fullSelection } from '../../core/contracts';
import { interpolateStrokePoints, paintStroke, stampBrush, type BrushSettings } from './brush';

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const settings = (over: Partial<BrushSettings> = {}): BrushSettings => ({
  size: 10, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0, ...over,
});
function makeBuf(w: number, h: number, fill?: RGBA): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill) {
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = fill.r; data[i * 4 + 1] = fill.g; data[i * 4 + 2] = fill.b; data[i * 4 + 3] = fill.a;
    }
  }
  return { width: w, height: h, data };
}
const px = (b: PixelBuffer, x: number, y: number) => {
  const i = (y * b.width + x) * 4;
  return { r: b.data[i]!, g: b.data[i + 1]!, b: b.data[i + 2]!, a: b.data[i + 3]! };
};

describe('stampBrush', () => {
  it('center pixel gets the paint color at full strength', () => {
    const buf = makeBuf(21, 21);
    stampBrush(buf, 10, 10, settings(), RED, 'paint');
    const c = px(buf, 10, 10);
    expect(c.r).toBe(255);
    expect(c.g).toBe(0);
    expect(c.a).toBe(255);
  });

  it('corner of a huge soft brush is untouched', () => {
    const buf = makeBuf(100, 100);
    stampBrush(buf, 50, 50, settings({ size: 20, hardness: 0 }), RED, 'paint');
    expect(px(buf, 0, 0).a).toBe(0);
    expect(px(buf, 99, 99).a).toBe(0);
  });

  it('soft brush feathers: edge weaker than center', () => {
    const buf = makeBuf(41, 41);
    stampBrush(buf, 20, 20, settings({ size: 40, hardness: 0 }), RED, 'paint');
    expect(px(buf, 20, 20).a).toBeGreaterThan(px(buf, 38, 20).a);
  });

  it('erase reduces alpha and leaves rgb unchanged', () => {
    const buf = makeBuf(21, 21, { r: 10, g: 20, b: 30, a: 255 });
    stampBrush(buf, 10, 10, settings({ opacity: 0.5 }), RED, 'erase');
    const c = px(buf, 10, 10);
    expect(c.a).toBeLessThan(255);
    expect(c.a).toBeGreaterThan(0);
    expect(c.r).toBe(10);
    expect(c.g).toBe(20);
    expect(c.b).toBe(30);
  });

  it('selection blocks painting where coverage is 0', () => {
    const buf = makeBuf(21, 21);
    const sel = fullSelection(21, 21);
    sel.mask.fill(0);
    stampBrush(buf, 10, 10, settings(), RED, 'paint', sel);
    expect(px(buf, 10, 10).a).toBe(0);
  });

  it('opacity scales paint alpha over transparent pixels', () => {
    const buf = makeBuf(21, 21);
    stampBrush(buf, 10, 10, settings({ opacity: 0.5, flow: 1 }), RED, 'paint');
    expect(px(buf, 10, 10).a).toBeCloseTo(128, -1);
  });
});

describe('interpolateStrokePoints', () => {
  it('handles a single point', () => {
    const out = interpolateStrokePoints([{ x: 5, y: 5 }], settings());
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ x: 5, y: 5, pressure: 1 });
  });

  it('handles zero-length segments without duplicates or hang', () => {
    const out = interpolateStrokePoints([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }], settings());
    expect(out).toHaveLength(1);
  });

  it('inserts stamps so consecutive distance <= max(1, size*spacing)', () => {
    const out = interpolateStrokePoints([{ x: 0, y: 0 }, { x: 100, y: 0 }], settings({ size: 10, spacing: 0.25 }));
    expect(out.length).toBeGreaterThan(10);
    for (let i = 1; i < out.length; i++) {
      const d = Math.hypot(out[i]!.x - out[i - 1]!.x, out[i]!.y - out[i - 1]!.y);
      expect(d).toBeLessThanOrEqual(2.5 + 1e-9);
    }
    expect(out[out.length - 1]!.x).toBe(100);
  });

  it('interpolates pressure', () => {
    const out = interpolateStrokePoints([{ x: 0, y: 0, pressure: 0 }, { x: 10, y: 0, pressure: 1 }], settings({ size: 10, spacing: 0.25 }));
    const mid = out[Math.floor(out.length / 2)]!;
    expect(mid.pressure).toBeGreaterThan(0);
    expect(mid.pressure).toBeLessThan(1);
  });

  it('returns [] for no points', () => {
    expect(interpolateStrokePoints([], settings())).toEqual([]);
  });
});

describe('paintStroke', () => {
  it('fast stroke between two far points leaves NO gap at the midpoint', () => {
    const buf = makeBuf(100, 20);
    paintStroke(buf, [{ x: 0, y: 10 }, { x: 99, y: 10 }], settings({ size: 10 }), RED, 'paint');
    expect(px(buf, 50, 10).a).toBeGreaterThan(0);
    expect(px(buf, 50, 10).r).toBe(255);
    // every pixel along the line should be painted
    for (let x = 2; x < 98; x++) expect(px(buf, x, 10).a).toBeGreaterThan(0);
  });

  it('diagonal fast stroke has no gaps', () => {
    const buf = makeBuf(60, 60);
    paintStroke(buf, [{ x: 0, y: 0 }, { x: 59, y: 59 }], settings({ size: 8 }), RED, 'paint');
    expect(px(buf, 30, 30).a).toBeGreaterThan(0);
  });

  it('painting at the canvas edge does not throw and paints in-bounds pixels', () => {
    const buf = makeBuf(10, 10);
    expect(() => paintStroke(buf, [{ x: 0, y: 0 }, { x: 9, y: 0 }], settings(), RED, 'paint')).not.toThrow();
    expect(px(buf, 0, 0).a).toBeGreaterThan(0);
  });
});
