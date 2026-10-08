import { describe, it, expect } from 'vitest';
import { LIMITS, PixelBuffer, RGBA, Selection } from '../src/core/contracts';
import {
  addLayerToDoc, countLayers, createDocument, createLayer, createPixelBuffer,
} from '../src/core/document';
import { History } from '../src/core/history';
import * as C from '../src/core/commands';
import { compositeDocument } from '../src/core/render';
import { paintStroke, BrushSettings } from '../src/engine/brush/brush';
import { cropBuffer, resizeBuffer } from '../src/engine/raster/raster';
import {
  deserializeProject, deserializeProjectFromBase64, serializeProject,
} from '../src/storage/project';
import { makeRecoveryRecord, MemoryAutosaveStore } from '../src/storage/autosave';

/**
 * CRITIQUE COVERAGE — behaviors the existing suites never exercised:
 * renderer-level group/adjustment/clipped/mask semantics, the exact
 * crop/resize code paths the UI dialogs run, brush×selection partial
 * coverage, history-cap eviction, and maxLayers enforcement.
 * (Not duplicated: blend math, project roundtrip fuzz, selection algebra,
 * group duplicate/move history — those live in engine suites + redteam.)
 */

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 200, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };
const brush: BrushSettings = { size: 10, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0 };

function px(buf: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i]!, buf.data[i + 1]!, buf.data[i + 2]!, buf.data[i + 3]!];
}
function solidRaster(docW: number, docH: number, color: RGBA, name: string) {
  const l = createLayer('raster', docW, docH, name);
  l.pixels = createPixelBuffer(docW, docH, color);
  return l;
}
function expectPx(buf: PixelBuffer, x: number, y: number, want: [number, number, number], tol = 3) {
  const [r, g, b, a] = px(buf, x, y);
  expect(a, `alpha at ${x},${y}`).toBe(255);
  expect(Math.abs(r - want[0]), `r at ${x},${y}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(g - want[1]), `g at ${x},${y}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(b - want[2]), `b at ${x},${y}`).toBeLessThanOrEqual(tol);
}

/* ------------------------------------------------------------------ */
/* Renderer semantics                                                  */
/* ------------------------------------------------------------------ */
describe('renderer: groups, adjustments, clipping, masks', () => {
  it('group opacity is applied to the FLATTENED group, not per child', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const g = createLayer('group', 8, 8, 'G'); g.opacity = 0.5;
    h.execute(C.addLayerCommand(g), doc);
    // Two stacked half-transparent-looking children would differ if opacity
    // were applied per child; a single opaque red child at group opacity .5
    // over white must give exactly the 50% blend.
    const child = solidRaster(8, 8, RED, 'red');
    h.execute(C.addLayerCommand(child, g.id), doc);
    expectPx(compositeDocument(doc), 4, 4, [255, 127, 127], 4);
  });

  it('group blend mode blends the flattened group against what is below', () => {
    const doc = createDocument(8, 8, 't', RED); // red background layer
    const h = new History();
    const g = createLayer('group', 8, 8, 'G'); g.blendMode = 'multiply';
    h.execute(C.addLayerCommand(g), doc);
    const child = solidRaster(8, 8, { r: 128, g: 128, b: 128, a: 255 }, 'gray');
    h.execute(C.addLayerCommand(child, g.id), doc);
    // multiply(red, gray) = (128, 0, 0); normal blending would give the gray.
    expectPx(compositeDocument(doc), 4, 4, [128, 0, 0], 4);
  });

  it('an invisible group hides its entire subtree', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const g = createLayer('group', 8, 8, 'G'); g.visible = false;
    h.execute(C.addLayerCommand(g), doc);
    h.execute(C.addLayerCommand(solidRaster(8, 8, RED, 'red'), g.id), doc);
    expectPx(compositeDocument(doc), 4, 4, [255, 255, 255]);
  });

  it('a group mask masks the flattened group result', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const g = createLayer('group', 8, 8, 'G');
    g.mask = { width: 8, height: 8, data: new Uint8Array(64).map((_, i) => (i % 8 < 4 ? 255 : 0)) };
    h.execute(C.addLayerCommand(g), doc);
    h.execute(C.addLayerCommand(solidRaster(8, 8, RED, 'red'), g.id), doc);
    const comp = compositeDocument(doc);
    expectPx(comp, 2, 4, [255, 0, 0]);
    expectPx(comp, 6, 4, [255, 255, 255]); // right half masked away -> background
  });

  it('adjustment layer affects only the composite BELOW it, never layers above', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const red = solidRaster(8, 8, RED, 'red');
    h.execute(C.addLayerCommand(red), doc);
    const adj = createLayer('adjustment', 8, 8, 'inv');
    adj.adjustment = { kind: 'invert', params: {} };
    h.execute(C.addLayerCommand(adj), doc);
    const top = createLayer('raster', 8, 8, 'top');
    top.pixels = createPixelBuffer(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
      const i = (y * 8 + x) * 4;
      top.pixels.data[i] = 0; top.pixels.data[i + 1] = 0; top.pixels.data[i + 2] = 255; top.pixels.data[i + 3] = 255;
    }
    h.execute(C.addLayerCommand(top), doc);
    const comp = compositeDocument(doc);
    expectPx(comp, 2, 4, [0, 0, 255]);       // blue ABOVE the adjustment: untouched
    expectPx(comp, 6, 4, [0, 255, 255]);     // red BELOW it: inverted to cyan
  });

  it('an adjustment at the BOTTOM of the stack does not retro-apply to layers added above it later in render order', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const adj = createLayer('adjustment', 8, 8, 'inv');
    adj.adjustment = { kind: 'invert', params: {} };
    h.execute(C.addLayerCommand(adj), doc); // sits directly above Background
    h.execute(C.addLayerCommand(solidRaster(8, 8, RED, 'red')), doc); // above the adjustment
    // Red is above the adjustment, so it must stay red (not cyan).
    expectPx(compositeDocument(doc), 4, 4, [255, 0, 0]);
  });

  it('clipped layer is intersected with the alpha of the layer directly below', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const mid = createLayer('raster', 8, 8, 'mid');
    mid.pixels = createPixelBuffer(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
      const i = (y * 8 + x) * 4;
      mid.pixels.data[i] = 255; mid.pixels.data[i + 1] = 255; mid.pixels.data[i + 2] = 255; mid.pixels.data[i + 3] = 255;
    }
    h.execute(C.addLayerCommand(mid), doc);
    const top = solidRaster(8, 8, RED, 'clipme'); top.clipped = true;
    h.execute(C.addLayerCommand(top), doc);
    const comp = compositeDocument(doc);
    expectPx(comp, 2, 4, [255, 0, 0]);       // inside mid's alpha: red survives
    expectPx(comp, 6, 4, [255, 255, 255]);   // outside mid's alpha: clipped away
  });

  it('a clipped layer with nothing below it renders unclipped', () => {
    const doc = createDocument(4, 4, 't', { r: 10, g: 20, b: 30, a: 255 });
    doc.layers[doc.rootIds[0]!]!.clipped = true; // background itself is clipped
    expectPx(compositeDocument(doc), 2, 2, [10, 20, 30]);
  });

  it('maskEnabled=false makes the renderer ignore an all-zero mask', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const l = solidRaster(8, 8, RED, 'masked');
    l.mask = { width: 8, height: 8, data: new Uint8Array(64) }; // all zero = hide all
    l.maskEnabled = false;
    h.execute(C.addLayerCommand(l), doc);
    expectPx(compositeDocument(doc), 4, 4, [255, 0, 0]); // mask ignored
    doc.layers[l.id]!.maskEnabled = true; // in-doc layer (commands insert clones)
    expectPx(compositeDocument(doc), 4, 4, [255, 255, 255]); // mask hides the layer
  });

  it('an undersized 1x1 zero mask hides the whole layer in the renderer (last-value clamp)', () => {
    const doc = createDocument(4, 4, 't', WHITE);
    const h = new History();
    const l = solidRaster(4, 4, RED, 'masked');
    l.mask = { width: 1, height: 1, data: new Uint8Array([0]) };
    h.execute(C.addLayerCommand(l), doc);
    expectPx(compositeDocument(doc), 3, 3, [255, 255, 255]);
  });

  it('fill layer renders its fillColor, honoring layer opacity', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const h = new History();
    const f = createLayer('fill', 8, 8, 'fill'); f.fillColor = { ...BLUE };
    h.execute(C.addLayerCommand(f), doc);
    expectPx(compositeDocument(doc), 4, 4, [0, 0, 255]);
    doc.layers[f.id]!.opacity = 0.5;
    expectPx(compositeDocument(doc), 4, 4, [127, 127, 255], 4);
  });

  it('a layer carrying gradient data renders the gradient, not its pixels', () => {
    const doc = createDocument(16, 16, 't', WHITE);
    const h = new History();
    const l = solidRaster(16, 16, GREEN, 'grad');
    l.gradient = {
      kind: 'linear', angleDeg: 0, reverse: false,
      stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
    };
    h.execute(C.addLayerCommand(l), doc);
    const comp = compositeDocument(doc);
    const [lr, , lb] = px(comp, 0, 8);
    const [rr, , rb] = px(comp, 15, 8);
    expect(lr).toBeGreaterThan(150); expect(lb).toBeLessThan(110); // left ≈ red end
    expect(rb).toBeGreaterThan(150); expect(rr).toBeLessThan(110); // right ≈ blue end
  });

  it('shape layer is placed at its transform x/y and clipped at the canvas edge', () => {
    const doc = createDocument(16, 16, 't', WHITE);
    const h = new History();
    const s = createLayer('shape', 16, 16, 'box');
    s.shape = { kind: 'rectangle', w: 4, h: 3, cornerRadius: 0, sides: 4, fill: { ...GREEN }, stroke: null, strokeWidth: 0 };
    s.transform.x = 5; s.transform.y = 6;
    h.execute(C.addLayerCommand(s), doc);
    const comp = compositeDocument(doc);
    expectPx(comp, 5, 6, [0, 200, 0]);
    expectPx(comp, 8, 8, [0, 200, 0]);       // bottom-right inside the rect
    expectPx(comp, 4, 6, [255, 255, 255]);   // one px left of the shape
    expectPx(comp, 9, 8, [255, 255, 255]);   // one px right of the shape
    // negative placement must not throw and must clip
    doc.layers[s.id]!.transform.x = -2; doc.layers[s.id]!.transform.y = -1;
    const comp2 = compositeDocument(doc);
    expectPx(comp2, 0, 0, [0, 200, 0]);
    expectPx(comp2, 2, 0, [255, 255, 255]);
  });

  it('raster transform translation shifts the render but never rewrites stored pixels', () => {
    const doc = createDocument(8, 8, 't', { r: 0, g: 0, b: 0, a: 255 });
    const h = new History();
    const l = createLayer('raster', 8, 8, 'dot');
    l.pixels = createPixelBuffer(8, 8);
    const di = (2 * 8 + 2) * 4;
    l.pixels.data[di] = 255; l.pixels.data[di + 3] = 255;
    l.transform.x = 3;
    h.execute(C.addLayerCommand(l), doc);
    const comp = compositeDocument(doc);
    expectPx(comp, 5, 2, [255, 0, 0]);  // shifted dot
    expectPx(comp, 2, 2, [0, 0, 0]);    // origin now shows background
    expect(l.pixels.data[di + 3]).toBe(255); // stored pixels untouched (non-destructive)
  });
});

/* ------------------------------------------------------------------ */
/* Command interplay: the exact UI dialog code paths                   */
/* ------------------------------------------------------------------ */
describe('commands: crop / resize / reorder / duplicate interplay', () => {
  /** Replicates src/ui/App.tsx crop handler byte-for-byte in structure. */
  function cropViaUiPath(doc: Parameters<typeof C.documentCommand>[1] extends never ? never : any, x: number, y: number, w: number, h: number) {
    return C.documentCommand('Crop', (dd: any) => {
      for (const ly of Object.values(dd.layers) as any[]) {
        if (ly.pixels) ly.pixels = cropBuffer(ly.pixels, x, y, w, h);
        if (ly.mask) {
          const rgba = new Uint8ClampedArray(ly.mask.width * ly.mask.height * 4);
          for (let i = 0; i < ly.mask.data.length; i++) { rgba[i * 4] = ly.mask.data[i]!; rgba[i * 4 + 3] = 255; }
          const m = cropBuffer({ width: ly.mask.width, height: ly.mask.height, data: rgba }, x, y, w, h);
          const nd = new Uint8Array(w * h);
          for (let i = 0; i < nd.length; i++) nd[i] = m.data[i * 4]!;
          ly.mask = { width: w, height: h, data: nd };
        }
      }
      dd.width = w; dd.height = h;
    });
  }

  it('crop (UI path) crops pixels AND mask AND document dims; undo restores all three', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const l = createLayer('raster', 8, 8, 'art');
    l.pixels = createPixelBuffer(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      l.pixels.data[i] = x * 30; l.pixels.data[i + 1] = y * 30; l.pixels.data[i + 3] = 255;
    }
    l.mask = { width: 8, height: 8, data: new Uint8Array(64).map((_, i) => i) };
    hist.execute(C.addLayerCommand(l), doc);
    hist.execute(cropViaUiPath(doc, 2, 3, 4, 4), doc);
    expect(doc.width).toBe(4); expect(doc.height).toBe(4);
    const layer = doc.layers[l.id]!;
    expect(layer.pixels!.width).toBe(4);
    expect(px(layer.pixels!, 0, 0)).toEqual([60, 90, 0, 255]); // old (2,3)
    expect(layer.mask!.width).toBe(4); expect(layer.mask!.height).toBe(4);
    expect(layer.mask!.data[0]).toBe(3 * 8 + 2); // old mask value at (2,3)
    expect(layer.mask!.data[15]).toBe(6 * 8 + 5); // old mask value at (5,6)
    hist.undo(doc);
    expect(doc.width).toBe(8); expect(doc.height).toBe(8);
    expect(doc.layers[l.id]!.mask!.data[63]).toBe(63);
    expect(px(doc.layers[l.id]!.pixels!, 7, 7)).toEqual([210, 210, 0, 255]);
    hist.redo(doc);
    expect(doc.width).toBe(4);
    expect(px(doc.layers[l.id]!.pixels!, 0, 0)).toEqual([60, 90, 0, 255]);
  });

  it('image resize (UI dialog path) resamples every raster layer, drops masks, undo restores both', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const l = solidRaster(8, 8, RED, 'art');
    l.mask = { width: 8, height: 8, data: new Uint8Array(64).fill(255) };
    hist.execute(C.addLayerCommand(l), doc);
    // Exact apply() body from App.tsx onResizeImage.
    hist.execute(C.documentCommand('Image size', (dd) => {
      for (const ly of Object.values(dd.layers)) if (ly.pixels) { ly.pixels = resizeBuffer(ly.pixels, 4, 4, 'bilinear'); ly.mask = undefined; }
      dd.width = 4; dd.height = 4;
    }), doc);
    expect(doc.width).toBe(4);
    expect(doc.layers[l.id]!.pixels!.width).toBe(4);
    expect(doc.layers[l.id]!.mask).toBeUndefined(); // UI path drops masks on resize
    expectPx(compositeDocument(doc), 2, 2, [255, 0, 0]); // solid color survives resampling
    hist.undo(doc);
    expect(doc.width).toBe(8);
    expect(doc.layers[l.id]!.mask).toBeDefined();
    expect(doc.layers[l.id]!.pixels!.width).toBe(8);
  });

  it('reorderLayerCommand reorders WITHIN a group and leaves root order untouched', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const g = createLayer('group', 8, 8, 'G');
    hist.execute(C.addLayerCommand(g), doc);
    const a = solidRaster(8, 8, RED, 'A');
    const b = solidRaster(8, 8, BLUE, 'B');
    hist.execute(C.addLayerCommand(a, g.id), doc);
    hist.execute(C.addLayerCommand(b, g.id), doc); // b lands on top of a
    expect(doc.layers[g.id]!.childIds).toEqual([b.id, a.id]);
    expectPx(compositeDocument(doc), 4, 4, [0, 0, 255]);
    hist.execute(C.reorderLayerCommand(b.id, 1), doc);
    expect(doc.layers[g.id]!.childIds).toEqual([a.id, b.id]);
    expectPx(compositeDocument(doc), 4, 4, [255, 0, 0]); // render order flipped too
    expect(doc.rootIds).toEqual([g.id, doc.rootIds[1]!]);
    hist.undo(doc);
    expect(doc.layers[g.id]!.childIds).toEqual([b.id, a.id]);
  });

  it('renameLayerCommand on a group child renames only that child', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const g = createLayer('group', 8, 8, 'G');
    hist.execute(C.addLayerCommand(g), doc);
    const a = solidRaster(8, 8, RED, 'child');
    hist.execute(C.addLayerCommand(a, g.id), doc);
    hist.execute(C.renameLayerCommand(a.id, 'hero 🎨'), doc);
    expect(doc.layers[a.id]!.name).toBe('hero 🎨');
    expect(doc.layers[g.id]!.name).toBe('G');
    hist.undo(doc);
    expect(doc.layers[a.id]!.name).toBe('child');
  });

  it('setLayerPropsCommand captures clipped/visible/locked together for undo', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const l = solidRaster(8, 8, RED, 'art');
    hist.execute(C.addLayerCommand(l), doc);
    hist.execute(C.setLayerPropsCommand(l.id, { visible: false, locked: true, clipped: true }), doc);
    const after = doc.layers[l.id]!;
    expect([after.visible, after.locked, after.clipped]).toEqual([false, true, true]);
    hist.undo(doc);
    const back = doc.layers[l.id]!;
    expect([back.visible, back.locked, back.clipped]).toEqual([true, false, false]);
    hist.redo(doc);
    expect(doc.layers[l.id]!.visible).toBe(false);
  });

  it('duplicating a layer INSIDE a group keeps the copy in the group with independent pixels', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const g = createLayer('group', 8, 8, 'G');
    hist.execute(C.addLayerCommand(g), doc);
    const a = solidRaster(8, 8, RED, 'orig');
    hist.execute(C.addLayerCommand(a, g.id), doc);
    hist.execute(C.duplicateLayerCommand(a.id), doc);
    const copyId = doc.activeLayerId!;
    expect(copyId).not.toBe(a.id);
    expect(doc.layers[copyId]!.parentId).toBe(g.id);
    expect(doc.layers[g.id]!.childIds).toContain(copyId);
    expect(doc.layers[g.id]!.childIds).toHaveLength(2);
    // pixel independence: painting the copy must not touch the original
    doc.layers[copyId]!.pixels!.data[0] = 1;
    expect(doc.layers[a.id]!.pixels!.data[0]).toBe(255);
    hist.undo(doc);
    expect(doc.layers[copyId]).toBeUndefined();
    expect(doc.layers[g.id]!.childIds).toEqual([a.id]);
  });

  it('pixelCommand runs its apply() exactly once across do/undo/redo (snapshot replay)', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const l = solidRaster(8, 8, RED, 'art');
    hist.execute(C.addLayerCommand(l), doc);
    let applyCount = 0;
    const cmd = C.pixelCommand('mutate', l.id, (ly) => { applyCount++; ly.pixels!.data[0] = 42; });
    hist.execute(cmd, doc);
    hist.undo(doc); hist.redo(doc); hist.undo(doc); hist.redo(doc);
    expect(applyCount).toBe(1);
    expect(doc.layers[l.id]!.pixels!.data[0]).toBe(42);
  });

  it('transformLayerCommand undo/redo restores the exact transform incl. rotation', () => {
    const doc = createDocument(8, 8, 't', WHITE);
    const hist = new History();
    const l = solidRaster(8, 8, RED, 'art');
    hist.execute(C.addLayerCommand(l), doc);
    const t = { x: 7, y: -3, scaleX: 2, scaleY: 0.5, rotationDeg: 45 };
    hist.execute(C.transformLayerCommand(l.id, t), doc);
    expect(doc.layers[l.id]!.transform).toEqual(t);
    hist.undo(doc);
    expect(doc.layers[l.id]!.transform).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 });
    hist.redo(doc);
    expect(doc.layers[l.id]!.transform).toEqual(t);
  });
});

/* ------------------------------------------------------------------ */
/* Brush x selection, eraser x history                                 */
/* ------------------------------------------------------------------ */
describe('brush/selection and eraser/history interplay', () => {
  it('partial selection coverage (128) scales stamp alpha proportionally', () => {
    const mk = (cov: number) => {
      const buf = createPixelBuffer(16, 16);
      const sel: Selection = { width: 16, height: 16, mask: new Uint8Array(256).fill(cov) };
      paintStroke(buf, [{ x: 8, y: 8 }], brush, RED, 'paint', sel);
      return buf.data[(8 * 16 + 8) * 4 + 3]!;
    };
    expect(mk(255)).toBe(255);
    expect(mk(128)).toBe(128);
    expect(mk(0)).toBe(0);
  });

  it('pixels outside the selection bounds are never painted, even inside the brush radius', () => {
    const buf = createPixelBuffer(16, 16);
    const sel: Selection = { width: 8, height: 16, mask: new Uint8Array(8 * 16).fill(255) }; // left half only
    paintStroke(buf, [{ x: 8, y: 8 }], { ...brush, size: 20 }, RED, 'paint', sel);
    expect(buf.data[(8 * 16 + 12) * 4 + 3]).toBe(0);   // right of selection bounds
    expect(buf.data[(8 * 16 + 4) * 4 + 3]).toBe(255);  // inside selection
  });

  it('erasing through a layer reveals the background, and undo/redo toggles it exactly', () => {
    const doc = createDocument(16, 16, 't', WHITE);
    const hist = new History();
    const l = createLayer('raster', 16, 16, 'paint');
    hist.execute(C.addLayerCommand(l), doc);
    hist.execute(C.pixelCommand('fill red', l.id, (ly) =>
      paintStroke(ly.pixels!, [{ x: 8, y: 8 }], { ...brush, size: 40 }, RED, 'paint')), doc);
    expectPx(compositeDocument(doc), 8, 8, [255, 0, 0]);
    hist.execute(C.pixelCommand('erase center', l.id, (ly) =>
      paintStroke(ly.pixels!, [{ x: 8, y: 8 }], brush, RED, 'erase')), doc);
    expectPx(compositeDocument(doc), 8, 8, [255, 255, 255]); // background shows through
    hist.undo(doc);
    expectPx(compositeDocument(doc), 8, 8, [255, 0, 0]);
    hist.redo(doc);
    expectPx(compositeDocument(doc), 8, 8, [255, 255, 255]);
  });
});

/* ------------------------------------------------------------------ */
/* Storage edges                                                       */
/* ------------------------------------------------------------------ */
describe('storage: exotic-but-legal documents', () => {
  it('roundtrips emoji names, an EMPTY group, a masked shape (mask, no pixels), and a gradient layer', () => {
    const doc = createDocument(8, 8, 'ドキュメント 🎨✨', WHITE);
    const h = new History();
    const empty = createLayer('group', 8, 8, '空 group');
    h.execute(C.addLayerCommand(empty), doc);
    const shape = createLayer('shape', 8, 8, '図形');
    shape.mask = { width: 8, height: 8, data: new Uint8Array(64).map((_, i) => (i * 4) % 256) };
    h.execute(C.addLayerCommand(shape), doc);
    const grad = solidRaster(8, 8, GREEN, 'グラデーション');
    grad.gradient = { kind: 'radial', angleDeg: 30, reverse: true, stops: [{ offset: 0, color: RED }, { offset: 0.5, color: WHITE }, { offset: 1, color: BLUE }] };
    h.execute(C.addLayerCommand(grad), doc);

    const restored = deserializeProject(serializeProject(doc));
    expect(restored.name).toBe('ドキュメント 🎨✨');
    expect(countLayers(restored)).toBe(countLayers(doc));
    const rEmpty = Object.values(restored.layers).find(l => l.name === '空 group')!;
    expect(rEmpty.type).toBe('group');
    expect(rEmpty.childIds).toEqual([]);
    const rShape = Object.values(restored.layers).find(l => l.name === '図形')!;
    expect(rShape.pixels).toBeUndefined();
    expect(Array.from(rShape.mask!.data)).toEqual(Array.from(shape.mask!.data));
    const rGrad = Object.values(restored.layers).find(l => l.name === 'グラデーション')!;
    expect(rGrad.gradient).toEqual(grad.gradient);
    // and the restored document renders identically
    expect(Array.from(compositeDocument(restored).data)).toEqual(Array.from(compositeDocument(doc).data));
  });

  it('autosave record of a document with EVERY layer type restores all of them', async () => {
    const doc = createDocument(8, 8, 'all-types', WHITE);
    const h = new History();
    for (const t of ['group', 'text', 'shape', 'adjustment', 'fill'] as const)
      h.execute(C.addLayerCommand(createLayer(t, 8, 8, `a ${t}`)), doc);
    const record = makeRecoveryRecord(doc);
    expect(record.docName).toBe('all-types');
    const store = new MemoryAutosaveStore();
    await store.save(record);
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    const restored = deserializeProjectFromBase64(loaded!.dataB64);
    const types = new Set(Object.values(restored.layers).map(l => l.type));
    expect(types).toEqual(new Set(['raster', 'group', 'text', 'shape', 'adjustment', 'fill']));
    expect(countLayers(restored)).toBe(countLayers(doc));
  });
});

/* ------------------------------------------------------------------ */
/* Limits & history capacity                                           */
/* ------------------------------------------------------------------ */
describe('limits and history capacity', () => {
  it('addLayerToDoc enforces LIMITS.maxLayers', () => {
    const doc = createDocument(4, 4, 't', WHITE);
    // Stuff the record directly to one below the cap (count is what matters).
    while (countLayers(doc) < LIMITS.maxLayers - 1) {
      const d = createLayer('group', 4, 4, 'filler');
      doc.layers[d.id] = d;
    }
    const last = createLayer('raster', 4, 4, 'last');
    addLayerToDoc(doc, last, null); // 500th layer: allowed
    expect(countLayers(doc)).toBe(LIMITS.maxLayers);
    expect(() => addLayerToDoc(doc, createLayer('raster', 4, 4, 'overflow'), null)).toThrow(/limit/i);
    expect(countLayers(doc)).toBe(LIMITS.maxLayers); // failed add changed nothing
  });

  it('history caps at LIMITS.maxHistoryEntries and evicts the OLDEST command', () => {
    const doc = createDocument(4, 4, 't', WHITE);
    const hist = new History();
    for (let i = 0; i < LIMITS.maxHistoryEntries + 1; i++) {
      let prev = '';
      hist.execute({
        label: `cmd-${i}`,
        do: (d) => { prev = d.name; d.name = `n${i}`; },
        undo: (d) => { d.name = prev; },
      }, doc);
    }
    expect(hist.depth).toBe(LIMITS.maxHistoryEntries);
    expect(hist.entries()[0]!.label).toBe('cmd-1'); // cmd-0 was evicted
    for (let i = 0; i < LIMITS.maxHistoryEntries; i++) expect(hist.undo(doc)).toBe(true);
    expect(hist.canUndo()).toBe(false);
    expect(doc.name).toBe('n0'); // cmd-0's effect remains: it can never be undone
  });

  it('History.clear() empties both stacks', () => {
    const doc = createDocument(4, 4, 't', WHITE);
    const hist = new History();
    const l = solidRaster(4, 4, RED, 'x');
    hist.execute(C.addLayerCommand(l), doc);
    hist.undo(doc);
    expect(hist.canRedo()).toBe(true);
    hist.clear();
    expect(hist.canUndo()).toBe(false);
    expect(hist.canRedo()).toBe(false);
    expect(hist.depth).toBe(0);
    expect(hist.redo(doc)).toBe(false);
  });
});
