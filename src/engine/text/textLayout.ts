import type { TextData } from '../../core/contracts';

export type MeasureFn = (text: string, font: string) => number;

export function buildFontString(t: TextData): string {
  const style = t.italic ? 'italic ' : '';
  return `${style}${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
}

export function layoutText(
  t: TextData,
  maxWidth: number,
  measure: MeasureFn,
): { lines: { text: string; width: number }[]; lineHeightPx: number; totalHeight: number } {
  const font = buildFontString(t);
  const lineHeightPx = t.fontSize * t.lineHeight;
  const widthOf = (text: string): number => measure(text, font) + t.letterSpacing * text.length;

  const lines: { text: string; width: number }[] = [];
  const paragraphs = t.text.split('\n');

  for (const para of paragraphs) {
    const words = para.split(' ').filter((wd) => wd.length > 0);
    if (words.length === 0) {
      lines.push({ text: '', width: 0 });
      continue;
    }
    let current = '';
    for (const word of words) {
      if (current === '') {
        // Single word always goes on its own line even if it exceeds maxWidth (no infinite loop)
        current = word;
        continue;
      }
      const candidate = current + ' ' + word;
      if (maxWidth > 0 && widthOf(candidate) > maxWidth) {
        lines.push({ text: current, width: widthOf(current) });
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== '') {
      lines.push({ text: current, width: widthOf(current) });
    }
  }

  return { lines, lineHeightPx, totalHeight: lines.length * lineHeightPx };
}
