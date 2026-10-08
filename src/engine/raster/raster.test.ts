import { describe, it, expect } from 'vitest';
import {
  createBuffer,
  cloneBuffer,
  getPixel,
  setPixel,
  fillRect,
  clearBuffer,
  cropBuffer,
  flipBuffer,
  resizeBuffer,
} from './raster';
import { LIMITS } from '../../core/contracts';
import type { RGBA } from '../../core/contracts';

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

/** 2x2 buffer: TL=v0, TR=v1, BL=v2, BR=v3 as gray+alpha 255. */
function gray2x2(v0: number, v1: number, v2: number, v3: number) {
  const buf = createBuffer(2, 2);
  setPixel(buf, 0, 0, { r: v0, g: v0, b: v0, a: 255 });
  setPixel(buf, 1, 0, { r: v1, g: v1, b: v1, a: 255 });
  setPixel(buf, 0, 1, { r: v2, g: v2, b: v2, a: 255 });
  setPixel(buf, 1, 1, { r: v3, g: v3, b: v3, a: 255 });
  return buf;
}

describe('createBuffer', () => {
  it('creates a transparent buffer of the right shape', () => {
    const b = createBuffer(3, 2);
    expect(b.width).toBe(3);
    expect(b.height).toBe(2);
    expect(b.data).toHaveLength(3 * 2 * 4);
    expect(Array.from(b.data)).toEqual(new Array(24).fill(0));
  });

  it('fills with the given color', () => {
    const b = createBuffer(2, 1, RED);
    expect(getPixel(b, 0, 0)).toEqual(RED);
    expect(getPixel(b, 1, 0)).toEqual(RED);
  });

  it('throws on non-positive, fractional, or over-limit dimensions', () => {
    expect(() => createBuffer(0, 10)).toThrow(RangeError);
    expect(() => createBuffer(10, 0)).toThrow(RangeError);
    expect(() => createBuffer(-1, 10)).toThrow(RangeError);
    expect(() => createBuffer(2.5, 10)).toThrow(RangeError);
    expect(() => createBuffer(LIMITS.maxDimension + 1, 1)).toThrow(RangeError);
    expect(() => createBuffer(1, LIMITS.maxDimension + 1)).toThrow(RangeError);
  });
});

describe('cloneBuffer / clearBuffer', () => {
  it('clone is equal but independent', () => {
    const b = createBuffer(2, 2, RED);
    const c = cloneBuffer(b);
    expect(Array.from(c.data)).toEqual(Array.from(b.data));
    setPixel(c, 0, 0, BLUE);
    expect(getPixel(b, 0, 0)).toEqual(RED); // original untouched
  });

  it('clearBuffer zeroes all pixels', () => {
    const b = createBuffer(2, 2, RED);
    clearBuffer(b);
    expect(Array.from(b.data)).toEqual(new Array(16).fill(0));
  });
});

describe('getPixel / setPixel', () => {
  it('round-trips and clamps channels', () => {
    const b = createBuffer(2, 2);
    setPixel(b, 1, 1, { r: 300, g: -5, b: 12.6, a: 255 });
    expect(getPixel(b, 1, 1)).toEqual({ r: 255, g: 0, b: 13, a: 255 });
  });

  it('is bounds-safe: OOB reads are transparent, OOB writes are ignored', () => {
    const b = createBuffer(2, 2, RED);
    expect(getPixel(b, -1, 0)).toEqual(TRANSPARENT);
    expect(getPixel(b, 0, -1)).toEqual(TRANSPARENT);
    expect(getPixel(b, 2, 0)).toEqual(TRANSPARENT);
    expect(getPixel(b, 0, 2)).toEqual(TRANSPARENT);
    expect(() => {
      setPixel(b, -1, 0, BLUE);
      setPixel(b, 99, 99, BLUE);
    }).not.toThrow();
    expect(getPixel(b, 0, 0)).toEqual(RED);
  });
});

describe('fillRect', () => {
  it('fills exactly the requested rectangle', () => {
    const b = createBuffer(4, 4);
    fillRect(b, 1, 1, 2, 2, RED);
    expect(getPixel(b, 1, 1)).toEqual(RED);
    expect(getPixel(b, 2, 2)).toEqual(RED);
    expect(getPixel(b, 0, 0)).toEqual(TRANSPARENT);
    expect(getPixel(b, 3, 3)).toEqual(TRANSPARENT);
    expect(getPixel(b, 3, 1)).toEqual(TRANSPARENT);
  });

  it('clips rectangles that extend past the edges', () => {
    const b = createBuffer(3, 3);
    fillRect(b, -2, -2, 4, 4, BLUE); // covers x,y in 0..1 only
    expect(getPixel(b, 0, 0)).toEqual(BLUE);
    expect(getPixel(b, 1, 1)).toEqual(BLUE);
    expect(getPixel(b, 2, 2)).toEqual(TRANSPARENT);
    fillRect(b, 2, 2, 100, 100, RED); // covers only (2,2)
    expect(getPixel(b, 2, 2)).toEqual(RED);
    expect(getPixel(b, 1, 2)).toEqual(TRANSPARENT);
  });

  it('non-positive size is a no-op', () => {
    const b = createBuffer(2, 2);
    fillRect(b, 0, 0, 0, 2, RED);
    fillRect(b, 0, 0, 2, -1, RED);
    expect(Array.from(b.data)).toEqual(new Array(16).fill(0));
  });
});

describe('cropBuffer', () => {
  it('extracts the requested region', () => {
    const b = gray2x2(10, 20, 30, 40);
    const c = cropBuffer(b, 1, 0, 1, 2);
    expect(c.width).toBe(1);
    expect(c.height).toBe(2);
    expect(getPixel(c, 0, 0).r).toBe(20);
    expect(getPixel(c, 0, 1).r).toBe(40);
  });

  it('pads out-of-source regions with transparency', () => {
    const b = gray2x2(10, 20, 30, 40);
    const c = cropBuffer(b, 1, 1, 2, 2); // only (0,0) of crop maps inside
    expect(getPixel(c, 0, 0).r).toBe(40);
    expect(getPixel(c, 1, 0)).toEqual(TRANSPARENT);
    expect(getPixel(c, 0, 1)).toEqual(TRANSPARENT);
    expect(getPixel(c, 1, 1)).toEqual(TRANSPARENT);
  });

  it('throws on invalid crop size and does not mutate the source', () => {
    const b = gray2x2(10, 20, 30, 40);
    expect(() => cropBuffer(b, 0, 0, 0, 1)).toThrow(RangeError);
    const before = Array.from(b.data);
    cropBuffer(b, 0, 0, 1, 1);
    expect(Array.from(b.data)).toEqual(before);
  });
});

describe('flipBuffer', () => {
  it('flips horizontally and vertically, returning a new buffer', () => {
    const b = gray2x2(10, 20, 30, 40);
    const h = flipBuffer(b, 'h');
    expect(getPixel(h, 0, 0).r).toBe(20);
    expect(getPixel(h, 1, 0).r).toBe(10);
    expect(getPixel(h, 0, 1).r).toBe(40);
    const v = flipBuffer(b, 'v');
    expect(getPixel(v, 0, 0).r).toBe(30);
    expect(getPixel(v, 1, 1).r).toBe(20);
    // source unchanged, double flip is the identity
    expect(getPixel(b, 0, 0).r).toBe(10);
    expect(Array.from(flipBuffer(h, 'h').data)).toEqual(Array.from(b.data));
  });
});

describe('resizeBuffer', () => {
  it('nearest upscale 2x2 -> 4x4 makes 2x2 blocks', () => {
    const b = gray2x2(10, 20, 30, 40);
    const out = resizeBuffer(b, 4, 4, 'nearest');
    expect(getPixel(out, 0, 0).r).toBe(10);
    expect(getPixel(out, 1, 1).r).toBe(10);
    expect(getPixel(out, 2, 0).r).toBe(20);
    expect(getPixel(out, 3, 1).r).toBe(20);
    expect(getPixel(out, 0, 2).r).toBe(30);
    expect(getPixel(out, 3, 3).r).toBe(40);
  });

  it('nearest downscale 4x4 -> 2x2 samples the top-left pixel of each block', () => {
    const b = createBuffer(4, 4);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        setPixel(b, x, y, { r: y * 4 + x, g: 0, b: 0, a: 255 });
    const out = resizeBuffer(b, 2, 2, 'nearest');
    expect(getPixel(out, 0, 0).r).toBe(0);
    expect(getPixel(out, 1, 0).r).toBe(2);
    expect(getPixel(out, 0, 1).r).toBe(8);
    expect(getPixel(out, 1, 1).r).toBe(10);
  });

  it('bilinear 2x2 -> 4x4 interpolates with pixel-center mapping', () => {
    // Pixel-center mapping: dest (1,1) -> src (0.25,0.25),
    // dest (2,2) -> src (0.75,0.75). For corners 0/100/100/200:
    // (1,1): .5625*0 + .1875*100 + .1875*100 + .0625*200 = 50
    // (2,2): .0625*0 + .1875*100 + .1875*100 + .5625*200 = 150
    const b = gray2x2(0, 100, 100, 200);
    const out = resizeBuffer(b, 4, 4, 'bilinear');
    expect(getPixel(out, 0, 0).r).toBe(0); // clamped to the corner
    expect(getPixel(out, 3, 3).r).toBe(200);
    expect(getPixel(out, 1, 1).r).toBe(50);
    expect(getPixel(out, 2, 2).r).toBe(150);
    expect(getPixel(out, 1, 1).a).toBe(255);
  });

  it('bilinear of a solid color stays that color at any size', () => {
    const b = createBuffer(3, 3, { r: 77, g: 88, b: 99, a: 200 });
    const out = resizeBuffer(b, 7, 5, 'bilinear');
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 7; x++)
        expect(getPixel(out, x, y)).toEqual({ r: 77, g: 88, b: 99, a: 200 });
  });

  it('same-size resize is an identity copy for both methods', () => {
    const b = gray2x2(10, 20, 30, 40);
    expect(Array.from(resizeBuffer(b, 2, 2, 'nearest').data)).toEqual(Array.from(b.data));
    expect(Array.from(resizeBuffer(b, 2, 2, 'bilinear').data)).toEqual(Array.from(b.data));
  });

  it('throws on invalid target dimensions', () => {
    const b = gray2x2(10, 20, 30, 40);
    expect(() => resizeBuffer(b, 0, 4, 'nearest')).toThrow(RangeError);
    expect(() => resizeBuffer(b, 4, -2, 'bilinear')).toThrow(RangeError);
    expect(() => resizeBuffer(b, LIMITS.maxDimension + 1, 4, 'nearest')).toThrow(
      RangeError,
    );
  });
});
