import { describe, it, expect } from 'vitest';
import type { PixelBuffer } from '../../core/contracts';
import { matIdentity, matMultiply, matTranslate, matScale, matRotate, matApply, matInvert, transformedBounds, transformBuffer } from './transform';

const buf = (w: number, h: number, px: number[][]): PixelBuffer => ({ width: w, height: h, data: new Uint8ClampedArray(px.flat()) });
const pxAt = (b: PixelBuffer, x: number, y: number) => Array.from(b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 4));

describe('transform matrices', () => {
  it('identity leaves points unchanged', () => { expect(matApply(matIdentity(), 3, 7)).toEqual({ x: 3, y: 7 }); });
  it('translate/scale/rotate apply correctly', () => {
    expect(matApply(matTranslate(5, -2), 1, 1)).toEqual({ x: 6, y: -1 });
    expect(matApply(matScale(2, 3), 2, 2)).toEqual({ x: 4, y: 6 });
    const r = matApply(matRotate(90), 1, 0); expect(r.x).toBeCloseTo(0); expect(r.y).toBeCloseTo(1);
  });
  it('multiply applies right operand first', () => {
    const m = matMultiply(matTranslate(10, 0), matScale(2)); // scale then translate
    expect(matApply(m, 1, 1)).toEqual({ x: 12, y: 2 });
    const m2 = matMultiply(matScale(2), matTranslate(10, 0));
    expect(matApply(m2, 1, 1)).toEqual({ x: 22, y: 2 });
  });
  it('inverse roundtrip restores point approx; singular returns null', () => {
    const m = matMultiply(matTranslate(4, -3), matMultiply(matRotate(33), matScale(2, 0.5)));
    const inv = matInvert(m)!; const p = matApply(m, 7, 11); const back = matApply(inv, p.x, p.y);
    expect(back.x).toBeCloseTo(7, 6); expect(back.y).toBeCloseTo(11, 6);
    expect(matMultiply(m, inv)[0]).toBeCloseTo(1, 6);
    expect(matInvert(matScale(0, 1))).toBeNull();
  });
  it('transformedBounds for rotated rect', () => {
    expect(transformedBounds(2, 1, matRotate(90))).toEqual({ x: -1, y: 0, w: 1, h: 2 });
    expect(transformedBounds(4, 3, matTranslate(2, 5))).toEqual({ x: 2, y: 5, w: 4, h: 3 });
  });
});

describe('transformBuffer', () => {
  const src = buf(2, 1, [[255, 0, 0, 255], [0, 0, 255, 255]]); // red, blue
  it('identity copy equals source, input unmutated', () => {
    const before = new Uint8ClampedArray(src.data);
    const out = transformBuffer(src, matIdentity(), 2, 1, 'nearest');
    expect(Array.from(out.data)).toEqual(Array.from(src.data)); expect(src.data).toEqual(before);
  });
  it('rotate 90 of 2x1 buffer: dimensions 1x2 and pixels stacked', () => {
    const bounds = transformedBounds(2, 1, matRotate(90));
    expect([bounds.w, bounds.h]).toEqual([1, 2]);
    const out = transformBuffer(src, matRotate(90), 1, 2, 'nearest');
    expect(pxAt(out, 0, 0)).toEqual([255, 0, 0, 255]); // red at top
    expect(pxAt(out, 0, 1)).toEqual([0, 0, 255, 255]); // blue below
  });
  it('translate shifts pixels, vacated area is transparent', () => {
    const out = transformBuffer(src, matTranslate(1, 0), 3, 1, 'nearest');
    expect(pxAt(out, 0, 0)).toEqual([0, 0, 0, 0]); expect(pxAt(out, 1, 0)).toEqual([255, 0, 0, 255]);
  });
  it('bilinear at identity matches source; singular matrix gives transparent buffer', () => {
    expect(Array.from(transformBuffer(src, matIdentity(), 2, 1, 'bilinear').data)).toEqual(Array.from(src.data));
    expect(transformBuffer(src, matScale(0), 2, 1, 'nearest').data.every((v) => v === 0)).toBe(true);
  });
});
