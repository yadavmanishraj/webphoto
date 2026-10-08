import { describe, it, expect } from 'vitest';
import {
  rgbaToHex,
  hexToRgba,
  rgbToHsl,
  hslToRgb,
  rgbToHsv,
  hsvToRgb,
  parseColor,
} from './color';
import type { RGBA } from '../../core/contracts';

describe('rgbaToHex / hexToRgba', () => {
  it('encodes opaque colors as #rrggbb', () => {
    expect(rgbaToHex({ r: 255, g: 0, b: 0, a: 255 })).toBe('#ff0000');
    expect(rgbaToHex({ r: 0, g: 128, b: 255, a: 255 })).toBe('#0080ff');
    expect(rgbaToHex({ r: 0, g: 0, b: 0, a: 255 })).toBe('#000000');
  });

  it('encodes translucent colors as #rrggbbaa', () => {
    expect(rgbaToHex({ r: 255, g: 0, b: 0, a: 128 })).toBe('#ff000080');
  });

  it('parses #rgb by doubling each nibble', () => {
    expect(hexToRgba('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 255 });
    expect(hexToRgba('#0f8')).toEqual({ r: 0, g: 255, b: 136, a: 255 });
  });

  it('parses #rrggbb and #rrggbbaa, case-insensitively', () => {
    expect(hexToRgba('#0080ff')).toEqual({ r: 0, g: 128, b: 255, a: 255 });
    expect(hexToRgba('#FF000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 });
  });

  it('rejects malformed hex strings', () => {
    expect(hexToRgba('ff0000')).toBeNull(); // missing '#'
    expect(hexToRgba('#ff')).toBeNull();
    expect(hexToRgba('#fffff')).toBeNull();
    expect(hexToRgba('#gggggg')).toBeNull();
    expect(hexToRgba('')).toBeNull();
    expect(hexToRgba('#')).toBeNull();
  });

  it('hex round-trips', () => {
    const colors: RGBA[] = [
      { r: 12, g: 34, b: 56, a: 255 },
      { r: 200, g: 150, b: 100, a: 77 },
      { r: 0, g: 0, b: 0, a: 0 },
    ];
    for (const c of colors) expect(hexToRgba(rgbaToHex(c))).toEqual(c);
  });
});

describe('HSL conversion', () => {
  it('known values: pure red is h=0, s=1, l=0.5', () => {
    const hsl = rgbToHsl({ r: 255, g: 0, b: 0, a: 255 });
    expect(hsl.h).toBeCloseTo(0, 5);
    expect(hsl.s).toBeCloseTo(1, 5);
    expect(hsl.l).toBeCloseTo(0.5, 5);
    expect(hsl.a).toBe(255);
  });

  it('known values: white/black/gray have s=0', () => {
    expect(rgbToHsl({ r: 255, g: 255, b: 255, a: 255 }).l).toBeCloseTo(1, 5);
    expect(rgbToHsl({ r: 0, g: 0, b: 0, a: 255 }).l).toBeCloseTo(0, 5);
    const gray = rgbToHsl({ r: 128, g: 128, b: 128, a: 255 });
    expect(gray.s).toBeCloseTo(0, 5);
    expect(gray.l).toBeCloseTo(128 / 255, 5);
  });

  it('hslToRgb inverts known primaries and preserves alpha', () => {
    expect(hslToRgb({ h: 120, s: 1, l: 0.5, a: 90 })).toEqual({
      r: 0, g: 255, b: 0, a: 90,
    });
    expect(hslToRgb({ h: 240, s: 1, l: 0.5 })).toEqual({
      r: 0, g: 0, b: 255, a: 255,
    });
  });

  it('wraps out-of-range hues', () => {
    expect(hslToRgb({ h: 360, s: 1, l: 0.5 })).toEqual(
      hslToRgb({ h: 0, s: 1, l: 0.5 }),
    );
    expect(hslToRgb({ h: -120, s: 1, l: 0.5 })).toEqual(
      hslToRgb({ h: 240, s: 1, l: 0.5 }),
    );
  });

  it('RGB -> HSL -> RGB round-trips approximately', () => {
    const samples: RGBA[] = [
      { r: 255, g: 0, b: 0, a: 255 },
      { r: 30, g: 200, b: 90, a: 200 },
      { r: 123, g: 45, b: 210, a: 255 },
      { r: 250, g: 240, b: 230, a: 10 },
      { r: 128, g: 128, b: 128, a: 255 },
    ];
    for (const c of samples) {
      const back = hslToRgb(rgbToHsl(c));
      expect(Math.abs(back.r - c.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - c.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - c.b)).toBeLessThanOrEqual(1);
      expect(back.a).toBe(c.a);
    }
  });
});

describe('HSV conversion', () => {
  it('known values: pure red is h=0, s=1, v=1', () => {
    const hsv = rgbToHsv({ r: 255, g: 0, b: 0, a: 42 });
    expect(hsv.h).toBeCloseTo(0, 5);
    expect(hsv.s).toBeCloseTo(1, 5);
    expect(hsv.v).toBeCloseTo(1, 5);
    expect(hsv.a).toBe(42);
  });

  it('hsvToRgb inverts known values and round-trips approximately', () => {
    expect(hsvToRgb({ h: 60, s: 1, v: 1 })).toEqual({
      r: 255, g: 255, b: 0, a: 255,
    });
    const samples: RGBA[] = [
      { r: 10, g: 90, b: 160, a: 255 },
      { r: 255, g: 128, b: 0, a: 128 },
      { r: 64, g: 64, b: 64, a: 255 },
    ];
    for (const c of samples) {
      const back = hsvToRgb(rgbToHsv(c));
      expect(Math.abs(back.r - c.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - c.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - c.b)).toBeLessThanOrEqual(1);
      expect(back.a).toBe(c.a);
    }
  });
});

describe('parseColor', () => {
  it('parses hex forms', () => {
    expect(parseColor('#00ff00')).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(parseColor('  #abc  ')).toEqual({ r: 170, g: 187, b: 204, a: 255 });
  });

  it('parses rgb() and rgba() (CSS alpha 0..1)', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 255 });
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual({
      r: 10, g: 20, b: 30, a: 128, // 0.5 * 255 = 127.5 -> 128
    });
    expect(parseColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('rgba(0,0,0,1)')).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it('rejects garbage', () => {
    expect(parseColor('red')).toBeNull();
    expect(parseColor('rgb(1,2)')).toBeNull();
    expect(parseColor('rgba(1,2,3)')).toBeNull();
    expect(parseColor('hsl(0, 100%, 50%)')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});
