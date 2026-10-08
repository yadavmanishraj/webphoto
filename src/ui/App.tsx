import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BLEND_MODES, BlendMode, Command, EditorDocument, Layer, PixelBuffer, RGBA, Selection,
  emptySelection, fullSelection,
} from '../core/contracts';
import {
  cloneMask, clonePixels, createDocument, createLayer, createPixelBuffer, flattenTree,
} from '../core/document';
import { History } from '../core/history';
import * as C from '../core/commands';
import { compositeDocument } from '../core/render';
import { paintStroke, BrushSettings } from '../engine/brush/brush';
import { renderGradient } from '../engine/gradient/gradient';
import {
  rectSelection, ellipseSelection, polygonSelection, invertSelection, featherSelection,
  growSelection, shrinkSelection, selectionBounds,
} from '../engine/selection/selection';
import * as F from '../engine/filters/filters';
import { applyAdjustment } from '../engine/filters/adjustments';
import { cropBuffer, flipBuffer, resizeBuffer } from '../engine/raster/raster';
import { hexToRgba, rgbaToHex } from '../engine/color/color';
import { buildFontString, layoutText } from '../engine/text/textLayout';
import { serializeProject, deserializeProject } from '../storage/project';
import { IndexedDbAutosaveStore, makeRecoveryRecord, RecoveryRecord } from '../storage/autosave';
import { LIMITS } from '../core/contracts';

const autosaveStore = new IndexedDbAutosaveStore();

/** Shift a doc-space selection into a layer's local space (layers render
 * offset by transform.x/y, so painting must index the mask in layer
 * coordinates — design/a11y audit F7). */
function shiftSelection(sel: Selection, dx: number, dy: number): Selection {
  if (dx === 0 && dy === 0) return sel;
  const mask = new Uint8Array(sel.width * sel.height);
  for (let y = 0; y < sel.height; y++) for (let x = 0; x < sel.width; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx >= 0 && sy >= 0 && sx < sel.width && sy < sel.height) mask[y * sel.width + x] = sel.mask[sy * sel.width + sx]!;
  }
  return { width: sel.width, height: sel.height, mask };
}

type Tool = 'move' | 'brush' | 'eraser' | 'rect-select' | 'ellipse-select' | 'lasso' | 'eyedropper' | 'fill' | 'text' | 'shape' | 'gradient' | 'crop' | 'hand' | 'zoom';
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'move', icon: '➤', label: 'Move', key: 'V' },
  { id: 'rect-select', icon: '▭', label: 'Rectangular Marquee', key: 'M' },
  { id: 'ellipse-select', icon: '◯', label: 'Elliptical Marquee', key: 'M' },
  { id: 'lasso', icon: '⌒', label: 'Lasso', key: 'L' },
  { id: 'brush', icon: '✎', label: 'Brush', key: 'B' },
  { id: 'eraser', icon: '⌫', label: 'Eraser', key: 'E' },
  { id: 'fill', icon: '◩', label: 'Paint Bucket', key: 'G' },
  { id: 'gradient', icon: '◐', label: 'Gradient', key: 'G' },
  { id: 'eyedropper', icon: '⌖', label: 'Eyedropper', key: 'I' },
  { id: 'text', icon: 'T', label: 'Text', key: 'T' },
  { id: 'shape', icon: '▢', label: 'Shape', key: 'U' },
  { id: 'crop', icon: '⌐', label: 'Crop', key: 'C' },
  { id: 'hand', icon: '☞', label: 'Hand', key: 'H' },
  { id: 'zoom', icon: '⊕', label: 'Zoom', key: 'Z' },
];
const PALETTE = ['#000000','#ffffff','#ff0000','#ff7f00','#ffff00','#00c853','#2680eb','#7b1fa2','#795548','#9e9e9e','#00bcd4','#e91e63','#8bc34a','#3f51b5'];

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function floodFill(buf: PixelBuffer, sx: number, sy: number, color: RGBA, tol = 32, sel?: Selection | null) {
  const { width: w, height: h, data } = buf;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const si = (sy * w + sx) * 4;
  const tr = data[si]!, tg = data[si + 1]!, tb = data[si + 2]!, ta = data[si + 3]!;
  const match = (i: number) => Math.abs(data[i]! - tr) <= tol && Math.abs(data[i + 1]! - tg) <= tol && Math.abs(data[i + 2]! - tb) <= tol && Math.abs(data[i + 3]! - ta) <= tol;
  const stack = [[sx, sy]]; const seen = new Set<number>();
  while (stack.length) {
    const [x, y] = stack.pop()!; const idx = y * w + x; if (seen.has(idx)) continue; seen.add(idx);
    const i = idx * 4; if (!match(i)) continue;
    if (sel && sel.mask[idx] === 0) continue;
    data[i] = color.r; data[i + 1] = color.g; data[i + 2] = color.b; data[i + 3] = color.a;
    if (x > 0) stack.push([x - 1, y]); if (x < w - 1) stack.push([x + 1, y]);
    if (y > 0) stack.push([x, y - 1]); if (y < h - 1) stack.push([x, y + 1]);
  }
}

export default function App() {
  const docRef = useRef<EditorDocument>(createDocument(1280, 800, 'Untitled-1'));
  const histRef = useRef<History>(new History());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [version, setVersion] = useState(0);
  const [tool, setTool] = useState<Tool>('brush');
  const [fg, setFg] = useState<RGBA>({ r: 17, g: 17, b: 17, a: 255 });
  const [bg, setBg] = useState<RGBA>({ r: 255, g: 255, b: 255, a: 255 });
  const [brush, setBrush] = useState<BrushSettings>({ size: 24, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0 });
  const [zoom, setZoom] = useState(0.6);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selMode] = useState<'replace' | 'add' | 'subtract'>('replace');
  const [menu, setMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('Saved');
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [shapeKind, setShapeKind] = useState<'rectangle' | 'ellipse' | 'rounded-rectangle' | 'polygon' | 'line'>('rectangle');
  const [paintTargetMode, setPaintTargetMode] = useState<'pixels' | 'mask'>('pixels');
  const dragRef = useRef<any>(null);
  const doc = docRef.current;
  const active = doc.activeLayerId ? doc.layers[doc.activeLayerId] : undefined;
  const bump = useCallback(() => setVersion(v => v + 1), []);
  const exec = useCallback((cmd: Command) => {
    histRef.current.execute(cmd, docRef.current);
    setDirty(true); setSaveState('Unsaved changes'); bump();
  }, [bump]);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  /* ---------- rendering ---------- */
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const d = docRef.current;
    const comp = compositeDocument(d);
    const off = document.createElement('canvas'); off.width = d.width; off.height = d.height;
    const octx = off.getContext('2d')!;
    octx.putImageData(new ImageData(new Uint8ClampedArray(comp.data), comp.width, comp.height), 0, 0);
    // text layers (browser renderer — Canvas2D font engine)
    for (const l of Object.values(d.layers)) {
      if (l.type !== 'text' || !l.visible || !l.text) continue;
      octx.save();
      octx.globalAlpha = l.opacity;
      octx.translate(l.transform.x, l.transform.y); octx.rotate((l.transform.rotationDeg * Math.PI) / 180);
      octx.scale(l.transform.scaleX, l.transform.scaleY);
      octx.font = buildFontString(l.text);
      octx.fillStyle = `rgba(${l.text.color.r},${l.text.color.g},${l.text.color.b},${l.text.color.a / 255})`;
      octx.textAlign = l.text.align; octx.textBaseline = 'alphabetic';
      const layout = layoutText(l.text, 100000, (t, f) => { octx.font = f; return octx.measureText(t).width; });
      const blockWidth = layout.lines.reduce((m, ln) => Math.max(m, ln.width), 0);
      const x = l.text.align === 'center' ? blockWidth / 2 : l.text.align === 'right' ? blockWidth : 0;
      layout.lines.forEach((ln, i) => octx.fillText(ln.text, x, (i + 1) * layout.lineHeightPx - (layout.lineHeightPx - l.text!.fontSize) / 2));
      octx.restore();
    }
    cv.width = d.width; cv.height = d.height;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, d.width, d.height);
    ctx.drawImage(off, 0, 0);
    if (d.grid.visible) {
      ctx.strokeStyle = 'rgba(120,120,120,.35)'; ctx.beginPath();
      for (let x = 0; x <= d.width; x += d.grid.spacing) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, d.height); }
      for (let y = 0; y <= d.height; y += d.grid.spacing) { ctx.moveTo(0, y + .5); ctx.lineTo(d.width, y + .5); }
      ctx.stroke();
    }
    ctx.strokeStyle = '#2680eb'; ctx.setLineDash([]);
    for (const g of d.guides) { ctx.beginPath(); if (g.orientation === 'v') { ctx.moveTo(g.position + .5, 0); ctx.lineTo(g.position + .5, d.height); } else { ctx.moveTo(0, g.position + .5); ctx.lineTo(d.width, g.position + .5); } ctx.stroke(); }
    if (selection) {
      const img = ctx.createImageData(d.width, d.height);
      const m = selection.mask, sw = selection.width, sh = selection.height;
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const i = y * sw + x; if (m[i]! === 0) continue;
        img.data[i * 4] = 38; img.data[i * 4 + 1] = 128; img.data[i * 4 + 2] = 235; img.data[i * 4 + 3] = 70;
        // True selection outline (not just the bounding box): a selected
        // pixel bordering an unselected one becomes an opaque white edge.
        const edge = x === 0 || y === 0 || x === sw - 1 || y === sh - 1 ||
          m[i - 1] === 0 || m[i + 1] === 0 || m[i - sw] === 0 || m[i + sw] === 0;
        if (edge) { img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 220; }
      }
      const sc = document.createElement('canvas'); sc.width = d.width; sc.height = d.height;
      sc.getContext('2d')!.putImageData(img, 0, 0); ctx.drawImage(sc, 0, 0);
    }
  }, [version, selection]);

  /* ---------- autosave / recovery ---------- */
  useEffect(() => {
    const store = autosaveStore;
    store.load().then(r => { if (r) setRecovery(r); }).catch(() => {});
    const iv = setInterval(() => {
      if (!dirty) return;
      setSaveState('Saving…');
      store.save(makeRecoveryRecord(docRef.current))
        .then(() => { setDirty(false); setSaveState('Autosaved ' + new Date().toLocaleTimeString()); })
        .catch(() => setSaveState('Autosave failed (storage unavailable)'));
    }, 15000);
    return () => clearInterval(iv);
  }, [dirty]);

  /* ---------- pointer ---------- */
  const getPos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect(); const d = docRef.current;
    // Pressure normalization: a mouse has no real pressure (browsers report
    // 0 or 0.5, which would bead or even erase strokes). Only pen/touch
    // pressure is honored, and a 0 reading while dragging falls back to 1.
    const rawP = (e as any).pressure as number | undefined;
    const pressure = (e as any).pointerType === 'mouse' || rawP === undefined || rawP <= 0 ? 1 : rawP;
    return {
      x: Math.floor((e.clientX - rect.left) * (d.width / rect.width)),
      y: Math.floor((e.clientY - rect.top) * (d.height / rect.height)),
      pressure,
    };
  };
  const paintTarget = (): Layer | undefined => {
    const l = active; if (!l || l.locked) return undefined;
    if (paintTargetMode === 'mask' && l.mask) return l;
    return l.type === 'raster' ? l : undefined;
  };
  const onDown = (e: React.PointerEvent) => {
    const d = docRef.current; const p = getPos(e); setMenu(null);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === 'hand') { const el = document.querySelector('.workspace')!; dragRef.current = { tool, sx: e.clientX, sy: e.clientY, sl: el.scrollLeft, st: el.scrollTop }; return; }
    if (tool === 'zoom') { setZoom(z => Math.max(0.05, Math.min(8, e.altKey ? z / 1.25 : z * 1.25))); return; }
    if (tool === 'eyedropper') {
      const comp = compositeDocument(d); const i = (p.y * d.width + p.x) * 4;
      if (p.x >= 0 && p.y >= 0 && p.x < d.width && p.y < d.height) setFg({ r: comp.data[i]!, g: comp.data[i + 1]!, b: comp.data[i + 2]!, a: comp.data[i + 3]! });
      setTool('brush'); return;
    }
    if (tool === 'text') {
      const l = createLayer('text', d.width, d.height); l.transform.x = p.x; l.transform.y = p.y;
      if (l.text) l.text.color = { ...fg };
      exec(C.addLayerCommand(l)); setTool('move'); return;
    }
    if (tool === 'shape' || tool === 'gradient' || tool === 'crop' || tool === 'rect-select' || tool === 'ellipse-select' || tool === 'lasso' || tool === 'move') {
      dragRef.current = { tool, start: p, points: [p], moved: false };
      if (tool === 'move' && active) dragRef.current.prevTransform = { ...active.transform };
      return;
    }
    // brush / eraser / fill
    const l = paintTarget(); if (!l) { if (active?.locked) setError('Layer is locked.'); return; }
    if (tool === 'fill') {
      if (!l.pixels) return;
      const t = l.transform;
      const selLocal = selection ? shiftSelection(selection, -t.x, -t.y) : null;
      exec(C.pixelCommand('Paint bucket', l.id, (ly) => floodFill(ly.pixels!, p.x - t.x, p.y - t.y, fg, 32, selLocal)));
      return;
    }
    const before = clonePixels(l.pixels); const beforeMask = cloneMask(l.mask);
    const maskPaint = paintTargetMode === 'mask' && !!l.mask && (tool === 'brush' || tool === 'eraser');
    let maskBuf: PixelBuffer | undefined;
    if (maskPaint) {
      maskBuf = createPixelBuffer(l.mask!.width, l.mask!.height);
      for (let i = 0; i < l.mask!.data.length; i++) { const v = l.mask!.data[i]!; maskBuf.data[i * 4] = v; maskBuf.data[i * 4 + 1] = v; maskBuf.data[i * 4 + 2] = v; maskBuf.data[i * 4 + 3] = 255; }
    }
    dragRef.current = { tool, layerId: l.id, before, beforeMask, points: [p], maskPaint, maskBuf,
      selLocal: selection ? shiftSelection(selection, -l.transform.x, -l.transform.y) : null };
    applyStroke([p], e);
  };
  const rafRef = useRef(false);
  const scheduleBump = useCallback(() => {
    if (rafRef.current) return; rafRef.current = true;
    requestAnimationFrame(() => { rafRef.current = false; bump(); });
  }, [bump]);
  const applyStroke = (pts: { x: number; y: number; pressure?: number }[], _e?: React.PointerEvent) => {
    const drag = dragRef.current; if (!drag?.layerId) return;
    const l = docRef.current.layers[drag.layerId]; if (!l) return;
    // Points arrive in document space; layer buffers are layer-local and
    // render offset by transform.x/y — translate before painting (F7).
    const t = l.transform;
    const local = pts.map(p => ({ ...p, x: p.x - t.x, y: p.y - t.y }));
    const sel = (drag.selLocal ?? undefined) as Selection | undefined;
    if (drag.maskPaint && drag.maskBuf && l.mask) {
      // Mask painting: brush paints the foreground's luminance as gray
      // (white reveals, black hides); eraser paints black (hides).
      const lum = Math.round(0.2126 * fg.r + 0.7152 * fg.g + 0.0722 * fg.b);
      const col: RGBA = tool === 'eraser' ? { r: 0, g: 0, b: 0, a: 255 } : { r: lum, g: lum, b: lum, a: 255 };
      paintStroke(drag.maskBuf, local, brush, col, 'paint', sel);
      for (let i = 0; i < l.mask.data.length; i++) l.mask.data[i] = drag.maskBuf.data[i * 4]!;
      scheduleBump(); return;
    }
    if (!l.pixels) return;
    paintStroke(l.pixels, local, brush, fg, tool === 'eraser' ? 'erase' : 'paint', sel);
    scheduleBump();
  };
  const onMove = (e: React.PointerEvent) => {
    const d = docRef.current; const p = getPos(e); setCursor(p);
    const drag = dragRef.current; if (!drag) return;
    if (drag.tool === 'hand') { const el = document.querySelector('.workspace')!; el.scrollLeft = drag.sl - (e.clientX - drag.sx); el.scrollTop = drag.st - (e.clientY - drag.sy); return; }
    if (drag.layerId) { const last = drag.points[drag.points.length - 1]; drag.points.push(p); applyStroke([last, p], e); return; }
    if (drag.start) {
      drag.moved = true; drag.points.push(p); drag.current = p;
      if (drag.tool === 'move' && active && !active.locked) {
        active.transform.x = drag.prevTransform.x + (p.x - drag.start.x);
        active.transform.y = drag.prevTransform.y + (p.y - drag.start.y); bump();
      }
      if (drag.tool === 'rect-select') setSelection(rectSelection(d.width, d.height, Math.min(drag.start.x, p.x), Math.min(drag.start.y, p.y), Math.abs(p.x - drag.start.x), Math.abs(p.y - drag.start.y)));
      if (drag.tool === 'ellipse-select') setSelection(ellipseSelection(d.width, d.height, (drag.start.x + p.x) / 2, (drag.start.y + p.y) / 2, Math.abs(p.x - drag.start.x) / 2, Math.abs(p.y - drag.start.y) / 2));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const drag = dragRef.current; dragRef.current = null; if (!drag) return;
    const d = docRef.current; const p = drag.current ?? getPos(e);
    if (drag.layerId) {
      const l = d.layers[drag.layerId]; if (!l) return;
      const after = clonePixels(l.pixels); const afterMask = cloneMask(l.mask);
      const label = drag.tool === 'eraser' ? 'Eraser' : 'Brush stroke';
      exec({ label, do: (dd) => { const ly = dd.layers[drag.layerId]; if (ly) { ly.pixels = clonePixels(after); ly.mask = cloneMask(afterMask); } }, undo: (dd) => { const ly = dd.layers[drag.layerId]; if (ly) { ly.pixels = clonePixels(drag.before); ly.mask = cloneMask(drag.beforeMask); } } });
      return;
    }
    if (drag.tool === 'move' && active && drag.moved) {
      const to = { ...active.transform }; const from = drag.prevTransform;
      exec({ label: 'Move layer', do: (dd) => { const ly = dd.layers[active.id]; if (ly) ly.transform = { ...to }; }, undo: (dd) => { const ly = dd.layers[active.id]; if (ly) ly.transform = { ...from }; } });
      return;
    }
    if (drag.tool === 'lasso' && drag.points.length > 2) setSelection(polygonSelection(d.width, d.height, drag.points));
    if (drag.tool === 'shape' && drag.moved) {
      const l = createLayer('shape', d.width, d.height);
      l.transform.x = Math.min(drag.start.x, p.x); l.transform.y = Math.min(drag.start.y, p.y);
      l.shape = { kind: shapeKind, w: Math.max(4, Math.abs(p.x - drag.start.x)), h: Math.max(4, Math.abs(p.y - drag.start.y)), cornerRadius: 12, sides: 5, fill: { ...fg }, stroke: null, strokeWidth: 0 };
      exec(C.addLayerCommand(l)); return;
    }
    if (drag.tool === 'gradient' && drag.moved) {
      const l = createLayer('raster', d.width, d.height, 'Gradient');
      const angle = (Math.atan2(p.y - drag.start.y, p.x - drag.start.x) * 180) / Math.PI;
      const grad = renderGradient(d.width, d.height, { kind: 'linear', angleDeg: angle, reverse: false, stops: [{ offset: 0, color: { ...fg } }, { offset: 1, color: { ...bg } }] });
      l.pixels = grad; exec(C.addLayerCommand(l)); return;
    }
    if (drag.tool === 'crop' && drag.moved) {
      const x = Math.min(drag.start.x, p.x), y = Math.min(drag.start.y, p.y);
      const w = Math.abs(p.x - drag.start.x), h = Math.abs(p.y - drag.start.y);
      if (w > 4 && h > 4) exec(C.documentCommand('Crop', (dd) => {
        for (const ly of Object.values(dd.layers)) { if (ly.pixels) ly.pixels = cropBuffer(ly.pixels, x, y, w, h); if (ly.mask) { const rgba = new Uint8ClampedArray(ly.mask.width * ly.mask.height * 4); for (let i = 0; i < ly.mask.data.length; i++) { rgba[i * 4] = ly.mask.data[i]!; rgba[i * 4 + 3] = 255; } const m = cropBuffer({ width: ly.mask.width, height: ly.mask.height, data: rgba }, x, y, w, h); const nd = new Uint8Array(w * h); for (let i = 0; i < nd.length; i++) nd[i] = m.data[i * 4]!; ly.mask = { width: w, height: h, data: nd }; } }
        dd.width = w; dd.height = h;
      }));
      setSelection(null); setTool('move');
    }
  };

  /* ---------- actions ---------- */
  const undo = () => { if (histRef.current.undo(docRef.current)) { setDirty(true); bump(); } };
  const redo = () => { if (histRef.current.redo(docRef.current)) { setDirty(true); bump(); } };
  const newRasterLayer = () => exec(C.addLayerCommand(createLayer('raster', doc.width, doc.height)));
  const exportImage = (fmt: 'png' | 'jpeg' | 'webp') => {
    try {
      const comp = compositeDocument(docRef.current);
      const cv = document.createElement('canvas'); cv.width = comp.width; cv.height = comp.height;
      const ctx = cv.getContext('2d')!;
      if (fmt === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); }
      const tmp = document.createElement('canvas'); tmp.width = comp.width; tmp.height = comp.height;
      tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(comp.data), comp.width, comp.height), 0, 0);
      ctx.drawImage(tmp, 0, 0);
      cv.toBlob(b => { if (b) download(b, `${docRef.current.name}.${fmt}`); else fail(new Error('Export failed')); }, `image/${fmt}`, 0.92);
    } catch (e) { fail(e); }
  };
  const saveProject = () => { try { download(new Blob([serializeProject(docRef.current) as BlobPart], { type: 'application/octet-stream' }), `${docRef.current.name}.wpsc`); setSaveState('Project saved'); setDirty(false); } catch (e) { fail(e); } };
  const openProjectFile = (f: File) => {
    if (f.size > LIMITS.maxProjectBytes) { setError('Project file exceeds the size limit.'); return; }
    f.arrayBuffer().then(ab => {
    try { docRef.current = deserializeProject(new Uint8Array(ab)); histRef.current.clear(); setSelection(null); setDirty(false); bump(); }
    catch (e) { fail(e); }
    }).catch(fail);
  };
  const importImageFile = (f: File) => {
    if (f.size > LIMITS.maxImportBytes) { setError(`Image is too large (max ${Math.round(LIMITS.maxImportBytes / 1048576)} MB).`); return; }
    if (f.type === 'image/svg+xml') { setError('SVG import is not supported — import a PNG, JPEG, WebP or GIF instead.'); return; }
    createImageBitmap(f).then(bmp => {
      if (bmp.width > LIMITS.maxDimension || bmp.height > LIMITS.maxDimension) {
        bmp.close();
        setError(`Image dimensions ${bmp.width}×${bmp.height} exceed the ${LIMITS.maxDimension}px limit.`);
        return;
      }
      const d = docRef.current;
      const scale = Math.min(1, d.width / bmp.width, d.height / bmp.height);
      const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
      const cv = document.createElement('canvas'); cv.width = d.width; cv.height = d.height;
      const ctx = cv.getContext('2d')!; ctx.drawImage(bmp, Math.round((d.width - w) / 2), Math.round((d.height - h) / 2), w, h);
      const img = ctx.getImageData(0, 0, d.width, d.height);
      const l = createLayer('raster', d.width, d.height, f.name.replace(/\.[^.]+$/, ''));
      l.pixels = { width: d.width, height: d.height, data: img.data };
      exec(C.addLayerCommand(l));
    }).catch(fail);
  };
  const applyFilter = (name: string) => {
    const l = active; if (!l?.pixels || l.type !== 'raster') { setError('Filters need an active raster layer.'); return; }
    const map: Record<string, (b: PixelBuffer) => PixelBuffer> = {
      'Gaussian Blur': b => F.gaussianBlur(b, 3), 'Sharpen': b => F.sharpen(b, 1),
      'Invert': b => F.invertBuffer(b), 'Grayscale': b => F.grayscaleBuffer(b),
      'Threshold': b => F.thresholdBuffer(b, 128), 'Posterize': b => F.posterizeBuffer(b, 4),
      'Noise': b => F.noiseBuffer(b, 25, 42), 'Pixelate': b => F.pixelateBuffer(b, 8),
      'Emboss': b => F.embossBuffer(b), 'Edge Detect': b => F.edgeDetectBuffer(b),
      'Brightness +20': b => F.brightnessContrast(b, 20, 0), 'Contrast +20': b => F.brightnessContrast(b, 0, 20),
    };
    const fn = map[name]; if (!fn) return;
    exec(C.pixelCommand(name, l.id, (ly) => { ly.pixels = fn(ly.pixels!); }));
  };
  const addMask = () => {
    const l = active; if (!l) return;
    exec(C.pixelCommand('Add layer mask', l.id, (ly) => {
      ly.mask = { width: doc.width, height: doc.height, data: selection ? new Uint8Array(selection.mask) : new Uint8Array(doc.width * doc.height).fill(255) };
      ly.maskEnabled = true;
    }));
  };
  const deleteSelectionPixels = () => {
    const l = active; if (!l?.pixels || !selection) return;
    const sel = shiftSelection(selection, -l.transform.x, -l.transform.y);
    exec(C.pixelCommand('Clear selection', l.id, (ly) => {
      for (let i = 0; i < sel.mask.length; i++) { const a = sel.mask[i]! / 255; ly.pixels!.data[i * 4 + 3] = Math.round(ly.pixels!.data[i * 4 + 3]! * (1 - a)); }
    }));
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(null); }
      const inField = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement).tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.shiftKey ? setDialog('export') : saveProject(); return; }
      if (mod && e.key.toLowerCase() === 'a' && !inField) { e.preventDefault(); setSelection(fullSelection(docRef.current.width, docRef.current.height)); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); setSelection(null); return; }
      if (inField) return;
      if (!mod && e.key.toLowerCase() === 'x') { setFg(bg); setBg(fg); return; }
      const t = TOOLS.find(x => x.key === e.key.toUpperCase());
      if (t && !mod) setTool(t.id);
      if (e.key === 'Delete' || e.key === 'Backspace') { if (selection) deleteSelectionPixels(); }
      if (e.key === '[') setBrush(b => ({ ...b, size: Math.max(1, b.size - 2) }));
      if (e.key === ']') setBrush(b => ({ ...b, size: b.size + 2 }));
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const menus: Record<string, { label: string; action?: () => void; sep?: boolean; shortcut?: string; disabled?: boolean }[]> = {
    File: [
      { label: 'New…', action: () => setDialog('new'), shortcut: 'Ctrl+N' },
      { label: 'Open Project…', action: () => document.getElementById('open-file')!.click() },
      { label: 'Import Image…', action: () => document.getElementById('import-file')!.click() },
      { label: 'sep', sep: true },
      { label: 'Save Project (.wpsc)', action: saveProject, shortcut: 'Ctrl+S' },
      { label: 'Export PNG', action: () => exportImage('png') },
      { label: 'Export JPEG', action: () => exportImage('jpeg') },
      { label: 'Export WebP', action: () => exportImage('webp') },
    ],
    Edit: [
      { label: 'Undo', action: undo, shortcut: 'Ctrl+Z', disabled: !histRef.current.canUndo() }, { label: 'Redo', action: redo, shortcut: 'Ctrl+Shift+Z', disabled: !histRef.current.canRedo() },
      { label: 'sep', sep: true },
      { label: 'Clear Selection Pixels', action: deleteSelectionPixels, shortcut: 'Del', disabled: !selection },
      { label: 'Fill Selection with Foreground', action: () => { const l = active; if (l?.pixels && selection) { const sel = shiftSelection(selection, -l.transform.x, -l.transform.y); exec(C.pixelCommand('Fill', l.id, (ly) => { for (let i = 0; i < sel.mask.length; i++) if (sel.mask[i]) { ly.pixels!.data[i * 4] = fg.r; ly.pixels!.data[i * 4 + 1] = fg.g; ly.pixels!.data[i * 4 + 2] = fg.b; ly.pixels!.data[i * 4 + 3] = fg.a; } })); } } },
    ],
    Image: [
      { label: 'Image Size…', action: () => setDialog('resize-image') },
      { label: 'Canvas Size…', action: () => setDialog('canvas-size') },
      { label: 'Rotate 90° CW', action: () => exec(C.documentCommand('Rotate 90', (dd) => { for (const ly of Object.values(dd.layers)) if (ly.pixels) { const src = ly.pixels; const out = createPixelBuffer(src.height, src.width); for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) { const si = (y * src.width + x) * 4, ti = (x * src.height + (src.height - 1 - y)) * 4; for (let k = 0; k < 4; k++) out.data[ti + k] = src.data[si + k]!; } ly.pixels = out; ly.mask = undefined; } [dd.width, dd.height] = [dd.height, dd.width]; })) },
      { label: 'Flip Horizontal', action: () => { const l = active; if (l?.pixels) exec(C.pixelCommand('Flip horizontal', l.id, (ly) => { ly.pixels = flipBuffer(ly.pixels!, 'h'); })); } },
      { label: 'Flip Vertical', action: () => { const l = active; if (l?.pixels) exec(C.pixelCommand('Flip vertical', l.id, (ly) => { ly.pixels = flipBuffer(ly.pixels!, 'v'); })); } },
    ],
    Layer: [
      { label: 'New Raster Layer', action: newRasterLayer },
      { label: 'New Group', action: () => exec(C.createGroupCommand()) },
      { label: 'New Text Layer', action: () => exec(C.addLayerCommand(createLayer('text', doc.width, doc.height))) },
      { label: 'New Fill Layer', action: () => { const l = createLayer('fill', doc.width, doc.height); l.fillColor = { ...fg }; exec(C.addLayerCommand(l)); } },
      { label: 'New Adjustment Layer', action: () => exec(C.addLayerCommand(createLayer('adjustment', doc.width, doc.height))) },
      { label: 'sep', sep: true },
      { label: 'Duplicate Layer', action: () => active && exec(C.duplicateLayerCommand(active.id)) },
      { label: 'Delete Layer', action: () => active && exec(C.removeLayerCommand(active.id)) },
      { label: 'sep', sep: true },
      { label: 'Add Layer Mask (from selection)', action: addMask },
      { label: 'Delete Layer Mask', action: () => active && exec(C.pixelCommand('Delete mask', active.id, (ly) => { ly.mask = undefined; })) },
    ],
    Select: [
      { label: 'All', action: () => setSelection(fullSelection(doc.width, doc.height)), shortcut: 'Ctrl+A' },
      { label: 'Deselect', action: () => setSelection(null), shortcut: 'Ctrl+D' },
      { label: 'Invert', action: () => selection && setSelection(invertSelection(selection)), disabled: !selection },
      { label: 'Feather 5px', action: () => selection && setSelection(featherSelection(selection, 5)), disabled: !selection },
      { label: 'Grow 2px', action: () => selection && setSelection(growSelection(selection, 2)), disabled: !selection },
      { label: 'Shrink 2px', action: () => selection && setSelection(shrinkSelection(selection, 2)), disabled: !selection },
    ],
    Filter: ['Gaussian Blur','Sharpen','Noise','Pixelate','Emboss','Edge Detect','Invert','Grayscale','Posterize','Threshold','Brightness +20','Contrast +20'].map(n => ({ label: n, action: () => applyFilter(n) })),
    View: [
      { label: 'Zoom In', action: () => setZoom(z => Math.min(8, z * 1.25)) },
      { label: 'Zoom Out', action: () => setZoom(z => Math.max(0.05, z / 1.25)) },
      { label: 'Zoom to Fit', action: () => setZoom(0.6) },
      { label: 'Zoom 100%', action: () => setZoom(1) },
      { label: doc.grid.visible ? 'Hide Grid' : 'Show Grid', action: () => { docRef.current.grid.visible = !docRef.current.grid.visible; bump(); } },
      { label: 'Add Vertical Guide at Cursor', action: () => { if (cursor) { docRef.current.guides.push({ orientation: 'v', position: cursor.x }); bump(); } } },
      { label: 'Clear Guides', action: () => { docRef.current.guides = []; bump(); } },
    ],
    Help: [
      { label: 'Keyboard Shortcuts', action: () => setDialog('shortcuts') },
      { label: 'Browser Limitations', action: () => setDialog('limitations') },
      { label: 'About', action: () => setDialog('about') },
    ],
  };

  return (
    <div className="app">
      <div className="menubar">
        <span className="title">◧ Web Photoshop Clone</span>
        {Object.entries(menus).map(([name, items]) => (
          <div className="menu" key={name}>
            <button onClick={() => setMenu(menu === name ? null : name)} aria-haspopup="menu" aria-expanded={menu === name}>{name}</button>
            {menu === name && <div className="dropdown" role="menu">{items.map((it, i) => it.sep
              ? <div className="sep" key={i} />
              : <button key={i} disabled={it.disabled} onClick={() => { setMenu(null); it.action?.(); }}>{it.label}{it.shortcut && <span className="kbd">{it.shortcut}</span>}</button>)}</div>}
          </div>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--dim)' }}>{doc.name} — {doc.width}×{doc.height}px · {saveState}</span>
        <input id="open-file" type="file" accept=".wpsc" hidden onChange={e => { const f = e.target.files?.[0]; if (f) openProjectFile(f); e.target.value = ''; }} />
        <input id="import-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importImageFile(f); e.target.value = ''; }} />
      </div>
      {recovery && <div className="banner">Recovered autosave of “{recovery.docName}” from {new Date(recovery.savedAt).toLocaleString()}.
        <button onClick={() => { try { docRef.current = deserializeProject(Uint8Array.from(atob(recovery.dataB64), c => c.charCodeAt(0))); histRef.current.clear(); autosaveStore.clear().catch(() => {}); setRecovery(null); bump(); } catch (e) { fail(e); } }}>Restore</button>
        <button onClick={() => { autosaveStore.clear().catch(() => {}); setRecovery(null); }}>Dismiss</button></div>}
      {error && <div className="error-banner" role="alert">⚠ {error}<button style={{ marginLeft: 'auto' }} onClick={() => setError(null)}>Dismiss</button></div>}
      <div className="optionsbar">
        {(tool === 'brush' || tool === 'eraser') && <>
          <label>Size <input type="range" min={1} max={300} value={brush.size} onChange={e => setBrush({ ...brush, size: +e.target.value })} /><input type="number" value={brush.size} onChange={e => setBrush({ ...brush, size: +e.target.value })} /></label>
          <label>Hardness <input type="range" min={0} max={100} value={brush.hardness * 100} onChange={e => setBrush({ ...brush, hardness: +e.target.value / 100 })} /></label>
          <label>Opacity <input type="range" min={0} max={100} value={brush.opacity * 100} onChange={e => setBrush({ ...brush, opacity: +e.target.value / 100 })} /></label>
          <label>Flow <input type="range" min={0} max={100} value={brush.flow * 100} onChange={e => setBrush({ ...brush, flow: +e.target.value / 100 })} /></label>
          <label>Presets {[8, 24, 64, 120].map(s => <button key={s} className={brush.size === s ? 'active' : ''} onClick={() => setBrush({ ...brush, size: s })}>{s}px</button>)}</label>
        </>}
        {tool === 'shape' && <label>Shape <select value={shapeKind} onChange={e => setShapeKind(e.target.value as any)}><option value="rectangle">Rectangle</option><option value="rounded-rectangle">Rounded Rectangle</option><option value="ellipse">Ellipse</option><option value="polygon">Polygon</option><option value="line">Line</option></select> Drag on canvas to draw.</label>}
        {(tool === 'rect-select' || tool === 'ellipse-select' || tool === 'lasso') && <span>Mode: Replace · Feather/Grow/Shrink in Select menu {selection ? `· ${selectionBounds(selection)?.w ?? 0}×${selectionBounds(selection)?.h ?? 0}px selected` : ''}</span>}
        {tool === 'move' && <span>Drag the active layer to move it. Numeric transform in the Properties panel.</span>}
        {tool === 'gradient' && <span>Drag on canvas: foreground → background linear gradient on a new layer.</span>}
        {tool === 'crop' && <span>Drag a rectangle, release to crop the document.</span>}
        {tool === 'hand' && <span>Drag to pan the workspace.</span>}
        {tool === 'text' && <span>Click on the canvas to place a text layer, then edit it in Properties.</span>}
      </div>
      <div className="main">
        <div className="toolbar" role="toolbar" aria-label="Tools">
          {TOOLS.map(t => <button key={t.id} className={tool === t.id ? 'active' : ''} title={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={tool === t.id} onClick={() => setTool(t.id)}>{t.icon}</button>)}
          <div style={{ marginTop: 'auto' }} className="fgbg">
            <div title="Foreground / Background (X swaps)">
              <div className="chip" style={{ background: rgbaToHex(bg), width: 22, height: 22, marginLeft: 10 }} />
              <div className="chip" style={{ background: rgbaToHex(fg), width: 26, height: 26, marginTop: -14 }} />
            </div>
          </div>
        </div>
        <div className="workspace">
          <div className="canvas-wrap">
            <div className="canvas-frame" style={{ width: doc.width * zoom, height: doc.height * zoom }}>
              <canvas ref={canvasRef} className="display" style={{ width: doc.width * zoom, height: doc.height * zoom, cursor: tool === 'hand' ? 'grab' : 'crosshair' }}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} aria-label="Image canvas" />
            </div>
          </div>
        </div>
        <aside className="sidepanel">
          <div className="panel-section">
            <h3>Color</h3>
            <div className="fgbg" style={{ marginBottom: 8 }}>
              <label>FG <input type="color" value={rgbaToHex(fg).slice(0, 7)} onChange={e => { const c = hexToRgba(e.target.value); if (c) setFg({ ...c, a: fg.a }); }} /></label>
              <label>BG <input type="color" value={rgbaToHex(bg).slice(0, 7)} onChange={e => { const c = hexToRgba(e.target.value); if (c) setBg({ ...c, a: bg.a }); }} /></label>
              <input value={rgbaToHex(fg)} onChange={e => { const c = hexToRgba(e.target.value); if (c) setFg(c); }} aria-label="Foreground hex" style={{ width: 84 }} />
              <label>Alpha <input type="range" min={0} max={255} value={fg.a} onChange={e => setFg({ ...fg, a: +e.target.value })} style={{ width: 70 }} /></label>
            </div>
            <div className="swatches">{PALETTE.map(c => <button key={c} style={{ background: c }} aria-label={`Swatch ${c}`} onClick={() => { const col = hexToRgba(c); if (col) setFg(col); }} />)}</div>
          </div>
          <div className="panel-section layers">
            <h3>Layers</h3>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              <label style={{ flex: 1 }}>Opacity <input type="range" min={0} max={100} value={Math.round((active?.opacity ?? 1) * 100)} onChange={e => active && exec(C.setOpacityCommand(active.id, +e.target.value / 100))} style={{ width: '100%' }} /></label>
              <select value={active?.blendMode ?? 'normal'} onChange={e => active && exec(C.setBlendCommand(active.id, e.target.value as BlendMode))} aria-label="Blend mode">
                {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {flattenTree(doc).map(({ layer: l, depth }) => (
              <div key={l.id} className={`layer-row ${doc.activeLayerId === l.id ? 'selected' : ''}`} style={{ marginLeft: depth * 14 }}
                role="button" tabIndex={0} aria-pressed={doc.activeLayerId === l.id}
                onClick={() => { docRef.current.activeLayerId = l.id; bump(); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); docRef.current.activeLayerId = l.id; bump(); } }}>
                <button aria-label="Toggle visibility" aria-pressed={l.visible} onClick={e => { e.stopPropagation(); exec(C.setLayerPropsCommand(l.id, { visible: !l.visible }, 'Toggle visibility')); }}>{l.visible ? '◉' : '—'}</button>
                <span className="thumb" aria-hidden />
                <span className="name" onDoubleClick={() => { const n = prompt('Layer name', l.name); if (n) exec(C.renameLayerCommand(l.id, n)); }}>{l.name}{l.mask ? ' ◧' : ''}</span>
                <button aria-label="Toggle lock" aria-pressed={l.locked} onClick={e => { e.stopPropagation(); exec(C.setLayerPropsCommand(l.id, { locked: !l.locked }, 'Toggle lock')); }}>{l.locked ? '⚿' : <span style={{ opacity: 0.35 }}>⚿</span>}</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
              <button onClick={newRasterLayer}>+ Layer</button>
              <button onClick={() => exec(C.createGroupCommand())}>+ Group</button>
              <button onClick={() => active && exec(C.duplicateLayerCommand(active.id))}>Duplicate</button>
              <button onClick={() => active && exec(C.removeLayerCommand(active.id))}>Delete</button>
              <button onClick={addMask}>Add Mask</button>
              <button onClick={() => { const l = active; if (!l) return; const ids = flattenTree(doc).map(x => x.layer.id); const i = ids.indexOf(l.id); if (i > 0) { const sib = (l.parentId ? doc.layers[l.parentId]!.childIds : doc.rootIds); exec(C.reorderLayerCommand(l.id, Math.max(0, sib.indexOf(l.id) - 1))); } }}>↑</button>
              <button onClick={() => { const l = active; if (!l) return; const sib = (l.parentId ? doc.layers[l.parentId]!.childIds : doc.rootIds); exec(C.reorderLayerCommand(l.id, sib.indexOf(l.id) + 1)); }}>↓</button>
            </div>
            {active?.mask && <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--dim)' }}>Brush paints:</span>
              <button className={paintTargetMode === 'pixels' ? 'active' : ''} onClick={() => setPaintTargetMode('pixels')}>Pixels</button>
              <button className={paintTargetMode === 'mask' ? 'active' : ''} onClick={() => setPaintTargetMode('mask')}>Mask ◧</button>
              <button onClick={() => { const l = active; if (!l) return; const prev = l.maskEnabled; exec({ label: 'Toggle mask', do: d => { const ly = d.layers[l.id]; if (ly) ly.maskEnabled = !prev; }, undo: d => { const ly = d.layers[l.id]; if (ly) ly.maskEnabled = prev; } }); }}>{active.maskEnabled ? 'Mask on' : 'Mask off'}</button>
            </div>}
            {active && active.type !== 'group' && <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <span style={{ color: 'var(--dim)' }}>Move active into:</span>
              <select id="group-target" aria-label="Target group" defaultValue="">
                <option value="">Top level</option>
                {Object.values(doc.layers).filter(l => l.type === 'group').map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button onClick={() => { const sel = document.getElementById('group-target') as HTMLSelectElement; exec(C.moveLayerToGroupCommand(active.id, sel.value || null)); }}>Move</button>
            </div>}
          </div>
          <div className="panel-section">
            <h3>Properties {active ? `— ${active.name}` : ''}</h3>
            {active?.type === 'text' && active.text && <div>
              <textarea value={active.text.text} rows={3} style={{ width: '100%', background: '#262626', color: 'var(--text)' }}
                onChange={e => { const prev = { ...active.text! }; const next = { ...active.text!, text: e.target.value }; exec({ label: 'Edit text', do: d => { const ly = d.layers[active.id]; if (ly) ly.text = { ...next }; }, undo: d => { const ly = d.layers[active.id]; if (ly) ly.text = { ...prev }; } }); }} />
              <div className="grid2" style={{ marginTop: 6 }}>
                <label>Size <input type="number" value={active.text.fontSize} onChange={e => { active.text!.fontSize = +e.target.value; bump(); }} /></label>
                <label>Weight <input type="number" value={active.text.fontWeight} step={100} min={100} max={900} onChange={e => { active.text!.fontWeight = +e.target.value; bump(); }} /></label>
                <label>Color <input type="color" value={rgbaToHex(active.text.color).slice(0, 7)} onChange={e => { const c = hexToRgba(e.target.value); if (c) { active.text!.color = c; bump(); } }} /></label>
                <label>Align <select value={active.text.align} onChange={e => { active.text!.align = e.target.value as any; bump(); }}><option>left</option><option>center</option><option>right</option></select></label>
              </div>
            </div>}
            {active?.type === 'shape' && active.shape && <div className="grid2">
              <label>W <input type="number" value={active.shape.w} onChange={e => { active.shape!.w = +e.target.value; bump(); }} /></label>
              <label>H <input type="number" value={active.shape.h} onChange={e => { active.shape!.h = +e.target.value; bump(); }} /></label>
              <label>Radius <input type="number" value={active.shape.cornerRadius} onChange={e => { active.shape!.cornerRadius = +e.target.value; bump(); }} /></label>
              <label>Fill <input type="color" value={active.shape.fill ? rgbaToHex(active.shape.fill).slice(0, 7) : '#000000'} onChange={e => { const c = hexToRgba(e.target.value); if (c) { active.shape!.fill = c; bump(); } }} /></label>
            </div>}
            {active?.type === 'adjustment' && active.adjustment && <div>
              <label>Kind <select value={active.adjustment.kind} onChange={e => { active.adjustment = { kind: e.target.value as any, params: { brightness: 0, contrast: 0, gamma: 1, inBlack: 0, inWhite: 255, outBlack: 0, outWhite: 255, r: 0, g: 0, b: 0, hue: 0, saturation: 0, lightness: 0, levels: 4, threshold: 128 } }; bump(); }}>
                {['brightness-contrast','hue-saturation','levels','gamma','color-balance','invert','grayscale','posterize','threshold'].map(k => <option key={k}>{k}</option>)}
              </select></label>
              {Object.entries(active.adjustment.params).map(([k, v]) => (
                <label key={k} style={{ display: 'flex', gap: 6, marginTop: 4 }}>{k} <input type="range" min={k === 'gamma' ? 10 : -100} max={k === 'gamma' ? 300 : 255} value={k === 'gamma' ? v * 100 : v} onChange={e => { active.adjustment!.params[k] = k === 'gamma' ? +e.target.value / 100 : +e.target.value; bump(); }} /><span>{v}</span></label>
              ))}
            </div>}
            {active && <div className="grid2" style={{ marginTop: 8 }}>
              <label>X <input type="number" value={Math.round(active.transform.x)} onChange={e => exec(C.transformLayerCommand(active.id, { ...active.transform, x: +e.target.value }))} /></label>
              <label>Y <input type="number" value={Math.round(active.transform.y)} onChange={e => exec(C.transformLayerCommand(active.id, { ...active.transform, y: +e.target.value }))} /></label>
              <label>Scale % <input type="number" value={Math.round(active.transform.scaleX * 100)} onChange={e => exec(C.transformLayerCommand(active.id, { ...active.transform, scaleX: +e.target.value / 100, scaleY: +e.target.value / 100 }))} /></label>
              <label>Rotate° <input type="number" value={active.transform.rotationDeg} onChange={e => exec(C.transformLayerCommand(active.id, { ...active.transform, rotationDeg: +e.target.value }))} /></label>
            </div>}
            {!active && <p style={{ color: 'var(--dim)' }}>No layer selected.</p>}
          </div>
          <div className="panel-section">
            <h3>History</h3>
            <div style={{ maxHeight: 110, overflowY: 'auto' }}>
              {histRef.current.entries().map((en, i) => <div className="hist-row" key={i}>{en.label}</div>)}
              {histRef.current.depth === 0 && <div className="hist-row">No actions yet</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={undo} disabled={!histRef.current.canUndo()}>Undo</button>
              <button onClick={redo} disabled={!histRef.current.canRedo()}>Redo</button>
            </div>
          </div>
        </aside>
      </div>
      <div className="statusbar">
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.max(0.05, z / 1.25))}>−</button>
        <input type="range" min={5} max={400} value={zoom * 100} onChange={e => setZoom(+e.target.value / 100)} style={{ width: 110 }} aria-label="Zoom" />
        <button onClick={() => setZoom(z => Math.min(8, z * 1.25))}>+</button>
        <span>{cursor ? `${cursor.x}, ${cursor.y}px` : ''}</span>
        <span>{flattenTree(doc).length} layers · {selMode} selection</span>
        <span className="spacer" />
        <span aria-live="polite">{saveState}</span>
      </div>
      {dialog && <Dialogs name={dialog} close={() => setDialog(null)} doc={doc}
        onNew={(w, h, n, bgc) => { docRef.current = createDocument(w, h, n, bgc); histRef.current.clear(); setSelection(null); setDirty(false); bump(); }}
        onResizeImage={(w, h) => exec(C.documentCommand('Image size', (dd) => { for (const ly of Object.values(dd.layers)) if (ly.pixels) { ly.pixels = resizeBuffer(ly.pixels, w, h, 'bilinear'); ly.mask = undefined; } dd.width = w; dd.height = h; }))}
        onCanvasSize={(w, h) => exec(C.documentCommand('Canvas size', (dd) => { for (const ly of Object.values(dd.layers)) if (ly.pixels) { const out = createPixelBuffer(w, h); const ox = Math.round((w - ly.pixels.width) / 2), oy = Math.round((h - ly.pixels.height) / 2); for (let y = 0; y < ly.pixels.height; y++) for (let x = 0; x < ly.pixels.width; x++) { const tx = x + ox, ty = y + oy; if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue; const si = (y * ly.pixels.width + x) * 4, ti = (ty * w + tx) * 4; for (let k = 0; k < 4; k++) out.data[ti + k] = ly.pixels.data[si + k]!; } ly.pixels = out; ly.mask = undefined; } dd.width = w; dd.height = h; }))}
      />}
    </div>
  );
}

function Dialogs({ name, close, doc, onNew, onResizeImage, onCanvasSize }: {
  name: string; close: () => void; doc: EditorDocument;
  onNew: (w: number, h: number, n: string, bg: RGBA) => void;
  onResizeImage: (w: number, h: number) => void; onCanvasSize: (w: number, h: number) => void;
}) {
  const [w, setW] = useState(doc.width); const [h, setH] = useState(doc.height);
  const [n, setN] = useState('Untitled'); const [bgc, setBgc] = useState('#ffffff');
  const dlgRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Initial focus into the dialog + Escape closes (audit: dialogs had
    // neither). Backdrop dismissal is mousedown-left-button only, so a
    // middle-click paste attempt can't destroy dialog input.
    (dlgRef.current?.querySelector('input, select, textarea') as HTMLElement | null)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [name, close]);
  const wrap = (title: string, body: React.ReactNode, onOk?: () => void) => (
    <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && e.button === 0) close(); }}><div className="dialog" ref={dlgRef} role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>{body}
      <div className="actions"><button onClick={close}>Cancel</button>{onOk && <button className="active" onClick={() => { onOk(); close(); }}>OK</button>}</div>
    </div></div>
  );
  if (name === 'new') return wrap('New Document', <>
    <div className="row"><label>Name</label><input value={n} onChange={e => setN(e.target.value)} /></div>
    <div className="row"><label>Width (px)</label><input type="number" value={w} min={1} max={8192} onChange={e => setW(+e.target.value)} /></div>
    <div className="row"><label>Height (px)</label><input type="number" value={h} min={1} max={8192} onChange={e => setH(+e.target.value)} /></div>
    <div className="row"><label>Background</label><input type="color" value={bgc} onChange={e => setBgc(e.target.value)} /></div>
    <div className="row"><label>Presets</label>{[[1920, 1080], [1280, 800], [1024, 1024], [800, 600]].map(([pw, ph]) => <button key={pw} onClick={() => { setW(pw); setH(ph); }}>{pw}×{ph}</button>)}</div>
  </>, () => { const c = hexToRgba(bgc); if (c) onNew(w, h, n, c); });
  if (name === 'resize-image') return wrap('Image Size', <>
    <div className="row"><label>Width</label><input type="number" value={w} onChange={e => setW(+e.target.value)} /></div>
    <div className="row"><label>Height</label><input type="number" value={h} onChange={e => setH(+e.target.value)} /></div>
    <p style={{ color: 'var(--dim)' }}>Resamples every raster layer (bilinear). This is destructive to layer pixels and is undoable.</p>
  </>, () => onResizeImage(w, h));
  if (name === 'canvas-size') return wrap('Canvas Size', <>
    <div className="row"><label>Width</label><input type="number" value={w} onChange={e => setW(+e.target.value)} /></div>
    <div className="row"><label>Height</label><input type="number" value={h} onChange={e => setH(+e.target.value)} /></div>
    <p style={{ color: 'var(--dim)' }}>Anchor: center. Layers keep their pixels; the canvas grows/shrinks around them.</p>
  </>, () => onCanvasSize(w, h));
  if (name === 'shortcuts') return wrap('Keyboard Shortcuts', <div>
    {[['Undo', 'Ctrl/Cmd+Z'], ['Redo', 'Ctrl/Cmd+Shift+Z / Ctrl+Y'], ['Save Project', 'Ctrl/Cmd+S'], ['Select All', 'Ctrl/Cmd+A'], ['Deselect', 'Ctrl/Cmd+D'], ['Brush', 'B'], ['Eraser', 'E'], ['Move', 'V'], ['Marquee', 'M'], ['Lasso', 'L'], ['Text', 'T'], ['Eyedropper', 'I'], ['Zoom', 'Z'], ['Brush size', '[ and ]'], ['Clear selection', 'Delete']].map(([a, b]) => <div className="row" key={a}><label>{a}</label><span className="kbd">{b}</span></div>)}
  </div>);
  if (name === 'limitations') return wrap('Browser Limitations', <div style={{ lineHeight: 1.6 }}>
    <p>No native filesystem access without a picker, no Photoshop plugins, no proprietary PSD internals (PSD is not supported in v1 — use the native .wpsc format), no OS font installation (browser fonts only), no printer/scanner drivers, no Adobe services. Text is rendered with the browser Canvas2D font engine. Full list: docs/browser-limitations.md in the repo.</p>
  </div>);
  return wrap('About Web Photoshop Clone', <p style={{ lineHeight: 1.6 }}>A professional browser-based raster/vector image editor. Document-model-first architecture, command-based undo/redo, non-destructive adjustment layers, masks, selections, blend modes, autosave with IndexedDB recovery, and a versioned native project format (.wpsc).</p>);
}
