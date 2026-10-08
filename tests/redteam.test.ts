/**
 * RED TEAM — Agent 35 (QA / adversarial). Assumes the rest of the team is wrong.
 *
 * Property / fuzz-style tests with deterministic seeded RNG. No production
 * code was modified for this file. Every genuinely broken invariant found
 * while red-teaming was encoded as `it.fails(...)` with a `// CONFIRMED BUG:`
 * comment. STATUS 2026-10-08: all 12 confirmed bugs (15 tests) were fixed by
 * the integration agent and those tests were PROMOTED to strict `it(...)`
 * assertions — the `// CONFIRMED BUG:` comments remain as the historical
 * record of what was broken and where. All tests here are now strict.
 *
 * Attack surfaces: (1) project format roundtrip + corruption, (2) history
 * undo/redo exactness, (3) blend modes vs an independent W3C reference,
 * (4) selection algebra laws, (5) resource limits, (6) transform algebra,
 * (7) determinism / input non-mutation.
 */
import { describe, it, expect } from 'vitest';
import {
  BLEND_MODES, LIMITS,
  type AdjustmentKind, type BlendMode, type EditorDocument, type Layer,
  type MaskBuffer, type PixelBuffer, type Selection,
} from '../src/core/contracts';
import {
  addLayerToDoc, cloneDocument, createDocument, createLayer, createPixelBuffer,
  flattenTree,
} from '../src/core/document';
import { History } from '../src/core/history';
import * as C from '../src/core/commands';
import {
  ProjectError, deserializeProject, deserializeProjectFromBase64,
  serializeProject, serializeProjectToBase64,
} from '../src/storage/project';
import { blendChannel, compositeBuffers } from '../src/engine/blend/blend';
import {
  combineSelections, countSelected, featherSelection, growSelection,
  invertSelection, rectSelection, selectAll, selectionBounds, shrinkSelection,
} from '../src/engine/selection/selection';
import {
  matApply, matIdentity, matInvert, matMultiply, matRotate, matScale,
  matTranslate, transformBuffer, transformedBounds, type Mat,
} from '../src/engine/transform/transform';
import { flipBuffer } from '../src/engine/raster/raster';
import {
  brightnessContrast, edgeDetectBuffer, embossBuffer, gaussianBlur,
  grayscaleBuffer, hueSaturation, invertBuffer, noiseBuffer, pixelateBuffer,
  posterizeBuffer, sharpen, thresholdBuffer,
} from '../src/engine/filters/filters';
import { applyAdjustment } from '../src/engine/filters/adjustments';
import { paintStroke } from '../src/engine/brush/brush';

// ---------------------------------------------------------------------------
// Deterministic RNG + shared helpers
// ---------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG; same seed -> same stream, always. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const ri = (rng: Rng, n: number): number => Math.floor(rng() * n);
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[ri(rng, arr.length)]!;
const rbyte = (rng: Rng): number => Math.floor(rng() * 256);
const randomRGBA = (rng: Rng) => ({ r: rbyte(rng), g: rbyte(rng), b: rbyte(rng), a: rbyte(rng) });

function randomPixelBuffer(rng: Rng, w: number, h: number): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = rbyte(rng);
  return { width: w, height: h, data };
}
function randomMaskBuffer(rng: Rng, w: number, h: number): MaskBuffer {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = rbyte(rng);
  return { width: w, height: h, data };
}

/**
 * Canonical document fingerprint: exact on every semantic field (structure,
 * root/child order, per-layer props, pixel + mask bytes) but insensitive to
 * the insertion order of the `layers` record, which is not semantic.
 */
function fingerprint(doc: EditorDocument): string {
  const parts: string[] = [];
  parts.push(
    `doc:${doc.id}:${doc.width}x${doc.height}:v${doc.version}:${doc.name}:` +
    `${JSON.stringify(doc.background)}:root=${JSON.stringify(doc.rootIds)}:` +
    `active=${doc.activeLayerId}:guides=${JSON.stringify(doc.guides)}:grid=${JSON.stringify(doc.grid)}`,
  );
  for (const id of Object.keys(doc.layers).sort()) {
    const l = doc.layers[id]!;
    parts.push([
      id, l.name, l.type, l.visible, l.locked, l.opacity, l.blendMode,
      JSON.stringify(l.transform), String(l.parentId), JSON.stringify(l.childIds),
      l.maskEnabled, l.clipped,
      l.pixels ? `px${l.pixels.width}x${l.pixels.height}[${Array.from(l.pixels.data).join(',')}]` : '-',
      l.mask ? `mk${l.mask.width}x${l.mask.height}[${Array.from(l.mask.data).join(',')}]` : '-',
      JSON.stringify(l.text ?? null), JSON.stringify(l.shape ?? null),
      JSON.stringify(l.gradient ?? null), JSON.stringify(l.adjustment ?? null),
      JSON.stringify(l.fillColor ?? null),
    ].join('|'));
  }
  return parts.join('\n');
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------
// RT-1 — Project format: random documents must roundtrip exactly
// ---------------------------------------------------------------------------

const LAYER_TYPES = ['raster', 'group', 'text', 'shape', 'adjustment', 'fill'] as const;
const ADJ_KINDS: AdjustmentKind[] = [
  'brightness-contrast', 'hue-saturation', 'levels', 'invert',
  'grayscale', 'posterize', 'threshold', 'gamma', 'color-balance',
];

function randomDocument(rng: Rng, w: number, h: number): EditorDocument {
  const doc = createDocument(w, h, pick(rng, ['RT Doc', 'Proj ü', 'Test 🎨', 'a/b\\c "quoted"']));
  const groups: Layer[] = [];
  const total = 3 + ri(rng, 6);
  for (let i = 0; i < total; i++) {
    const type = pick(rng, LAYER_TYPES);
    const layer = createLayer(type, w, h, `L${i}-${pick(rng, ['α', 'bé', 'x y', '🎨', 'plain'])}`);
    layer.opacity = pick(rng, [0, 0.25, 0.5, rng(), 1]);
    layer.blendMode = pick(rng, BLEND_MODES);
    layer.visible = rng() > 0.2;
    layer.locked = rng() < 0.2;
    layer.clipped = rng() < 0.3;
    layer.maskEnabled = rng() < 0.8;
    layer.transform = {
      x: ri(rng, 21) - 10, y: ri(rng, 21) - 10,
      scaleX: 0.5 + rng() * 1.5, scaleY: 0.5 + rng() * 1.5,
      rotationDeg: ri(rng, 361) - 180,
    };
    if (layer.type === 'raster' && layer.pixels) {
      for (let j = 0; j < layer.pixels.data.length; j++) layer.pixels.data[j] = rbyte(rng);
    }
    if (rng() < 0.5) layer.mask = randomMaskBuffer(rng, w, h);
    if (layer.type === 'text' && layer.text) {
      layer.text.text = pick(rng, ['Hello', 'Héllo 🎨 ünïcode', '', 'line1\nline2\ttab']);
      layer.text.fontSize = 8 + ri(rng, 64);
      layer.text.fontWeight = pick(rng, [100, 400, 700, 900]);
    }
    if (layer.type === 'shape' && layer.shape) {
      layer.shape.kind = pick(rng, ['rectangle', 'rounded-rectangle', 'ellipse', 'polygon', 'line'] as const);
      layer.shape.w = 1 + ri(rng, w); layer.shape.h = 1 + ri(rng, h);
      layer.shape.cornerRadius = ri(rng, 20); layer.shape.sides = 3 + ri(rng, 8);
      layer.shape.fill = rng() < 0.8 ? randomRGBA(rng) : null;
      layer.shape.stroke = rng() < 0.4 ? randomRGBA(rng) : null;
      layer.shape.strokeWidth = ri(rng, 6);
    }
    if (layer.type === 'adjustment') {
      layer.adjustment = { kind: pick(rng, ADJ_KINDS), params: { p1: rng() * 100 - 50, gamma: 0.5 + rng() * 2 } };
    }
    if (layer.type === 'fill') layer.fillColor = randomRGBA(rng);
    if (layer.type !== 'group' && rng() < 0.3) {
      layer.gradient = {
        kind: pick(rng, ['linear', 'radial'] as const), angleDeg: ri(rng, 360),
        stops: [
          { offset: 0, color: randomRGBA(rng) },
          { offset: 0.5, color: randomRGBA(rng) },
          { offset: 1, color: randomRGBA(rng) },
        ],
        reverse: rng() < 0.5,
      };
    }
    // Parent must already exist (groups created earlier) -> acyclic by construction.
    const parent = groups.length > 0 && rng() < 0.4 ? pick(rng, groups) : null;
    addLayerToDoc(doc, layer, parent ? parent.id : null);
    if (layer.type === 'group') groups.push(layer);
  }
  const guideCount = ri(rng, 4);
  for (let i = 0; i < guideCount; i++) {
    doc.guides.push({ orientation: rng() < 0.5 ? 'h' : 'v', position: ri(rng, Math.max(w, h)) });
  }
  doc.grid = { visible: rng() < 0.5, spacing: pick(rng, [8, 16, 32]), snap: rng() < 0.5 };
  const ids = Object.keys(doc.layers);
  doc.activeLayerId = rng() < 0.2 ? null : pick(rng, ids);
  return doc;
}

describe('RT-1 project format — random document roundtrip', () => {
  it.each([11, 22, 33, 44])('seed %i: serialize→deserialize deep-equals structure + pixel bytes', (seed) => {
    const rng = mulberry32(seed);
    const doc = randomDocument(rng, 6 + ri(rng, 9), 5 + ri(rng, 8));
    const bytes = serializeProject(doc);
    const restored = deserializeProject(bytes);
    expect(restored).toEqual(doc);
    expect(fingerprint(restored)).toBe(fingerprint(doc));
    for (const id of Object.keys(doc.layers)) {
      const a = doc.layers[id]!, b = restored.layers[id]!;
      if (a.pixels) expect(Array.from(b.pixels!.data)).toEqual(Array.from(a.pixels.data));
      if (a.mask) expect(Array.from(b.mask!.data)).toEqual(Array.from(a.mask.data));
    }
    // Serialization is a fixed point: re-serializing the restored doc is byte-identical.
    expect(bytesEqual(serializeProject(restored), bytes)).toBe(true);
  });

  it('serialization is deterministic and does not mutate the document', () => {
    const doc = randomDocument(mulberry32(99), 10, 8);
    const before = fingerprint(doc);
    const b1 = serializeProject(doc);
    const b2 = serializeProject(doc);
    expect(bytesEqual(b1, b2)).toBe(true);
    expect(fingerprint(doc)).toBe(before);
  });

  it('deserialized pixel data is an independent copy (no aliasing of the source bytes)', () => {
    const doc = randomDocument(mulberry32(7), 8, 8);
    const bytes = serializeProject(doc);
    const pristine = deserializeProject(bytes);
    const victim = deserializeProject(bytes);
    const raster = Object.values(victim.layers).find(l => l.pixels)!;
    raster.pixels!.data[0] = (raster.pixels!.data[0]! + 1) % 256;
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff; // corrupt stored bytes afterwards
    const again = deserializeProject(serializeProject(doc));
    expect(fingerprint(again)).toBe(fingerprint(pristine));
  });

  it('base64 helpers roundtrip a random document and reject invalid base64', () => {
    const doc = randomDocument(mulberry32(5), 9, 7);
    expect(fingerprint(deserializeProjectFromBase64(serializeProjectToBase64(doc)))).toBe(fingerprint(doc));
    expect(() => deserializeProjectFromBase64('!!! not base64 !!!')).toThrowError(ProjectError);
  });

  it('deserializes correctly from a Uint8Array view at a non-zero byte offset', () => {
    const doc = randomDocument(mulberry32(3), 8, 6);
    const bytes = serializeProject(doc);
    const big = new Uint8Array(bytes.length + 26);
    big.set(bytes, 13);
    const view = big.subarray(13, 13 + bytes.length);
    expect(fingerprint(deserializeProject(view))).toBe(fingerprint(doc));
  });
});

// ---------------------------------------------------------------------------
// RT-1b — Project format: corruption must throw, never silently corrupt
// ---------------------------------------------------------------------------

function makeProjectBytes(): Uint8Array {
  const doc = createDocument(12, 10, 'Battery');
  const h = new History();
  const l = createLayer('raster', 12, 10, 'Paint');
  h.execute(C.addLayerCommand(l), doc);
  h.execute(C.pixelCommand('fill', l.id, (ly) => {
    for (let i = 0; i < ly.pixels!.data.length; i++) ly.pixels!.data[i] = (i * 31) % 256;
  }), doc);
  return serializeProject(doc);
}

/** Rebuild a project file with a mutated manifest (binary section untouched,
 *  so the binary checksum stays valid — exactly what a header attack looks like). */
function rebuildWithManifest(bytes: Uint8Array, mutate: (m: any) => void): Uint8Array {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)));
  mutate(manifest);
  const header = new TextEncoder().encode(JSON.stringify(manifest));
  const binary = bytes.subarray(8 + headerLen);
  const out = new Uint8Array(8 + header.length + binary.length);
  out.set(bytes.subarray(0, 4), 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(binary, 8 + header.length);
  return out;
}

describe('RT-1b project format — corruption battery', () => {
  it('rejects empty and short inputs', () => {
    expect(() => deserializeProject(new Uint8Array(0))).toThrowError(ProjectError);
    expect(() => deserializeProject(new Uint8Array([0x57, 0x50, 0x53]))).toThrowError(ProjectError);
    expect(() => deserializeProject(new Uint8Array(7))).toThrowError(ProjectError);
  });

  it('rejects truncation at every structural boundary', () => {
    const bytes = makeProjectBytes();
    const headerLen = new DataView(bytes.buffer).getUint32(4, true);
    const cuts = [0, 1, 3, 7, 8, 9, 8 + headerLen - 1, 8 + headerLen, bytes.length - 1, Math.floor(bytes.length / 2)];
    for (const cut of cuts) {
      expect(() => deserializeProject(bytes.subarray(0, cut)), `cut at ${cut}`).toThrowError(ProjectError);
    }
  });

  it('rejects a bit-flip in the magic, the header JSON structure, and the binary section', () => {
    const bytes = makeProjectBytes();
    const flip = (at: number, xor = 0xff) => {
      const bad = new Uint8Array(bytes); bad[at] = bad[at]! ^ xor; return bad;
    };
    expect(() => deserializeProject(flip(0))).toThrowError(ProjectError); // magic
    expect(() => deserializeProject(flip(8))).toThrowError(ProjectError); // '{' of JSON manifest
    expect(() => deserializeProject(flip(bytes.length - 1))).toThrowError(ProjectError); // binary -> checksum
    expect(() => deserializeProject(flip(4, 0x01))).toThrowError(ProjectError); // header length field
  });

  it('rejects seeded random garbage (plain and with a forged WPSC magic prefix)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 60; i++) {
      const len = ri(rng, 257);
      const g = new Uint8Array(len);
      for (let j = 0; j < len; j++) g[j] = rbyte(rng);
      expect(() => deserializeProject(g), `garbage sample ${i}`).toThrowError(Error);
    }
    for (let i = 0; i < 40; i++) {
      const len = 8 + ri(rng, 200);
      const g = new Uint8Array(len);
      for (let j = 0; j < len; j++) g[j] = rbyte(rng);
      g[0] = 0x57; g[1] = 0x50; g[2] = 0x53; g[3] = 0x43; // 'WPSC'
      expect(() => deserializeProject(g), `forged-magic sample ${i}`).toThrowError(Error);
    }
  });

  // CONFIRMED BUG: the FNV-1a checksum covers ONLY the binary section
  // (src/storage/project.ts:169 `checksum: fnv1a(binary)`, verified at :239).
  // A same-length edit inside the JSON manifest (e.g. flipping 'T'->'U' in the
  // document name) keeps the JSON valid and is silently accepted with wrong
  // data. Invariant (task §1): bit-flipped bytes must throw, never return a
  // corrupt doc silently. Probed: name deserializes as 'Uest Doc'.
  it('rejects a semantic bit-flip inside the JSON manifest header', () => {
    const doc = createDocument(8, 8, 'Test Doc');
    const bytes = serializeProject(doc);
    const headerLen = new DataView(bytes.buffer).getUint32(4, true);
    const headerStr = new TextDecoder().decode(bytes.subarray(8, 8 + headerLen));
    const at = 8 + headerStr.indexOf('Test Doc');
    const bad = new Uint8Array(bytes);
    bad[at] = 'U'.charCodeAt(0);
    expect(() => deserializeProject(bad)).toThrowError(Error);
  });

  // CONFIRMED BUG: deserializeProject validates only that layer id/name/type
  // are strings (src/storage/project.ts:259-260). It never validates the layer
  // graph, so a group whose childIds contain itself is accepted; that doc
  // later sends flattenTree/flattenRenderOrder into infinite recursion.
  it('rejects a manifest containing a cyclic group', () => {
    const bytes = rebuildWithManifest(makeProjectBytes(), (m) => {
      m.layers.push({ ...m.layers[0], id: 'grp', type: 'group', childIds: ['grp'] });
      m.doc.rootIds = ['grp'];
    });
    expect(() => deserializeProject(bytes)).toThrowError(Error);
  });

  // CONFIRMED BUG: duplicate layer ids are accepted and silently collapse in
  // the layers record (src/storage/project.ts:258-259 builds a Record keyed by
  // id with no duplicate check): a 2-layer manifest loads as a 1-layer doc.
  it('rejects a manifest with duplicate layer ids instead of silently dropping a layer', () => {
    const bytes = rebuildWithManifest(makeProjectBytes(), (m) => {
      m.layers.push({ ...m.layers[0] });
    });
    expect(() => deserializeProject(bytes)).toThrowError(Error);
  });

  // CONFIRMED BUG: rootIds / activeLayerId referencing non-existent layers are
  // accepted verbatim (no referential validation in deserializeProject,
  // src/storage/project.ts:258-330), returning a structurally corrupt doc.
  it('rejects dangling rootIds / activeLayerId references', () => {
    const bytes = rebuildWithManifest(makeProjectBytes(), (m) => {
      m.doc.rootIds = ['no-such-layer'];
      m.doc.activeLayerId = 'ghost';
    });
    expect(() => deserializeProject(bytes)).toThrowError(Error);
  });

  // CONFIRMED BUG: layer enum/range fields are never validated on load — a
  // manifest with blendMode 'not-a-mode' and opacity 42 loads as-is
  // (src/storage/project.ts:259-260 checks only id/name/type string types).
  it('rejects invalid blendMode / out-of-range opacity in a manifest', () => {
    const bytes = rebuildWithManifest(makeProjectBytes(), (m) => {
      m.layers[0].blendMode = 'not-a-mode';
      m.layers[0].opacity = 42;
    });
    expect(() => deserializeProject(bytes)).toThrowError(Error);
  });
});

// ---------------------------------------------------------------------------
// RT-2 — History: random command sequences must invert exactly
// ---------------------------------------------------------------------------

const HISTORY_BRUSH = { size: 6, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0 };
const HISTORY_TYPES = ['raster', 'group', 'text', 'shape', 'fill', 'adjustment'] as const;

describe('RT-2 history — random command sequences', () => {
  it.each([1, 2, 3, 4, 5])('seed %i: undo-all restores the EXACT initial doc, redo-all restores the final doc', (seed) => {
    const rng = mulberry32(seed);
    const doc = createDocument(16, 16, 'Fuzz');
    const h = new History();
    const initialFp = fingerprint(doc);
    const initialBytes = serializeProject(doc);
    for (let step = 0; step < 40; step++) {
      const live = flattenTree(doc).map(x => x.layer);
      const op = ri(rng, 6);
      if (op === 0 || live.length === 0) {
        h.execute(C.addLayerCommand(createLayer(pick(rng, HISTORY_TYPES), 16, 16, `S${seed}-${step}`)), doc);
      } else if (op === 1) {
        h.execute(C.removeLayerCommand(pick(rng, live).id), doc);
      } else if (op === 2) {
        h.execute(C.renameLayerCommand(pick(rng, live).id, `R${ri(rng, 1000)}`), doc);
      } else if (op === 3) {
        h.execute(C.setOpacityCommand(pick(rng, live).id, ri(rng, 21) / 20), doc);
      } else if (op === 4) {
        const t = pick(rng, live);
        h.execute(C.setLayerPropsCommand(t.id, { blendMode: pick(rng, BLEND_MODES), visible: rng() > 0.3 }), doc);
      } else {
        const rasters = live.filter(l => l.type === 'raster' && l.pixels);
        if (rasters.length === 0) continue;
        const t = pick(rng, rasters);
        h.execute(C.pixelCommand('stroke', t.id, (ly) =>
          paintStroke(ly.pixels!, [{ x: ri(rng, 16), y: ri(rng, 16) }], HISTORY_BRUSH,
            { r: rbyte(rng), g: rbyte(rng), b: rbyte(rng), a: 255 }, 'paint')), doc);
      }
    }
    const finalFp = fingerprint(doc);
    const finalBytes = serializeProject(doc);
    let undos = 0; while (h.undo(doc)) undos++;
    expect(undos).toBeGreaterThan(0);
    expect(fingerprint(doc)).toBe(initialFp);
    expect(bytesEqual(serializeProject(doc), initialBytes)).toBe(true);
    expect(h.canUndo()).toBe(false);
    let redos = 0; while (h.redo(doc)) redos++;
    expect(redos).toBe(undos);
    expect(fingerprint(doc)).toBe(finalFp);
    expect(bytesEqual(serializeProject(doc), finalBytes)).toBe(true);
    expect(h.canRedo()).toBe(false);
  });

  it('undo-then-new-edit discards the redo branch (pixel-level)', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const l = createLayer('raster', 16, 16, 'P');
    h.execute(C.addLayerCommand(l), doc);
    h.execute(C.pixelCommand('red', l.id, (ly) =>
      paintStroke(ly.pixels!, [{ x: 4, y: 4 }], HISTORY_BRUSH, { r: 255, g: 0, b: 0, a: 255 }, 'paint')), doc);
    h.undo(doc);
    h.execute(C.pixelCommand('blue', l.id, (ly) =>
      paintStroke(ly.pixels!, [{ x: 12, y: 12 }], HISTORY_BRUSH, { r: 0, g: 0, b: 255, a: 255 }, 'paint')), doc);
    expect(h.canRedo()).toBe(false);
    expect(h.redo(doc)).toBe(false);
  });

  // CONFIRMED BUG (facet of the removeLayerCommand active-layer bug below):
  // deleting a group whose subtree contains the ACTIVE layer leaves
  // activeLayerId dangling (removeLayerFromDoc only resets it when the
  // deleted id itself was active, src/core/document.ts:85), and undo then
  // forces activeLayerId to the group's id (src/core/commands.ts:61-66)
  // instead of the previously active leaf. Probed diff: every field of the
  // restored doc matches except active (expected leaf id, got group id).
  it('removing a group subtree: undo/redo/undo restores the exact fingerprint each time', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const g = createLayer('group', 16, 16, 'G');
    const sg = createLayer('group', 16, 16, 'SG');
    const leaf = createLayer('raster', 16, 16, 'leaf');
    h.execute(C.addLayerCommand(g), doc);
    h.execute(C.addLayerCommand(sg, g.id), doc);
    h.execute(C.addLayerCommand(leaf, sg.id), doc);
    const before = fingerprint(doc);
    h.execute(C.removeLayerCommand(g.id), doc);
    expect(doc.layers[leaf.id]).toBeUndefined();
    h.undo(doc);
    expect(fingerprint(doc)).toBe(before);
    h.redo(doc);
    expect(doc.layers[g.id]).toBeUndefined();
    expect(doc.layers[leaf.id]).toBeUndefined();
    h.undo(doc);
    expect(fingerprint(doc)).toBe(before);
  });

  it('rename chain A→B→C undoes and redoes through every intermediate name', () => {
    const doc = createDocument(8, 8);
    const h = new History();
    const l = createLayer('raster', 8, 8, 'A');
    h.execute(C.addLayerCommand(l), doc);
    h.execute(C.renameLayerCommand(l.id, 'B'), doc);
    h.execute(C.renameLayerCommand(l.id, 'C'), doc);
    h.undo(doc); expect(doc.layers[l.id]!.name).toBe('B');
    h.undo(doc); expect(doc.layers[l.id]!.name).toBe('A');
    h.redo(doc); expect(doc.layers[l.id]!.name).toBe('B');
    h.redo(doc); expect(doc.layers[l.id]!.name).toBe('C');
    h.undo(doc); expect(doc.layers[l.id]!.name).toBe('B');
  });

  // CONFIRMED BUG: moveLayerToGroupCommand redo is a no-op that reverts the
  // move. Its inner documentCommand snapshot is taken BEFORE the move is
  // applied (apply is `() => {}`), so the captured 'after' snapshot equals the
  // pre-move state (src/core/commands.ts:138-158). Probed: after execute the
  // layer is in the group; after undo it is back at root (correct); after
  // redo it is STILL at root with the group empty (wrong).
  it('redo of moveLayerToGroupCommand re-applies the move', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const g = createLayer('group', 16, 16, 'G');
    const l = createLayer('raster', 16, 16, 'L');
    h.execute(C.addLayerCommand(g), doc);
    h.execute(C.addLayerCommand(l), doc);
    h.execute(C.moveLayerToGroupCommand(l.id, g.id), doc);
    expect(doc.layers[l.id]!.parentId).toBe(g.id);
    h.undo(doc);
    expect(doc.layers[l.id]!.parentId).toBeNull();
    h.redo(doc);
    expect(doc.layers[l.id]!.parentId).toBe(g.id);
    expect(doc.layers[g.id]!.childIds).toContain(l.id);
  });

  // CONFIRMED BUG: removeLayerCommand.undo forces
  // `doc.activeLayerId = removed.id` (src/core/commands.ts:61-66) even when
  // the removed layer was NOT the active one, instead of restoring the
  // snapshot's activeLayerId. Probed: active B, delete A, undo -> active is A.
  it('undo of deleting a non-active layer restores the previously active layer', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const a = createLayer('raster', 16, 16, 'A');
    const b = createLayer('raster', 16, 16, 'B');
    h.execute(C.addLayerCommand(a), doc);
    h.execute(C.addLayerCommand(b), doc); // active = B
    h.execute(C.removeLayerCommand(a.id), doc);
    expect(doc.activeLayerId).toBe(b.id);
    h.undo(doc);
    expect(doc.activeLayerId).toBe(b.id);
  });

  // CONFIRMED BUG: undoing addLayerCommand delegates to removeLayerFromDoc,
  // which falls back to `doc.rootIds[0]` for the active layer
  // (src/core/document.ts:85) instead of the layer that was active before the
  // add. Probed: active = Background, add layer INTO a group, undo -> active
  // becomes the group, not Background.
  it('undo of adding a layer into a group restores the previously active layer', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const g = createLayer('group', 16, 16, 'G');
    h.execute(C.addLayerCommand(g), doc);
    const bgId = doc.rootIds[doc.rootIds.length - 1]!;
    doc.activeLayerId = bgId; // user selects Background (UI-level selection)
    const leaf = createLayer('raster', 16, 16, 'leaf');
    h.execute(C.addLayerCommand(leaf, g.id), doc);
    h.undo(doc);
    expect(doc.activeLayerId).toBe(bgId);
  });

  // CONFIRMED BUG: duplicateLayerCommand redo loses a group's children. Undo
  // deletes the cloned children from doc.layers, but on redo the re-clone
  // block is skipped because `copy.childIds.length !== 0`
  // (src/core/commands.ts:88-97), leaving childIds pointing at layers that no
  // longer exist. Probed: after redo, group exists with childIds [id] but
  // doc.layers[id] is undefined.
  it('redo of duplicating a group restores its children as real layers', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const g = createLayer('group', 16, 16, 'G');
    const leaf = createLayer('raster', 16, 16, 'leaf');
    h.execute(C.addLayerCommand(g), doc);
    h.execute(C.addLayerCommand(leaf, g.id), doc);
    h.execute(C.duplicateLayerCommand(g.id), doc);
    const dupId = doc.activeLayerId!;
    expect(doc.layers[dupId]!.childIds).toHaveLength(1);
    h.undo(doc);
    h.redo(doc);
    const dup = doc.layers[dupId]!;
    expect(dup).toBeDefined();
    expect(dup.childIds).toHaveLength(1);
    for (const cid of dup.childIds) expect(doc.layers[cid]).toBeDefined();
  });

  // CONFIRMED BUG: duplicating a group containing a subgroup clones only the
  // direct children (src/core/commands.ts:90-93); the cloned subgroup keeps
  // the ORIGINAL grandchildren ids in its childIds, whose parentId still
  // points at the original subgroup — the duplicate shares/corrupts the
  // original subtree instead of owning an independent copy.
  it('duplicating a nested group remaps grandchildren to the cloned subgroup', () => {
    const doc = createDocument(16, 16);
    const h = new History();
    const g = createLayer('group', 16, 16, 'G');
    const sg = createLayer('group', 16, 16, 'SG');
    const leaf = createLayer('raster', 16, 16, 'leaf');
    h.execute(C.addLayerCommand(g), doc);
    h.execute(C.addLayerCommand(sg, g.id), doc);
    h.execute(C.addLayerCommand(leaf, sg.id), doc);
    h.execute(C.duplicateLayerCommand(g.id), doc);
    const dupG = doc.layers[doc.activeLayerId!]!;
    const dupSg = doc.layers[dupG.childIds[0]!]!;
    expect(dupSg).toBeDefined();
    expect(dupSg.childIds).toHaveLength(1);
    expect(dupSg.childIds[0]).not.toBe(leaf.id);
    expect(doc.layers[dupSg.childIds[0]!]!.parentId).toBe(dupSg.id);
  });
});

// ---------------------------------------------------------------------------
// RT-3 — Blend modes: independent W3C reference recomputed inside the test
// (formulations deliberately written differently from src/engine/blend,
// e.g. screen as 1-(1-cb)(1-cs), to avoid mirroring an implementation bug)
// ---------------------------------------------------------------------------

function refBlendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case 'normal': return cs;
    case 'multiply': return cb * cs;
    case 'screen': return 1 - (1 - cb) * (1 - cs);
    case 'overlay': return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'darken': return Math.min(cb, cs);
    case 'lighten': return Math.max(cb, cs);
    case 'color-dodge': return cb === 0 ? 0 : cs === 1 ? 1 : Math.min(1, cb / (1 - cs));
    case 'color-burn': return cb === 1 ? 1 : cs === 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case 'hard-light': return cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case 'soft-light': {
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (d - cb);
    }
    case 'difference': return Math.abs(cb - cs);
    case 'exclusion': return cb + cs - 2 * cb * cs;
  }
}

/** Full W3C composite of one pixel, channels 0..255 in/out (float out). */
function refComposite(dstPx: number[], srcPx: number[], opacity: number, mode: BlendMode, coverage = 1): number[] {
  const as = (srcPx[3]! / 255) * opacity * coverage;
  const ab = dstPx[3]! / 255;
  const ao = as + ab * (1 - as);
  const out = [0, 0, 0, ao * 255];
  if (ao === 0) return [0, 0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const cs = srcPx[ch]! / 255, cb = dstPx[ch]! / 255;
    const co = as * (1 - ab) * cs + as * ab * refBlendChannel(mode, cb, cs) + (1 - as) * ab * cb;
    out[ch] = (co / ao) * 255;
  }
  return out;
}

describe('RT-3 blend modes — W3C reference cross-check', () => {
  it('blendChannel matches the reference for random base/blend pairs across all 12 modes', () => {
    const rng = mulberry32(1234);
    for (const mode of BLEND_MODES) {
      for (let i = 0; i < 60; i++) {
        const base = rbyte(rng), blend = rbyte(rng);
        const expected = Math.min(1, Math.max(0, refBlendChannel(mode, base / 255, blend / 255))) * 255;
        expect(Math.abs(blendChannel(mode, base, blend) - expected), `${mode}(${base},${blend})`).toBeLessThanOrEqual(1);
      }
      // Boundary lattice: 0 / 1 / 127 / 128 / 254 / 255 in both positions.
      for (const v of [0, 1, 127, 128, 254, 255]) {
        for (const w of [0, 1, 127, 128, 254, 255]) {
          const expected = Math.min(1, Math.max(0, refBlendChannel(mode, v / 255, w / 255))) * 255;
          expect(Math.abs(blendChannel(mode, v, w) - expected), `${mode}(${v},${w})`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('compositeBuffers matches the reference for 300 random base/blend/alpha/opacity/mode cases', () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 300; trial++) {
      const mode = pick(rng, BLEND_MODES);
      const dstPx = [rbyte(rng), rbyte(rng), rbyte(rng), rbyte(rng)];
      const srcPx = [rbyte(rng), rbyte(rng), rbyte(rng), rbyte(rng)];
      const opacity = ri(rng, 21) / 20;
      const dst: PixelBuffer = { width: 1, height: 1, data: new Uint8ClampedArray(dstPx) };
      const src: PixelBuffer = { width: 1, height: 1, data: new Uint8ClampedArray(srcPx) };
      compositeBuffers(dst, src, opacity, mode);
      const expected = refComposite(dstPx, srcPx, opacity, mode);
      for (let ch = 0; ch < 4; ch++) {
        expect(Math.abs(dst.data[ch]! - expected[ch]!), `trial ${trial} ${mode} ch${ch}`).toBeLessThanOrEqual(1);
      }
      // Source buffer is a read-only input: compositing must not mutate it.
      expect(Array.from(src.data)).toEqual(srcPx);
    }
  });

  it('compositeBuffers with a random mask matches the reference coverage math (multi-pixel)', () => {
    const rng = mulberry32(77);
    const w = 5, h = 4;
    const dst = randomPixelBuffer(rng, w, h);
    const src = randomPixelBuffer(rng, w, h);
    const mask = randomMaskBuffer(rng, w, h);
    const dstCopy = { width: w, height: h, data: new Uint8ClampedArray(dst.data) };
    const mode = pick(rng, BLEND_MODES);
    const opacity = 0.35 + rng() * 0.65;
    compositeBuffers(dst, src, opacity, mode, mask);
    for (let p = 0; p < w * h; p++) {
      const dstPx = Array.from(dstCopy.data.subarray(p * 4, p * 4 + 4));
      const srcPx = Array.from(src.data.subarray(p * 4, p * 4 + 4));
      const expected = refComposite(dstPx, srcPx, opacity, mode, mask.data[p]! / 255);
      for (let ch = 0; ch < 4; ch++) {
        expect(Math.abs(dst.data[p * 4 + ch]! - expected[ch]!), `pixel ${p} ch${ch}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('opacity 0 and source-alpha 0 are exact no-ops for random buffers and every mode', () => {
    const rng = mulberry32(8);
    for (const mode of BLEND_MODES) {
      const dst = randomPixelBuffer(rng, 4, 3);
      const before = Array.from(dst.data);
      const opaqueSrc = randomPixelBuffer(rng, 4, 3);
      compositeBuffers(dst, opaqueSrc, 0, mode);
      expect(Array.from(dst.data)).toEqual(before);
      const clearSrc = randomPixelBuffer(rng, 4, 3);
      for (let i = 3; i < clearSrc.data.length; i += 4) clearSrc.data[i] = 0;
      compositeBuffers(dst, clearSrc, 1, mode);
      expect(Array.from(dst.data)).toEqual(before);
    }
  });

  // CONFIRMED BUG: when the mask is smaller than the buffers, pixels outside
  // the mask's bounds composite at FULL coverage — the `coverage = 1` default
  // at src/engine/blend/blend.ts:102-105 only samples the mask when
  // `x < mask.width && y < mask.height`. Probed: a 1x1 mask of 0 over a 2x2
  // red-over-blue composite leaves only pixel (0,0) unpainted; the other
  // three pixels turn fully red, i.e. the mask fails to mask 3/4 of the layer.
  it('a mask smaller than the layer still masks pixels outside its bounds', () => {
    const dst: PixelBuffer = { width: 2, height: 2, data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]) };
    const src: PixelBuffer = { width: 2, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]) };
    const mask: MaskBuffer = { width: 1, height: 1, data: new Uint8Array([0]) };
    compositeBuffers(dst, src, 1, 'normal', mask);
    expect(Array.from(dst.data)).toEqual([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  });
});

// ---------------------------------------------------------------------------
// RT-4 — Selection algebra: exact laws on random masks
// ---------------------------------------------------------------------------

function randomSelection(rng: Rng, w: number, h: number, kind: 'fuzzy' | 'binary' | 'sparse'): Selection {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (kind === 'fuzzy') mask[i] = rbyte(rng);
    else if (kind === 'binary') mask[i] = rng() < 0.4 ? 255 : 0;
    else mask[i] = rng() < 0.08 ? rbyte(rng) : 0;
  }
  return { width: w, height: h, mask };
}
const sumBytes = (m: Uint8Array): number => { let s = 0; for (const v of m) s += v; return s; };
const masksEqual = (a: Selection, b: Selection): boolean =>
  a.width === b.width && a.height === b.height && a.mask.every((v, i) => v === b.mask[i]);

describe('RT-4 selection algebra', () => {
  it.each([101, 202, 303])('seed %i: De Morgan, involution, idempotence, commutativity hold exactly on fuzzy masks', (seed) => {
    const rng = mulberry32(seed);
    const a = randomSelection(rng, 18, 14, 'fuzzy');
    const b = randomSelection(rng, 18, 14, 'fuzzy');
    const notA = invertSelection(a), notB = invertSelection(b);
    // Involution: invert ∘ invert = identity
    expect(masksEqual(invertSelection(notA), a)).toBe(true);
    // De Morgan (both directions), exact integer equality
    expect(masksEqual(invertSelection(combineSelections(a, b, 'union')), combineSelections(notA, notB, 'intersect'))).toBe(true);
    expect(masksEqual(invertSelection(combineSelections(a, b, 'intersect')), combineSelections(notA, notB, 'union'))).toBe(true);
    // Idempotence + commutativity
    expect(masksEqual(combineSelections(a, a, 'union'), a)).toBe(true);
    expect(masksEqual(combineSelections(a, a, 'intersect'), a)).toBe(true);
    expect(masksEqual(combineSelections(a, b, 'union'), combineSelections(b, a, 'union'))).toBe(true);
    expect(masksEqual(combineSelections(a, b, 'intersect'), combineSelections(b, a, 'intersect'))).toBe(true);
    // Byte-sum law: max + min = a + b pointwise, hence in total
    expect(sumBytes(combineSelections(a, b, 'union').mask) + sumBytes(combineSelections(a, b, 'intersect').mask))
      .toBe(sumBytes(a.mask) + sumBytes(b.mask));
    // Subtract laws
    expect(sumBytes(combineSelections(a, a, 'subtract').mask)).toBe(0);
    expect(masksEqual(combineSelections(a, invertSelection(selectAll(18, 14)), 'subtract'), a)).toBe(true);
    // 'add' is specified as an alias of union
    expect(masksEqual(combineSelections(a, b, 'add'), combineSelections(a, b, 'union'))).toBe(true);
    // No operation mutates its inputs
    const aCopy = new Uint8Array(a.mask), bCopy = new Uint8Array(b.mask);
    combineSelections(a, b, 'union'); invertSelection(a); featherSelection(a, 1);
    growSelection(a, 1); shrinkSelection(a, 1);
    expect(a.mask).toEqual(aCopy);
    expect(b.mask).toEqual(bCopy);
  });

  it('grow/shrink: radius 0 is identity, opening never exceeds the original, counts are monotone', () => {
    const rng = mulberry32(3);
    const sel = randomSelection(rng, 24, 24, 'binary');
    expect(masksEqual(growSelection(sel, 0), sel)).toBe(true);
    expect(masksEqual(shrinkSelection(sel, 0), sel)).toBe(true);
    const opening = growSelection(shrinkSelection(sel, 1), 1);
    for (let i = 0; i < sel.mask.length; i++) expect(opening.mask[i]!).toBeLessThanOrEqual(sel.mask[i]!);
    // Closing is extensive away from the canvas border (border pixels erode
    // against out-of-canvas 0 by design, so the law is checked on the interior).
    const closing = shrinkSelection(growSelection(sel, 1), 1);
    for (let y = 1; y < 23; y++) for (let x = 1; x < 23; x++) {
      expect(closing.mask[y * 24 + x]!).toBeGreaterThanOrEqual(sel.mask[y * 24 + x]!);
    }
    expect(countSelected(growSelection(sel, 1))).toBeGreaterThanOrEqual(countSelected(sel));
    expect(countSelected(shrinkSelection(sel, 1))).toBeLessThanOrEqual(countSelected(sel));
  });

  it('feather: radius 0 is an exact copy, total coverage is (near-)preserved, spread is bounded by 3r', () => {
    const s = rectSelection(40, 40, 15, 15, 10, 10);
    expect(masksEqual(featherSelection(s, 0), s)).toBe(true);
    for (const r of [1, 2, 3]) {
      const f = featherSelection(s, r);
      // Total coverage must not grow beyond a small tolerance (probed drift < 0.1%).
      expect(Math.abs(countSelected(f) - countSelected(s))).toBeLessThanOrEqual(Math.max(1.5, 0.05 * countSelected(s)));
      // Support grows by at most 3r (three box passes of radius r — see bug below).
      let maxDist = 0;
      for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
        if (f.mask[y * 40 + x]! > 0) {
          const dx = x < 15 ? 15 - x : x > 24 ? x - 24 : 0;
          const dy = y < 15 ? 15 - y : y > 24 ? y - 24 : 0;
          maxDist = Math.max(maxDist, Math.max(dx, dy));
        }
      }
      expect(maxDist).toBeGreaterThanOrEqual(r);
      expect(maxDist).toBeLessThanOrEqual(3 * r);
      const b = selectionBounds(f)!;
      expect(b.x).toBeGreaterThanOrEqual(15 - 3 * r);
      expect(b.x + b.w).toBeLessThanOrEqual(25 + 3 * r);
    }
    // Feather at the canvas edge / full-canvas selection keeps total coverage.
    const edge = rectSelection(20, 20, 0, 0, 10, 20);
    expect(Math.abs(countSelected(featherSelection(edge, 2)) - countSelected(edge))).toBeLessThanOrEqual(2);
    const full = selectAll(10, 10);
    expect(countSelected(featherSelection(full, 2))).toBeCloseTo(100, 5);
  });

  // CONFIRMED BUG: featherSelection applies THREE box-blur passes of radius r
  // in each direction (src/engine/selection/selection.ts:82-92), so coverage
  // appears up to 3r px outside the original bounds — triple the documented
  // radius. Probed: r=1 -> spread 3, r=2 -> spread 6, r=3 -> spread 9.
  // Invariant (task §4): no coverage far outside original bounds + radius.
  it('feather creates no coverage beyond the original bounds + radius', () => {
    const s = rectSelection(40, 40, 15, 15, 10, 10);
    const f = featherSelection(s, 2);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      if (f.mask[y * 40 + x]! > 0) {
        const dx = x < 15 ? 15 - x : x > 24 ? x - 24 : 0;
        const dy = y < 15 ? 15 - y : y > 24 ? y - 24 : 0;
        expect(Math.max(dx, dy)).toBeLessThanOrEqual(2);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// RT-5 — Resource limits (prompt §113): violations throw, never silently pass
// ---------------------------------------------------------------------------

describe('RT-5 limits', () => {
  it('createDocument rejects dimensions beyond LIMITS and non-positive sizes, accepts the boundary', () => {
    expect(() => createDocument(LIMITS.maxDimension + 1, 1)).toThrowError(Error);
    expect(() => createDocument(1, LIMITS.maxDimension + 1)).toThrowError(Error);
    expect(() => createDocument(0, 10)).toThrowError(Error);
    expect(() => createDocument(10, 0)).toThrowError(Error);
    expect(() => createDocument(-5, 10)).toThrowError(Error);
    expect(() => createDocument(10, -5)).toThrowError(Error);
    // Boundary itself is legal (thin strips keep allocation tiny).
    expect(createDocument(LIMITS.maxDimension, 1).width).toBe(LIMITS.maxDimension);
    expect(createDocument(1, LIMITS.maxDimension).height).toBe(LIMITS.maxDimension);
  });

  it('createPixelBuffer rejects dimensions beyond LIMITS', () => {
    expect(() => createPixelBuffer(LIMITS.maxDimension + 1, 1)).toThrowError(Error);
    expect(() => createPixelBuffer(1, LIMITS.maxDimension + 1)).toThrowError(Error);
    expect(() => createPixelBuffer(0, 4)).toThrowError(Error);
  });

  it('serializeProject throws ProjectError on a doc manipulated past the dimension limit', () => {
    const doc = createDocument(8, 8);
    doc.width = LIMITS.maxDimension + 1;
    expect(() => serializeProject(doc)).toThrowError(ProjectError);
    const doc2 = createDocument(8, 8);
    doc2.height = -3;
    expect(() => serializeProject(doc2)).toThrowError(ProjectError);
  });

  it('serializeProject throws ProjectError when the layer record is stuffed past maxLayers', () => {
    const doc = createDocument(4, 4);
    const template = doc.layers[doc.rootIds[0]!]!;
    for (let i = 0; i < LIMITS.maxLayers + 1; i++) {
      doc.layers[`fake-${i}`] = { ...template, id: `fake-${i}` };
    }
    expect(Object.keys(doc.layers).length).toBeGreaterThan(LIMITS.maxLayers);
    expect(() => serializeProject(doc)).toThrowError(ProjectError);
  });

  it('deserializeProject rejects manifests past the dimension / layer / integer limits', () => {
    const bytes = makeProjectBytes();
    const tooWide = rebuildWithManifest(bytes, (m) => { m.doc.width = LIMITS.maxDimension + 1; });
    expect(() => deserializeProject(tooWide)).toThrowError(ProjectError);
    const fractional = rebuildWithManifest(bytes, (m) => { m.doc.width = 10.5; });
    expect(() => deserializeProject(fractional)).toThrowError(ProjectError);
    const tooMany = rebuildWithManifest(bytes, (m) => {
      for (let i = 0; i < LIMITS.maxLayers + 1; i++) m.layers.push({ ...m.layers[0], id: `x-${i}` });
    });
    expect(() => deserializeProject(tooMany)).toThrowError(ProjectError);
  });

  // CONFIRMED BUG: createDocument / createPixelBuffer check only
  // `w <= 0 || w > max` (src/core/document.ts:9-11 and :49-51) — no integer or
  // finiteness validation, unlike project.ts validateDimensions and
  // raster.ts assertDimension which both require Number.isInteger. Probed:
  // createDocument(10.5, 10) succeeds with width 10.5; the resulting document
  // can never be serialized (serializeProject then throws).
  it('createDocument rejects a non-integer dimension', () => {
    expect(() => createDocument(10.5, 10)).toThrowError(Error);
    expect(() => createPixelBuffer(10.5, 10)).toThrowError(Error);
  });

  // CONFIRMED BUG: same missing validation — NaN comparisons are all false,
  // so NaN slips through both checks and produces a document with width NaN
  // and a 0-length background pixel buffer (src/core/document.ts:49-51).
  // Probed: createDocument(NaN, 10) => OK, width=NaN, bgPixels length 0.
  it('createDocument rejects NaN dimensions', () => {
    expect(() => createDocument(NaN, 10)).toThrowError(Error);
    expect(() => createDocument(10, NaN)).toThrowError(Error);
  });
});

// ---------------------------------------------------------------------------
// RT-6 — Transforms: algebra roundtrips and exact buffer cases
// ---------------------------------------------------------------------------

function randomAffine(rng: Rng): Mat {
  const t = matTranslate(rng() * 40 - 20, rng() * 40 - 20);
  const r = matRotate(rng() * 360 - 180);
  const s = matScale(0.4 + rng() * 2.1, 0.4 + rng() * 2.1);
  const shear: Mat = [1, 0, rng() * 0.8 - 0.4, 1, 0, 0];
  return matMultiply(t, matMultiply(r, matMultiply(s, shear)));
}

describe('RT-6 transforms', () => {
  it.each([21, 22, 23])('seed %i: random affine apply→invert→apply is the identity on random points', (seed) => {
    const rng = mulberry32(seed);
    for (let trial = 0; trial < 25; trial++) {
      const m = randomAffine(rng);
      const inv = matInvert(m);
      expect(inv, `trial ${trial} should be invertible`).not.toBeNull();
      const product = matMultiply(m, inv!);
      const identity = matIdentity();
      for (let i = 0; i < 6; i++) expect(Math.abs(product[i]! - identity[i]!)).toBeLessThan(1e-9);
      for (let p = 0; p < 20; p++) {
        const x = rng() * 1000 - 500, y = rng() * 1000 - 500;
        const fwd = matApply(m, x, y);
        const back = matApply(inv!, fwd.x, fwd.y);
        expect(Math.abs(back.x - x)).toBeLessThan(1e-6);
        expect(Math.abs(back.y - y)).toBeLessThan(1e-6);
      }
    }
  });

  it('singular matrices invert to null (no NaN/Infinity matrix leaks)', () => {
    expect(matInvert(matScale(0, 1))).toBeNull();
    expect(matInvert(matScale(1, 0))).toBeNull();
    expect(matInvert([2, 4, 1, 2, 5, 5])).toBeNull(); // det = 0
    expect(matInvert([0, 0, 0, 0, 0, 0])).toBeNull();
    expect(matInvert([1, 2, 2, 4, 0, 0])).toBeNull(); // rank 1
  });

  it('transformBuffer with the identity matrix is a pixel-identical copy (nearest + bilinear), input unmutated', () => {
    const rng = mulberry32(31);
    for (const [w, h] of [[1, 1], [7, 5], [16, 16], [3, 11]] as const) {
      const src = randomPixelBuffer(rng, w, h);
      const snapshot = Array.from(src.data);
      for (const interp of ['nearest', 'bilinear'] as const) {
        const out = transformBuffer(src, matIdentity(), w, h, interp);
        expect(Array.from(out.data), `${w}x${h} ${interp}`).toEqual(snapshot);
        expect(out.data).not.toBe(src.data);
      }
      expect(Array.from(src.data)).toEqual(snapshot);
    }
  });

  it('integer translation shifts pixels exactly; flip matrices agree with flipBuffer', () => {
    const rng = mulberry32(9);
    const w = 7, h = 5;
    const src = randomPixelBuffer(rng, w, h);
    const shifted = transformBuffer(src, matTranslate(2, 1), w + 2, h + 1, 'nearest');
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = ((y + 1) * (w + 2) + (x + 2)) * 4;
      for (let c = 0; c < 4; c++) expect(shifted.data[di + c]).toBe(src.data[si + c]);
    }
    expect(Array.from(transformBuffer(src, matMultiply(matTranslate(w - 1, 0), matScale(-1, 1)), w, h, 'nearest').data))
      .toEqual(Array.from(flipBuffer(src, 'h').data));
    expect(Array.from(transformBuffer(src, matMultiply(matTranslate(w - 1, h - 1), matScale(-1, -1)), w, h, 'nearest').data))
      .toEqual(Array.from(flipBuffer(flipBuffer(src, 'h'), 'v').data));
    // Singular matrix -> transparent buffer, never garbage/NaN pixels.
    const dead = transformBuffer(src, matScale(0), w, h, 'nearest');
    expect(dead.data.every(v => v === 0)).toBe(true);
  });

  it('transformedBounds always contains every transformed corner', () => {
    const rng = mulberry32(55);
    for (let trial = 0; trial < 50; trial++) {
      const m = randomAffine(rng);
      const w = 1 + ri(rng, 60), h = 1 + ri(rng, 60);
      const b = transformedBounds(w, h, m);
      const corners = [matApply(m, 0, 0), matApply(m, w, 0), matApply(m, 0, h), matApply(m, w, h)];
      for (const p of corners) {
        expect(p.x).toBeGreaterThanOrEqual(b.x - 1e-9);
        expect(p.x).toBeLessThanOrEqual(b.x + b.w + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(b.y - 1e-9);
        expect(p.y).toBeLessThanOrEqual(b.y + b.h + 1e-9);
      }
      expect(b.w).toBeGreaterThanOrEqual(0);
      expect(b.h).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// RT-7 — Determinism + input non-mutation for filters / adjustments
// ---------------------------------------------------------------------------

const POINTWISE_FILTERS: [string, (b: PixelBuffer) => PixelBuffer][] = [
  ['sharpen', (b) => sharpen(b, 0.7)],
  ['brightnessContrast', (b) => brightnessContrast(b, 15, 25)],
  ['hueSaturation', (b) => hueSaturation(b, 40, 0.2, 0.05)],
  ['invert', (b) => invertBuffer(b)],
  ['grayscale', (b) => grayscaleBuffer(b)],
  ['threshold', (b) => thresholdBuffer(b, 128)],
  ['posterize', (b) => posterizeBuffer(b, 4)],
  ['noise', (b) => noiseBuffer(b, 30, 4242)],
  ['emboss', (b) => embossBuffer(b)],
  ['edgeDetect', (b) => edgeDetectBuffer(b)],
];
const ADJUSTMENT_CASES: [AdjustmentKind, Record<string, number>][] = [
  ['brightness-contrast', { brightness: 20, contrast: 10 }],
  ['hue-saturation', { hue: 30, saturation: 20, lightness: 5 }],
  ['levels', { inBlack: 10, inWhite: 240, gamma: 1.4, outBlack: 0, outWhite: 255 }],
  ['gamma', { gamma: 1.8 }],
  ['color-balance', { r: 10, g: -5, b: 20 }],
  ['invert', {}],
  ['grayscale', {}],
  ['posterize', { levels: 4 }],
  ['threshold', { threshold: 128 }],
];

describe('RT-7 determinism and non-mutation', () => {
  it('noise with the same seed is byte-identical across runs; a different seed differs; input unmutated', () => {
    const rng = mulberry32(64);
    const src = randomPixelBuffer(rng, 16, 16);
    const snapshot = Array.from(src.data);
    const a = noiseBuffer(src, 40, 123);
    const b = noiseBuffer(src, 40, 123);
    const c = noiseBuffer(src, 40, 124);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(a.data)).not.toEqual(Array.from(c.data));
    expect(Array.from(src.data)).toEqual(snapshot);
  });

  it('gaussian blur is deterministic, leaves a uniform buffer exactly uniform, and does not mutate its input', () => {
    const rng = mulberry32(65);
    const src = randomPixelBuffer(rng, 12, 10);
    const snapshot = Array.from(src.data);
    const a = gaussianBlur(src, 2);
    const b = gaussianBlur(src, 2);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(src.data)).toEqual(snapshot);
    const uniform: PixelBuffer = { width: 6, height: 6, data: new Uint8ClampedArray(6 * 6 * 4) };
    for (let i = 0; i < uniform.data.length; i += 4) {
      uniform.data[i] = 77; uniform.data[i + 1] = 130; uniform.data[i + 2] = 200; uniform.data[i + 3] = 255;
    }
    expect(Array.from(gaussianBlur(uniform, 3).data)).toEqual(Array.from(uniform.data));
    // radius 0 = exact copy
    expect(Array.from(gaussianBlur(src, 0).data)).toEqual(snapshot);
  });

  it('every filter is deterministic, non-mutating, and preserves alpha (pointwise set)', () => {
    const rng = mulberry32(66);
    const src = randomPixelBuffer(rng, 13, 11);
    const snapshot = Array.from(src.data);
    for (const [name, fn] of [...POINTWISE_FILTERS, ['pixelate', (b: PixelBuffer) => pixelateBuffer(b, 3)] as [string, (b: PixelBuffer) => PixelBuffer]]) {
      const a = fn(src);
      const b = fn(src);
      expect(Array.from(a.data), `${name} deterministic`).toEqual(Array.from(b.data));
      expect(Array.from(src.data), `${name} must not mutate input`).toEqual(snapshot);
      expect(a.width).toBe(src.width);
      expect(a.height).toBe(src.height);
    }
    for (const [name, fn] of POINTWISE_FILTERS) {
      const out = fn(src);
      for (let i = 3; i < src.data.length; i += 4) {
        expect(out.data[i], `${name} alpha @${i}`).toBe(src.data[i]);
      }
    }
  });

  it('every adjustment kind is deterministic, non-mutating, and preserves alpha', () => {
    const rng = mulberry32(67);
    const src = randomPixelBuffer(rng, 13, 11);
    const snapshot = Array.from(src.data);
    for (const [kind, params] of ADJUSTMENT_CASES) {
      const adj = { kind, params };
      const a = applyAdjustment(src, adj);
      const b = applyAdjustment(src, adj);
      expect(Array.from(a.data), `${kind} deterministic`).toEqual(Array.from(b.data));
      expect(Array.from(src.data), `${kind} must not mutate input`).toEqual(snapshot);
      for (let i = 3; i < src.data.length; i += 4) expect(a.data[i]).toBe(src.data[i]);
    }
  });

  it('cloneDocument produces a fully independent copy (pixels, masks, child lists, text)', () => {
    const doc = randomDocument(mulberry32(68), 8, 8);
    const before = fingerprint(doc);
    const clone = cloneDocument(doc);
    expect(fingerprint(clone)).toBe(before);
    const victim = Object.values(clone.layers).find(l => l.pixels);
    if (victim?.pixels) victim.pixels.data[0] = (victim.pixels.data[0]! + 3) % 256;
    const group = Object.values(clone.layers).find(l => l.type === 'group');
    if (group) group.childIds.push('bogus');
    clone.name = 'mutated';
    clone.rootIds.reverse();
    expect(fingerprint(doc)).toBe(before);
  });
});
