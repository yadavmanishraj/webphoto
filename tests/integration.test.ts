import { describe, it, expect } from 'vitest';
import { createDocument, createLayer } from '../src/core/document';
import { History } from '../src/core/history';
import * as C from '../src/core/commands';
import { compositeDocument } from '../src/core/render';
import { paintStroke } from '../src/engine/brush/brush';
import { rectSelection, featherSelection } from '../src/engine/selection/selection';
import { serializeProject, deserializeProject } from '../src/storage/project';
import { MemoryAutosaveStore, makeRecoveryRecord } from '../src/storage/autosave';

/**
 * §122 FINAL ACCEPTANCE workflow, executed at model level (the same commands
 * the UI dispatches). Browser-level E2E is run against the built app.
 */
describe('§122 final acceptance workflow (model level)', () => {
  it('runs the full edit → save → reload → recover chain with pixel assertions', async () => {
    const doc = createDocument(192, 108, 'Acceptance');
    const h = new History();
    const brush = { size: 12, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0 };

    const l1 = createLayer('raster', 192, 108, 'Strokes');
    h.execute(C.addLayerCommand(l1), doc);
    h.execute(C.pixelCommand('paint', l1.id, (ly) => paintStroke(ly.pixels!, [{ x: 10, y: 10 }, { x: 60, y: 10 }], brush, { r: 255, g: 0, b: 0, a: 255 }, 'paint')), doc);
    const l2 = createLayer('raster', 192, 108, 'Second');
    h.execute(C.addLayerCommand(l2), doc);
    h.execute(C.pixelCommand('paint2', l2.id, (ly) => paintStroke(ly.pixels!, [{ x: 150, y: 80 }], brush, { r: 0, g: 0, b: 255, a: 255 }, 'paint')), doc);
    h.execute(C.renameLayerCommand(l1.id, 'Red strokes'), doc);
    h.execute(C.reorderLayerCommand(l2.id, 1), doc);
    h.execute(C.setOpacityCommand(l2.id, 0.8), doc);
    h.execute(C.setBlendCommand(l2.id, 'multiply'), doc);

    const group = createLayer('group', 192, 108, 'Art');
    h.execute(C.addLayerCommand(group), doc);
    h.execute(C.moveLayerToGroupCommand(l1.id, group.id), doc);
    expect(doc.layers[group.id]!.childIds).toContain(l1.id);

    const sel = featherSelection(rectSelection(192, 108, 0, 0, 40, 40), 2);
    h.execute(C.pixelCommand('mask', l1.id, (ly) => { ly.mask = { width: 192, height: 108, data: new Uint8Array(sel.mask) }; }), doc);
    h.execute(C.pixelCommand('mask paint', l1.id, (ly) => {
      // painting black on the mask hides the red stroke at 10,10
      for (let y = 4; y < 17; y++) for (let x = 4; x < 17; x++) ly.mask!.data[y * 192 + x] = 0;
    }), doc);

    h.execute(C.transformLayerCommand(l2.id, { x: 5, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 }), doc);
    const text = createLayer('text', 192, 108, 'Title');
    text.text!.text = 'Hello'; h.execute(C.addLayerCommand(text), doc);
    const shape = createLayer('shape', 192, 108, 'Box');
    shape.transform.x = 100; shape.transform.y = 20;
    shape.shape = { kind: 'rectangle', w: 40, h: 30, cornerRadius: 0, sides: 4, fill: { r: 0, g: 200, b: 0, a: 255 }, stroke: null, strokeWidth: 0 };
    h.execute(C.addLayerCommand(shape), doc);
    const adj = createLayer('adjustment', 192, 108, 'Brighten');
    adj.adjustment = { kind: 'brightness-contrast', params: { brightness: 10, contrast: 0 } };
    h.execute(C.addLayerCommand(adj), doc);

    // undo several, redo them
    h.undo(doc); h.undo(doc); h.undo(doc);
    expect(doc.layers[adj.id]).toBeUndefined();
    h.redo(doc); h.redo(doc); h.redo(doc);
    expect(doc.layers[adj.id]).toBeDefined();

    // visual assertions: shape green visible, masked red hidden at 10,10
    const comp = compositeDocument(doc);
    const shapePx = (30 * 192 + 120) * 4;
    expect(comp.data[shapePx + 1]).toBeGreaterThan(150); // green channel strong
    const maskedPx = (10 * 192 + 10) * 4;
    expect(comp.data[maskedPx]).toBe(comp.data[maskedPx + 2]); // red gone -> r == b (whitish bg adjusted)

    // save / reload / verify structure + pixels identical
    const bytes = serializeProject(doc);
    const restored = deserializeProject(bytes);
    expect(restored.width).toBe(192); expect(restored.height).toBe(108);
    expect(Object.keys(restored.layers).length).toBe(Object.keys(doc.layers).length);
    const comp2 = compositeDocument(restored);
    expect(Array.from(comp2.data)).toEqual(Array.from(comp.data));

    // autosave / recovery
    const store = new MemoryAutosaveStore();
    await store.save(makeRecoveryRecord(doc));
    const rec = await store.load();
    expect(rec?.docName).toBe('Acceptance');
    const recovered = deserializeProject(Uint8Array.from(atob(rec!.dataB64), c => c.charCodeAt(0)));
    expect(Object.keys(recovered.layers).length).toBe(Object.keys(doc.layers).length);
  });

  it('export-equivalent: composite of a known 2x2 doc matches reference pixels', () => {
    const doc = createDocument(2, 2, 'ref', { r: 0, g: 0, b: 0, a: 255 });
    const comp = compositeDocument(doc);
    expect(Array.from(comp.data)).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  });
});
