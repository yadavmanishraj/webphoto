import { describe, expect, it } from 'vitest';
import type { GradientData, GradientStop, RGBA } from '../../core/contracts';
import { renderGradient, sampleGradient } from './gradient';

const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const stops: GradientStop[] = [
  { offset: 0, color: BLACK },
  { offset: 1, color: WHITE },
];
const px = (b: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const i = (y * b.width + x) * 4;
  return { r: b.data[i]!, g: b.data[i + 1]!, b: b.data[i + 2]!, a: b.data[i + 3]! };
};

describe('sampleGradient', () => {
  it('endpoints equal the stop colors', () => {
    expect(sampleGradient(stops, 0)).toEqual(BLACK);
    expect(sampleGradient(stops, 1)).toEqual(WHITE);
  });
  it('clamps t outside 0..1', () => {
    expect(sampleGradient(stops, -5)).toEqual(BLACK);
    expect(sampleGradient(stops, 5)).toEqual(WHITE);
  });
  it('midpoint lerps rgb and alpha', () => {
    const c = sampleGradient(
      [{ offset: 0, color: { r: 0, g: 0, b: 0, a: 0 } }, { offset: 1, color: { r: 100, g: 200, b: 255, a: 255 } }],
      0.5,
    );
    expect(c.r).toBeCloseTo(50);
    expect(c.g).toBeCloseTo(100);
    expect(c.a).toBeCloseTo(127.5);
  });
  it('handles unsorted stops', () => {
    expect(sampleGradient([...stops].reverse(), 0)).toEqual(BLACK);
    expect(sampleGradient([...stops].reverse(), 1)).toEqual(WHITE);
  });
  it('single stop always returns that color; empty returns transparent', () => {
    expect(sampleGradient([{ offset: 0.3, color: BLACK }], 0.9)).toEqual(BLACK);
    expect(sampleGradient([], 0.5)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('renderGradient', () => {
  it('linear endpoints approximate stop colors at the extremes', () => {
    const g: GradientData = { kind: 'linear', angleDeg: 0, stops, reverse: false };
    const buf = renderGradient(100, 10, g);
    expect(px(buf, 0, 5).r).toBeLessThan(20);
    expect(px(buf, 99, 5).r).toBeGreaterThan(235);
    expect(px(buf, 50, 5).r).toBeGreaterThan(100);
    expect(px(buf, 50, 5).r).toBeLessThan(160);
  });
  it('radial center equals the first stop', () => {
    const g: GradientData = { kind: 'radial', angleDeg: 0, stops, reverse: false };
    const buf = renderGradient(101, 101, g);
    const c = px(buf, 50, 50);
    expect(c.r).toBe(BLACK.r);
    expect(c.a).toBe(255);
    // corner is far along the gradient
    expect(px(buf, 0, 0).r).toBeGreaterThan(200);
  });
  it('reverse flips t', () => {
    const fwd = renderGradient(100, 10, { kind: 'linear', angleDeg: 0, stops, reverse: false });
    const rev = renderGradient(100, 10, { kind: 'linear', angleDeg: 0, stops, reverse: true });
    expect(px(rev, 0, 5).r).toBeGreaterThan(235);
    expect(px(rev, 99, 5).r).toBeLessThan(20);
    expect(px(fwd, 0, 5).r).toBeLessThan(20);
  });
  it('transparent stops produce real alpha', () => {
    const g: GradientData = {
      kind: 'linear', angleDeg: 0, reverse: false,
      stops: [
        { offset: 0, color: { r: 255, g: 0, b: 0, a: 0 } },
        { offset: 1, color: { r: 255, g: 0, b: 0, a: 255 } },
      ],
    };
    const buf = renderGradient(100, 10, g);
    expect(px(buf, 0, 5).a).toBeLessThan(20);
    expect(px(buf, 99, 5).a).toBeGreaterThan(235);
  });
});
