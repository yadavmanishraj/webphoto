import type { Selection } from '../../core/contracts';

function make(w: number, h: number): Selection {
  return { width: w, height: h, mask: new Uint8Array(w * h) };
}
function cloneSel(sel: Selection): Selection {
  return { width: sel.width, height: sel.height, mask: new Uint8Array(sel.mask) };
}

export function rectSelection(w: number, h: number, x: number, y: number, rw: number, rh: number): Selection {
  const sel = make(w, h);
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(w, Math.ceil(x + rw)), y1 = Math.min(h, Math.ceil(y + rh));
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) sel.mask[py * w + px] = 255;
  return sel;
}

export function ellipseSelection(w: number, h: number, cx: number, cy: number, rx: number, ry: number): Selection {
  const sel = make(w, h);
  if (rx <= 0 || ry <= 0) return sel;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const dx = (px + 0.5 - cx) / rx, dy = (py + 0.5 - cy) / ry;
    if (dx * dx + dy * dy <= 1) sel.mask[py * w + px] = 255;
  }
  return sel;
}

export function polygonSelection(w: number, h: number, points: { x: number; y: number }[]): Selection {
  const sel = make(w, h);
  if (points.length < 3) return sel;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const cxp = px + 0.5, cyp = py + 0.5;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i]!.x, yi = points[i]!.y;
        const xj = points[j]!.x, yj = points[j]!.y;
        if ((yi > cyp) !== (yj > cyp) && cxp < ((xj - xi) * (cyp - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) sel.mask[py * w + px] = 255;
    }
  }
  return sel;
}

export const lassoSelection = polygonSelection;

export function selectAll(w: number, h: number): Selection {
  const sel = make(w, h); sel.mask.fill(255); return sel;
}

export function invertSelection(sel: Selection): Selection {
  const out = cloneSel(sel);
  for (let i = 0; i < out.mask.length; i++) out.mask[i] = 255 - out.mask[i]!;
  return out;
}

export function combineSelections(a: Selection, b: Selection, mode: 'union' | 'intersect' | 'subtract' | 'add'): Selection {
  const out = make(a.width, a.height);
  for (let i = 0; i < out.mask.length; i++) {
    const av = a.mask[i]!, bv = b.mask[i] ?? 0;
    out.mask[i] = mode === 'intersect' ? Math.min(av, bv)
      : mode === 'subtract' ? Math.max(0, av - bv)
      : Math.max(av, bv); // union & add
  }
  return out;
}

function boxBlurPass(src: Uint8Array, w: number, h: number, r: number, horizontal: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, count = 0;
    for (let k = -r; k <= r; k++) {
      const nx = horizontal ? x + k : x, ny = horizontal ? y : y + k;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) { sum += src[ny * w + nx]!; count++; }
    }
    out[y * w + x] = Math.round(sum / count);
  }
  return out;
}

export function featherSelection(sel: Selection, radius: number): Selection {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return cloneSel(sel);
  let cur: Uint8Array = new Uint8Array(sel.mask);
  // Three box passes approximate a gaussian feather while preserving
  // coverage. The TOTAL spread must equal the requested radius (red-team
  // RT-4: three passes of radius r spread 3r), so r is distributed across
  // the passes: e.g. r=5 -> radii 2,2,1 (sum 5).
  const base = Math.floor(r / 3);
  const radii = [base + (r % 3 > 0 ? 1 : 0), base + (r % 3 > 1 ? 1 : 0), base];
  for (const pr of radii) {
    if (pr === 0) continue;
    cur = boxBlurPass(cur, sel.width, sel.height, pr, true) as Uint8Array;
    cur = boxBlurPass(cur, sel.width, sel.height, pr, false) as Uint8Array;
  }
  return { width: sel.width, height: sel.height, mask: cur };
}

export function growSelection(sel: Selection, px: number): Selection { return dilateErode(sel, Math.floor(px), true); }
export function shrinkSelection(sel: Selection, px: number): Selection { return dilateErode(sel, Math.floor(px), false); }

function dilateErode(sel: Selection, px: number, grow: boolean): Selection {
  if (px <= 0) return cloneSel(sel);
  let cur = new Uint8Array(sel.mask);
  const { width: w, height: h } = sel;
  for (let iter = 0; iter < px; iter++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let best = grow ? 0 : 255;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        const v = nx >= 0 && nx < w && ny >= 0 && ny < h ? cur[ny * w + nx]! : 0;
        best = grow ? Math.max(best, v) : Math.min(best, v);
      }
      next[y * w + x] = best;
    }
    cur = next;
  }
  return { width: w, height: h, mask: cur };
}

export function selectionBounds(sel: Selection): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < sel.height; y++) for (let x = 0; x < sel.width; x++) {
    if (sel.mask[y * sel.width + x]! > 0) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function countSelected(sel: Selection): number {
  let sum = 0; for (const v of sel.mask) sum += v; return sum / 255;
}
