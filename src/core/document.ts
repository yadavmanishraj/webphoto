import {
  EditorDocument, Layer, LayerType, PixelBuffer, MaskBuffer, RGBA,
  identityTransform, newId, LIMITS,
} from './contracts';

export const transparent: RGBA = { r: 0, g: 0, b: 0, a: 0 };
export const white: RGBA = { r: 255, g: 255, b: 255, a: 255 };

export function createPixelBuffer(w: number, h: number, fill: RGBA = transparent): PixelBuffer {
  // Integer check is explicit: NaN fails every comparison below and 10.5
  // would pass them, producing corrupt buffers (red-team RT-5).
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > LIMITS.maxDimension || h > LIMITS.maxDimension)
    throw new Error(`Invalid buffer size ${w}x${h}`);
  const data = new Uint8ClampedArray(w * h * 4);
  if (fill.a > 0 || fill.r || fill.g || fill.b) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill.r; data[i + 1] = fill.g; data[i + 2] = fill.b; data[i + 3] = fill.a;
    }
  }
  return { width: w, height: h, data };
}
export const clonePixels = (p?: PixelBuffer): PixelBuffer | undefined =>
  p ? { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) } : undefined;
export const cloneMask = (m?: MaskBuffer): MaskBuffer | undefined =>
  m ? { width: m.width, height: m.height, data: new Uint8Array(m.data) } : undefined;

let layerCounter = 0;
export function createLayer(type: LayerType, docW: number, docH: number, name?: string): Layer {
  layerCounter++;
  const base: Layer = {
    id: newId(), name: name ?? `${type[0].toUpperCase() + type.slice(1)} ${layerCounter}`,
    type, visible: true, locked: false, opacity: 1, blendMode: 'normal',
    transform: identityTransform(), parentId: null, childIds: [],
    maskEnabled: true, clipped: false,
  };
  if (type === 'raster') base.pixels = createPixelBuffer(docW, docH);
  if (type === 'text') base.text = {
    text: 'Type here', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 48,
    fontWeight: 400, italic: false, align: 'left',
    color: { r: 17, g: 17, b: 17, a: 255 }, lineHeight: 1.2, letterSpacing: 0,
  };
  if (type === 'shape') base.shape = {
    kind: 'rectangle', w: Math.min(240, docW), h: Math.min(160, docH), cornerRadius: 0,
    sides: 5, fill: { r: 59, g: 130, b: 246, a: 255 }, stroke: null, strokeWidth: 0,
  };
  if (type === 'fill') base.fillColor = { ...white };
  if (type === 'adjustment') base.adjustment = { kind: 'brightness-contrast', params: { brightness: 0, contrast: 0 } };
  return base;
}

export function createDocument(w: number, h: number, name = 'Untitled', background: RGBA = white): EditorDocument {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > LIMITS.maxDimension || h > LIMITS.maxDimension)
    throw new Error(`Invalid document size ${w}x${h} (max ${LIMITS.maxDimension})`);
  const doc: EditorDocument = {
    id: newId(), name, width: w, height: h, resolution: 72, background,
    layers: {}, rootIds: [], activeLayerId: null, guides: [],
    grid: { visible: false, spacing: 32, snap: false }, version: 1,
  };
  const bg = createLayer('raster', w, h, 'Background');
  bg.pixels = createPixelBuffer(w, h, background);
  bg.locked = true;
  addLayerToDoc(doc, bg, null, 0); // bottom
  doc.activeLayerId = bg.id;
  return doc;
}

/** Insert layer into a parent list. index 0 = top-most. Default: top. */
export function addLayerToDoc(doc: EditorDocument, layer: Layer, parentId: ID0, index?: number): void {
  if (Object.keys(doc.layers).length >= LIMITS.maxLayers) throw new Error('Layer limit reached');
  doc.layers[layer.id] = layer;
  layer.parentId = parentId;
  const list = parentId ? doc.layers[parentId]!.childIds : doc.rootIds;
  const at = index === undefined ? 0 : Math.max(0, Math.min(index, list.length));
  list.splice(at, 0, layer.id);
}
type ID0 = string | null;

export function siblingIds(doc: EditorDocument, layer: Layer): string[] {
  return layer.parentId ? doc.layers[layer.parentId]!.childIds : doc.rootIds;
}
export function removeLayerFromDoc(doc: EditorDocument, id: string): Layer | undefined {
  const layer = doc.layers[id]; if (!layer) return undefined;
  const list = siblingIds(doc, layer);
  const i = list.indexOf(id); if (i >= 0) list.splice(i, 1);
  // Reset the active layer if it is ANYWHERE inside the removed subtree,
  // not only when it is the removed layer itself (red-team RT-2).
  const subtree = new Set<string>();
  const collectIds = (l: Layer) => { subtree.add(l.id); l.childIds.forEach(cid => { const c = doc.layers[cid]; if (c) collectIds(c); }); };
  collectIds(layer);
  const collect = (l: Layer) => { l.childIds.forEach(cid => { const c = doc.layers[cid]; if (c) collect(c); }); delete doc.layers[l.id]; };
  collect(layer);
  if (doc.activeLayerId && subtree.has(doc.activeLayerId)) doc.activeLayerId = doc.rootIds[0] ?? null;
  return layer;
}
/** Flatten render order: bottom-most first. Groups yield their children (group itself excluded). */
export function flattenRenderOrder(doc: EditorDocument): Layer[] {
  const out: Layer[] = [];
  const walk = (ids: string[]) => {
    for (let i = ids.length - 1; i >= 0; i--) { // bottom first
      const l = doc.layers[ids[i]!]; if (!l) continue;
      if (l.type === 'group') { out.push(l); walk(l.childIds); }
      else out.push(l);
    }
  };
  walk(doc.rootIds);
  return out;
}
/** UI tree order: top-most first, with depth. */
export function flattenTree(doc: EditorDocument): { layer: Layer; depth: number }[] {
  const out: { layer: Layer; depth: number }[] = [];
  const walk = (ids: string[], depth: number) => {
    for (const id of ids) { const l = doc.layers[id]; if (!l) continue; out.push({ layer: l, depth }); walk(l.childIds, depth + 1); }
  };
  walk(doc.rootIds, 0);
  return out;
}
export function cloneDocument(doc: EditorDocument): EditorDocument {
  const layers: Record<string, Layer> = {};
  for (const [id, l] of Object.entries(doc.layers)) {
    layers[id] = {
      ...l, transform: { ...l.transform }, childIds: [...l.childIds],
      pixels: clonePixels(l.pixels), mask: cloneMask(l.mask),
      text: l.text ? { ...l.text, color: { ...l.text.color } } : undefined,
      shape: l.shape ? { ...l.shape, fill: l.shape.fill ? { ...l.shape.fill } : null, stroke: l.shape.stroke ? { ...l.shape.stroke } : null } : undefined,
      gradient: l.gradient ? { ...l.gradient, stops: l.gradient.stops.map(s => ({ ...s, color: { ...s.color } })) } : undefined,
      adjustment: l.adjustment ? { kind: l.adjustment.kind, params: { ...l.adjustment.params } } : undefined,
      fillColor: l.fillColor ? { ...l.fillColor } : undefined,
    };
  }
  return {
    ...doc, layers, rootIds: [...doc.rootIds], background: { ...doc.background },
    guides: doc.guides.map(g => ({ ...g })), grid: { ...doc.grid },
  };
}
export function countLayers(doc: EditorDocument): number { return Object.keys(doc.layers).length; }
/** Deep-clone a single layer (same id; pixels/mask/sub-objects copied).
 * Commands that insert layers MUST insert a clone of their held template
 * on every do(): inserting the held object itself lets later in-place
 * mutations (e.g. moveLayerToGroup pushing into childIds) corrupt the
 * template, and a subsequent redo then resurrects the mutated object
 * (red-team RT2-1/A). */
export function cloneLayerDeep(l: Layer): Layer {
  const pseudo = {
    layers: { [l.id]: l }, rootIds: [], background: transparent,
    guides: [], grid: { visible: false, spacing: 32, snap: false },
  } as unknown as EditorDocument;
  return cloneDocument(pseudo).layers[l.id]!;
}
