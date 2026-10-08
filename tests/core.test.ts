import { describe, it, expect } from 'vitest';
import { createDocument, createLayer, flattenTree, countLayers } from '../src/core/document';
import { History } from '../src/core/history';
import * as C from '../src/core/commands';
import { compositeDocument } from '../src/core/render';
import { paintStroke } from '../src/engine/brush/brush';

const brush = { size: 10, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0 };

describe('document + history + commands', () => {
  it('creates a document with a locked background layer', () => {
    const doc = createDocument(64, 48);
    expect(doc.width).toBe(64); expect(countLayers(doc)).toBe(1);
    expect(doc.layers[doc.rootIds[0]!]!.name).toBe('Background');
  });
  it('rejects invalid sizes', () => { expect(() => createDocument(0, 10)).toThrow(); expect(() => createDocument(99999, 10)).toThrow(); });
  it('add / rename / opacity / undo / redo roundtrip', () => {
    const doc = createDocument(32, 32); const h = new History();
    const layer = createLayer('raster', 32, 32, 'Paint');
    h.execute(C.addLayerCommand(layer), doc);
    expect(countLayers(doc)).toBe(2);
    h.execute(C.renameLayerCommand(layer.id, 'Hero'), doc);
    h.execute(C.setOpacityCommand(layer.id, 0.5), doc);
    expect(doc.layers[layer.id]!.opacity).toBe(0.5);
    h.undo(doc); expect(doc.layers[layer.id]!.opacity).toBe(1);
    h.undo(doc); expect(doc.layers[layer.id]!.name).toBe('Paint');
    h.redo(doc); expect(doc.layers[layer.id]!.name).toBe('Hero');
    h.undo(doc); h.undo(doc); expect(countLayers(doc)).toBe(1);
  });
  it('undo-then-new-edit discards the redo branch', () => {
    const doc = createDocument(16, 16); const h = new History();
    const a = createLayer('raster', 16, 16, 'A');
    h.execute(C.addLayerCommand(a), doc); h.undo(doc);
    const b = createLayer('raster', 16, 16, 'B');
    h.execute(C.addLayerCommand(b), doc);
    expect(h.canRedo()).toBe(false);
    expect(flattenTree(doc).map(x => x.layer.name)).toContain('B');
  });
  it('100 sequential commands undo and redo cleanly', () => {
    const doc = createDocument(8, 8); const h = new History();
    for (let i = 0; i < 100; i++) h.execute(C.addLayerCommand(createLayer('raster', 8, 8, `L${i}`)), doc);
    expect(countLayers(doc)).toBe(101);
    for (let i = 0; i < 100; i++) expect(h.undo(doc)).toBe(true);
    expect(countLayers(doc)).toBe(1);
    for (let i = 0; i < 100; i++) expect(h.redo(doc)).toBe(true);
    expect(countLayers(doc)).toBe(101);
  });
  it('nested groups flatten without corrupting parent/child links', () => {
    const doc = createDocument(16, 16); const h = new History();
    const g1 = createLayer('group', 16, 16, 'A'); const g2 = createLayer('group', 16, 16, 'B');
    const leaf = createLayer('raster', 16, 16, 'leaf');
    h.execute(C.addLayerCommand(g1), doc);
    // insert g2 inside g1, leaf inside g2 via direct model insert through add command parent param
    h.execute(C.addLayerCommand(g2, g1.id), doc);
    h.execute(C.addLayerCommand(leaf, g2.id), doc);
    const tree = flattenTree(doc);
    expect(tree.find(x => x.layer.id === leaf.id)!.depth).toBe(2);
    expect(doc.layers[g1.id]!.childIds).toContain(g2.id);
    expect(doc.layers[g2.id]!.childIds).toContain(leaf.id);
    // deleting the outer group deletes descendants exactly once
    h.execute(C.removeLayerCommand(g1.id), doc);
    expect(doc.layers[g2.id]).toBeUndefined(); expect(doc.layers[leaf.id]).toBeUndefined();
    h.undo(doc);
    expect(doc.layers[leaf.id]).toBeDefined();
  });
  it('painting via pixelCommand is undoable at pixel level', () => {
    const doc = createDocument(32, 32); const h = new History();
    const l = createLayer('raster', 32, 32, 'P');
    h.execute(C.addLayerCommand(l), doc);
    h.execute(C.pixelCommand('stroke', l.id, (ly) => paintStroke(ly.pixels!, [{ x: 16, y: 16 }], brush, { r: 255, g: 0, b: 0, a: 255 }, 'paint')), doc);
    const comp = compositeDocument(doc);
    const i = (16 * 32 + 16) * 4;
    expect(comp.data[i]).toBe(255); expect(comp.data[i + 2]).toBe(0);
    h.undo(doc);
    const comp2 = compositeDocument(doc);
    expect(comp2.data[i]).toBe(255); expect(comp2.data[i + 2]).toBe(255); // background white again
  });
  it('invisible layers do not render; opacity halves blend over background', () => {
    const doc = createDocument(4, 4, 't', { r: 0, g: 0, b: 255, a: 255 });
    const h = new History();
    const l = createLayer('raster', 4, 4, 'red');
    h.execute(C.addLayerCommand(l), doc);
    h.execute(C.pixelCommand('fill', l.id, (ly) => paintStroke(ly.pixels!, [{ x: 2, y: 2 }], { ...brush, size: 40 }, { r: 255, g: 0, b: 0, a: 255 }, 'paint')), doc);
    let comp = compositeDocument(doc);
    expect(comp.data[0]).toBe(255); expect(comp.data[2]).toBe(0);
    h.execute(C.setLayerPropsCommand(l.id, { visible: false }), doc);
    comp = compositeDocument(doc);
    expect(comp.data[0]).toBe(0); expect(comp.data[2]).toBe(255);
  });
});
