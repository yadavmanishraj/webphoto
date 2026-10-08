import { describe, expect, it } from 'vitest';
import type { TextData } from '../../core/contracts';
import { buildFontString, layoutText, type MeasureFn } from './textLayout';

// Fake measure: 10px per character, ignores font
const measure10: MeasureFn = (text) => text.length * 10;

const text = (over: Partial<TextData> = {}): TextData => ({
  text: 'hello world', fontFamily: 'Inter', fontSize: 16, fontWeight: 400,
  italic: false, align: 'left', color: { r: 0, g: 0, b: 0, a: 255 },
  lineHeight: 1.25, letterSpacing: 0, ...over,
});

describe('buildFontString', () => {
  it('builds "italic 700 16px Inter"', () => {
    expect(buildFontString(text({ italic: true, fontWeight: 700 }))).toBe('italic 700 16px Inter');
  });
  it('omits italic when false', () => {
    expect(buildFontString(text({}))).toBe('400 16px Inter');
  });
});

describe('layoutText', () => {
  it('wraps greedily at maxWidth with a fake 10px/char measure', () => {
    // "hello world foo" = words 50,50,30px; width 110 fits "hello world" (110), adding " foo" = 150 > 110
    const out = layoutText(text({ text: 'hello world foo' }), 110, measure10);
    expect(out.lines.map((l) => l.text)).toEqual(['hello world', 'foo']);
    expect(out.lines[0]!.width).toBe(110);
  });
  it('single short line does not wrap', () => {
    const out = layoutText(text({ text: 'hi' }), 500, measure10);
    expect(out.lines).toEqual([{ text: 'hi', width: 20 }]);
  });
  it('honors explicit \\n', () => {
    const out = layoutText(text({ text: 'one\ntwo three' }), 500, measure10);
    expect(out.lines.map((l) => l.text)).toEqual(['one', 'two three']);
  });
  it('\\n plus wrapping combine', () => {
    const out = layoutText(text({ text: 'aa bb\ncc dd ee' }), 50, measure10);
    expect(out.lines.map((l) => l.text)).toEqual(['aa bb', 'cc dd', 'ee']);
  });
  it('long unbreakable word goes on its own line without hanging', () => {
    const out = layoutText(text({ text: 'supercalifragilistic ok' }), 50, measure10);
    expect(out.lines[0]!.text).toBe('supercalifragilistic');
    expect(out.lines[1]!.text).toBe('ok');
  });
  it('empty text produces one empty line', () => {
    const out = layoutText(text({ text: '' }), 100, measure10);
    expect(out.lines).toEqual([{ text: '', width: 0 }]);
    expect(out.totalHeight).toBe(out.lineHeightPx);
  });
  it('lineHeightPx = fontSize * lineHeight and totalHeight scales with lines', () => {
    const out = layoutText(text({ text: 'a\nb\nc', fontSize: 20, lineHeight: 1.5 }), 500, measure10);
    expect(out.lineHeightPx).toBe(30);
    expect(out.totalHeight).toBe(90);
  });
  it('letterSpacing adds per-char width', () => {
    const out = layoutText(text({ text: 'ab', letterSpacing: 5 }), 500, measure10);
    expect(out.lines[0]!.width).toBe(20 + 10);
  });
  it('passes the built font string to measure', () => {
    let seen = '';
    const spy: MeasureFn = (t, font) => { seen = font; return t.length * 10; };
    layoutText(text({ fontWeight: 700 }), 500, spy);
    expect(seen).toBe('700 16px Inter');
  });
});
