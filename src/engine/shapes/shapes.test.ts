import { describe, expect, it } from 'vitest';
import type { RGBA, ShapeData } from '../../core/contracts';
import { pointInShape, rasterizeShape } from './shapes';

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const shape = (over: Partial<ShapeData>): ShapeData => ({
  kind: 'rectangle', w: 20, h: 20, cornerRadius: 0, sides: 5, fill: RED, stroke: null, strokeWidth: 0, ...over,
});
const px = (b: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const i = (y * b.width + x) * 4;
  return { r: b.data[i]!, g: b.data[i + 1]!, b: b.data[i + 2]!, a: b.data[i + 3]! };
};

describe('rasterizeShape — rectangle', () => {
  it('fill pixel inside is painted, buffer sized to shape', () => {
    const buf = rasterizeShape(shape({}));
    expect(buf.width).toBe(20);
    expect(buf.height).toBe(20);
    expect(px(buf, 10, 10)).toEqual(RED);
    expect(px(buf, 0, 0)).toEqual(RED);
  });
  it('pointInShape: inside true, outside false', () => {
    const s = shape({});
    expect(pointInShape(s, 10, 10)).toBe(true);
    expect(pointInShape(s, -1, 10)).toBe(false);
    expect(pointInShape(s, 25, 10)).toBe(false);
    expect(pointInShape(s, 10, 25)).toBe(false);
  });
  it('stroke is drawn as an inside ring of strokeWidth', () => {
    const buf = rasterizeShape(shape({ stroke: BLUE, strokeWidth: 2 }));
    expect(px(buf, 0, 10)).toEqual(BLUE); // ring
    expect(px(buf, 1, 10)).toEqual(BLUE); // ring
    expect(px(buf, 5, 10)).toEqual(RED); // interior fill
  });
  it('fill null with stroke paints only the ring', () => {
    const buf = rasterizeShape(shape({ fill: null, stroke: BLUE, strokeWidth: 2 }));
    expect(px(buf, 0, 10)).toEqual(BLUE);
    expect(px(buf, 10, 10).a).toBe(0);
  });
});

describe('rasterizeShape — ellipse', () => {
  it('corner is transparent, center is filled', () => {
    const buf = rasterizeShape(shape({ kind: 'ellipse' }));
    expect(px(buf, 0, 0).a).toBe(0);
    expect(px(buf, 19, 19).a).toBe(0);
    expect(px(buf, 10, 10)).toEqual(RED);
  });
  it('pointInShape agrees', () => {
    const s = shape({ kind: 'ellipse' });
    expect(pointInShape(s, 10, 10)).toBe(true);
    expect(pointInShape(s, 0.5, 0.5)).toBe(false);
  });
});

describe('rasterizeShape — rounded rectangle', () => {
  it('corner is cut, edge center is filled', () => {
    const buf = rasterizeShape(shape({ kind: 'rounded-rectangle', cornerRadius: 8 }));
    expect(px(buf, 0, 0).a).toBe(0);
    expect(px(buf, 10, 0)).toEqual(RED);
    expect(px(buf, 10, 10)).toEqual(RED);
  });
});

describe('rasterizeShape — polygon', () => {
  it('center is filled, first vertex at top', () => {
    const s = shape({ kind: 'polygon', sides: 6, w: 40, h: 40 });
    const buf = rasterizeShape(s);
    expect(px(buf, 20, 20)).toEqual(RED);
    expect(pointInShape(s, 20, 20)).toBe(true);
    expect(pointInShape(s, 20, 1)).toBe(true); // near top vertex
    expect(pointInShape(s, 1, 1)).toBe(false); // corner outside hexagon
  });
  it('triangle (sides=3) center-ish point is filled', () => {
    const s = shape({ kind: 'polygon', sides: 3, w: 40, h: 40 });
    expect(pointInShape(s, 20, 25)).toBe(true);
  });
});

describe('rasterizeShape — line', () => {
  it('middle row is painted with thickness, far rows transparent', () => {
    const buf = rasterizeShape(shape({ kind: 'line', w: 40, h: 20, strokeWidth: 4 }));
    expect(px(buf, 20, 10)).toEqual(RED);
    expect(px(buf, 20, 0).a).toBe(0);
    expect(px(buf, 20, 19).a).toBe(0);
    expect(pointInShape(shape({ kind: 'line', w: 40, h: 20, strokeWidth: 4 }), 20, 10)).toBe(true);
  });
  it('falls back to stroke color when fill is null', () => {
    const buf = rasterizeShape(shape({ kind: 'line', w: 40, h: 20, fill: null, stroke: BLUE, strokeWidth: 4 }));
    expect(px(buf, 20, 10)).toEqual(BLUE);
  });
});
