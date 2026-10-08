import { describe, it, expect } from 'vitest';
import { rectSelection, ellipseSelection, polygonSelection, lassoSelection, selectAll, invertSelection, combineSelections, featherSelection, growSelection, shrinkSelection, selectionBounds, countSelected } from './selection';

describe('selection', () => {
  it('rect area count is exact', () => { expect(countSelected(rectSelection(10, 10, 2, 3, 4, 5))).toBe(20); });
  it('rect clips to canvas', () => { expect(countSelected(rectSelection(4, 4, 2, 2, 10, 10))).toBe(4); });
  it('ellipse center selected, corner not', () => {
    const s = ellipseSelection(11, 11, 5, 5, 5, 5);
    expect(s.mask[5 * 11 + 5]).toBe(255); expect(s.mask[0]).toBe(0);
  });
  it('polygon triangle contains interior, excludes exterior', () => {
    const s = polygonSelection(10, 10, [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 1, y: 8 }]);
    expect(s.mask[2 * 10 + 2]).toBe(255); expect(s.mask[8 * 10 + 8]).toBe(0); expect(countSelected(s)).toBeGreaterThan(10);
  });
  it('lasso is polygon alias', () => { expect(lassoSelection).toBe(polygonSelection); });
  it('selectAll / invert', () => {
    const a = selectAll(3, 2); expect(countSelected(a)).toBe(6);
    expect(countSelected(invertSelection(a))).toBe(0);
    expect(countSelected(invertSelection(rectSelection(4, 4, 0, 0, 0, 0)))).toBe(16);
  });
  it('combine union/intersect/subtract/add', () => {
    const a = rectSelection(6, 6, 0, 0, 4, 4), b = rectSelection(6, 6, 2, 2, 4, 4);
    expect(countSelected(combineSelections(a, b, 'union'))).toBe(28);
    expect(countSelected(combineSelections(a, b, 'add'))).toBe(28);
    expect(countSelected(combineSelections(a, b, 'intersect'))).toBe(4);
    expect(countSelected(combineSelections(a, b, 'subtract'))).toBe(12);
    expect(a.mask).not.toBe(combineSelections(a, b, 'union').mask);
  });
  it('feather reduces hard edge below 255 and spreads coverage outside', () => {
    const s = rectSelection(20, 20, 5, 5, 10, 10);
    const f = featherSelection(s, 1);
    expect(f.mask[10 * 20 + 5]!).toBeLessThan(255);
    expect(f.mask[10 * 20 + 4]!).toBeGreaterThan(0);
    expect(countSelected(f)).toBeGreaterThan(90); expect(countSelected(f)).toBeLessThan(110);
    expect(countSelected(featherSelection(s, 0))).toBe(100); // radius 0 = copy
  });
  it('grow adds a ring, shrink removes a ring', () => {
    const s = rectSelection(20, 20, 5, 5, 10, 10);
    expect(countSelected(growSelection(s, 1))).toBe(144); // 12x12
    expect(countSelected(shrinkSelection(s, 1))).toBe(64); // 8x8
    expect(countSelected(growSelection(s, 0))).toBe(100);
  });
  it('bounds and empty bounds', () => {
    expect(selectionBounds(rectSelection(10, 10, 2, 3, 4, 5))).toEqual({ x: 2, y: 3, w: 4, h: 5 });
    expect(selectionBounds(rectSelection(4, 4, 0, 0, 0, 0))).toBeNull();
  });
  it('inputs are not mutated by operations', () => {
    const s = rectSelection(10, 10, 2, 2, 3, 3); const before = new Uint8Array(s.mask);
    featherSelection(s, 1); growSelection(s, 1); invertSelection(s);
    expect(s.mask).toEqual(before);
  });
});
