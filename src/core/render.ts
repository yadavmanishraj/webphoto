import { EditorDocument, Layer, PixelBuffer } from './contracts';
import { createPixelBuffer } from './document';
import { compositeBuffers } from '../engine/blend/blend';
import { renderGradient } from '../engine/gradient/gradient';
import { rasterizeShape } from '../engine/shapes/shapes';
import { applyAdjustment } from '../engine/filters/adjustments';
import { transformBuffer, matMultiply, matTranslate, matRotate, matScale } from '../engine/transform/transform';

/**
 * Canonical renderer: document model -> pixels. The canvas is never the
 * source of truth. Raster layers hold document-sized buffers in v1;
 * non-identity transforms are resampled at render time (non-destructive:
 * the stored pixels are never rewritten by a transform).
 * Text layers are drawn by the browser renderer (Canvas2D) on top of this
 * composite — see docs/browser-limitations.md.
 */
export function layerOwnBuffer(doc: EditorDocument, l: Layer): PixelBuffer | null {
  if (l.gradient) return renderGradient(doc.width, doc.height, l.gradient);
  switch (l.type) {
    case 'raster': return l.pixels ?? null;
    case 'fill': {
      const b = createPixelBuffer(doc.width, doc.height, l.fillColor);
      return b;
    }
    case 'shape': {
      if (!l.shape) return null;
      const s = rasterizeShape(l.shape);
      const out = createPixelBuffer(doc.width, doc.height);
      const dx = Math.round(l.transform.x), dy = Math.round(l.transform.y);
      for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
        const tx = x + dx, ty = y + dy; if (tx < 0 || ty < 0 || tx >= doc.width || ty >= doc.height) continue;
        const si = (y * s.width + x) * 4, ti = (ty * doc.width + tx) * 4;
        out.data[ti] = s.data[si]!; out.data[ti + 1] = s.data[si + 1]!; out.data[ti + 2] = s.data[si + 2]!; out.data[ti + 3] = s.data[si + 3]!;
      }
      return out;
    }
    default: return null; // text/group/adjustment handled by caller
  }
}

function applyMaskAlpha(buf: PixelBuffer, l: Layer): void {
  if (!l.mask || !l.maskEnabled) return;
  const m = l.mask;
  for (let i = 0; i < buf.width * buf.height; i++) {
    const mv = m.data[Math.min(i, m.data.length - 1)]!;
    buf.data[i * 4 + 3] = Math.round(buf.data[i * 4 + 3]! * (mv / 255));
  }
}
function applyTransform(buf: PixelBuffer, l: Layer): PixelBuffer {
  const t = l.transform;
  const isShapeOrGradient = l.type === 'shape'; // shape already placed via x/y
  if (isShapeOrGradient) return buf;
  if (t.rotationDeg === 0 && t.scaleX === 1 && t.scaleY === 1 && t.x === 0 && t.y === 0) return buf;
  let m = matTranslate(t.x, t.y);
  m = matMultiply(m, matTranslate(buf.width / 2, buf.height / 2));
  m = matMultiply(m, matRotate(t.rotationDeg));
  m = matMultiply(m, matScale(t.scaleX, t.scaleY));
  m = matMultiply(m, matTranslate(-buf.width / 2, -buf.height / 2));
  return transformBuffer(buf, m, buf.width, buf.height, 'bilinear');
}

function renderList(doc: EditorDocument, ids: string[]): PixelBuffer {
  const acc = createPixelBuffer(doc.width, doc.height);
  let prevAlpha: PixelBuffer | null = null;
  for (let i = ids.length - 1; i >= 0; i--) { // bottom-most first
    const l = doc.layers[ids[i]!]; if (!l || !l.visible) continue;
    if (l.type === 'adjustment' && l.adjustment) {
      const adjusted = applyAdjustment(accSnapshot(acc), l.adjustment);
      acc.data.set(adjusted.data);
      continue;
    }
    let buf: PixelBuffer | null;
    if (l.type === 'group') {
      if (l.childIds.length === 0) continue;
      buf = renderList(doc, l.childIds);
    } else {
      buf = layerOwnBuffer(doc, l);
    }
    if (!buf) continue;
    // The defensive copy below exists only because mask/clip mutate the
    // buffer in place: skip it when nothing downstream can mutate the
    // layer's own pixels (perf audit P1 — most layers have neither).
    // Group buffers are already fresh accumulators; transformed buffers
    // are resampled into fresh ones by applyTransform.
    const identityPath = l.type === 'shape' || (l.transform.rotationDeg === 0 && l.transform.scaleX === 1 && l.transform.scaleY === 1 && l.transform.x === 0 && l.transform.y === 0);
    const canMutate = identityPath && ((!!l.mask && l.maskEnabled) || l.clipped);
    if (canMutate && l.type !== 'group') buf = { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
    buf = applyTransform(buf, l);
    applyMaskAlpha(buf, l);
    if (l.clipped && prevAlpha) {
      for (let p = 0; p < acc.width * acc.height; p++)
        buf.data[p * 4 + 3] = Math.round(buf.data[p * 4 + 3]! * (prevAlpha.data[p * 4 + 3]! / 255));
    }
    compositeBuffers(acc, buf, l.opacity, l.blendMode);
    prevAlpha = buf;
  }
  return acc;
}
const accSnapshot = (b: PixelBuffer): PixelBuffer =>
  ({ width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) });

export function compositeDocument(doc: EditorDocument): PixelBuffer {
  const acc = renderList(doc, doc.rootIds);
  // Composite over document background only where nothing covers? Background
  // is a real layer in v1, so acc is final. Return as-is.
  return acc;
}
