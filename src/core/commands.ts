import { BlendMode, Command, EditorDocument, Layer, Transform2D } from './contracts';
import {
  addLayerToDoc, cloneDocument, cloneLayerDeep, cloneMask, clonePixels, createLayer,
  removeLayerFromDoc, siblingIds,
} from './document';

/** Generic pixel command: snapshots one layer's pixels+mask before mutation. */
export function pixelCommand(label: string, layerId: string, apply: (l: Layer) => void): Command {
  let beforeP: ReturnType<typeof clonePixels>, beforeM: ReturnType<typeof cloneMask>;
  let afterP: ReturnType<typeof clonePixels>, afterM: ReturnType<typeof cloneMask>;
  return {
    label,
    do(doc) {
      const l = doc.layers[layerId]; if (!l) return;
      if (!beforeP) { beforeP = clonePixels(l.pixels); beforeM = cloneMask(l.mask); }
      if (afterP) { l.pixels = clonePixels(afterP); l.mask = cloneMask(afterM); return; }
      apply(l);
      afterP = clonePixels(l.pixels); afterM = cloneMask(l.mask);
    },
    undo(doc) {
      const l = doc.layers[layerId]; if (!l) return;
      l.pixels = clonePixels(beforeP); l.mask = cloneMask(beforeM);
    },
  };
}

/** Restore a full-document snapshot into a live document (in place). */
export function restoreSnapshot(doc: EditorDocument, snap: EditorDocument): void {
  const c = cloneDocument(snap);
  doc.width = c.width; doc.height = c.height; doc.layers = c.layers;
  doc.rootIds = c.rootIds; doc.activeLayerId = c.activeLayerId;
  doc.guides = c.guides; doc.background = c.background; doc.name = c.name;
}

/** Whole-document snapshot command for structural size changes (crop/resize/rotate). */
export function documentCommand(label: string, apply: (d: EditorDocument) => void): Command {
  let before: EditorDocument | undefined, after: EditorDocument | undefined;
  const restore = restoreSnapshot;
  return {
    label,
    do(doc) { if (!before) before = cloneDocument(doc); if (after) { restore(doc, after); return; } apply(doc); after = cloneDocument(doc); },
    undo(doc) { if (before) restore(doc, before); },
  };
}

export function addLayerCommand(layer: Layer, parentId: string | null = null): Command {
  let index = 0;
  let prevActive: string | null | undefined;
  return {
    label: `Add ${layer.type} layer`,
    do(doc) {
      if (prevActive === undefined) prevActive = doc.activeLayerId;
      // Insert a deep clone, never the held template itself (RT2-1/A).
      addLayerToDoc(doc, cloneLayerDeep(layer), parentId, index); doc.activeLayerId = layer.id;
    },
    undo(doc) {
      const list = parentId ? (doc.layers[parentId]?.childIds ?? doc.rootIds) : doc.rootIds;
      index = list.indexOf(layer.id);
      removeLayerFromDoc(doc, layer.id);
      // Restore the layer that was active before the add (red-team RT-2).
      if (prevActive && doc.layers[prevActive]) doc.activeLayerId = prevActive;
    },
  };
}
export function removeLayerCommand(layerId: string): Command {
  let removed: Layer | undefined; let parentId: string | null = null; let index = 0; let docSnap: EditorDocument | undefined;
  return {
    label: 'Delete layer',
    do(doc) {
      const l = doc.layers[layerId]; if (!l) return;
      parentId = l.parentId; index = siblingIds(doc, l).indexOf(layerId);
      docSnap = cloneDocument(doc); removed = l;
      removeLayerFromDoc(doc, layerId);
    },
    undo(doc) {
      if (!docSnap) return;
      const snap = cloneDocument(docSnap);
      doc.layers = snap.layers; doc.rootIds = snap.rootIds;
      // Restore the pre-delete active layer exactly — never hijack it to
      // the removed layer's id (red-team RT-2).
      doc.activeLayerId = snap.activeLayerId;
      void parentId; void index; void removed;
    },
  };
}
export function duplicateLayerCommand(layerId: string): Command {
  // Deep-clone the whole subtree ONCE with fresh ids at every depth
  // (red-team RT-2: the previous version cloned only direct children,
  // shared grandchildren with the original, and lost children on redo
  // because it mutated copy.childIds during the first do()).
  let clones: Layer[] | undefined;
  let rootCopy: Layer | undefined;
  const build = (doc: EditorDocument) => {
    const src = doc.layers[layerId]; if (!src) return;
    const all: Layer[] = [];
    const mk = (l: Layer, newParent: string | null): Layer => {
      const c = cloneDocument({ ...doc, layers: { [l.id]: l } } as EditorDocument).layers[l.id]!;
      c.id = 'id-' + Math.random().toString(36).slice(2, 10) + all.length;
      c.parentId = newParent;
      if (l.id === layerId) c.name = l.name + ' copy';
      all.push(c);
      c.childIds = l.childIds.map(cid => { const child = doc.layers[cid]; return child ? mk(child, c.id).id : cid; });
      return c;
    };
    rootCopy = mk(src, src.parentId);
    clones = all;
  };
  let prevActive: string | null | undefined;
  return {
    label: 'Duplicate layer',
    do(doc) {
      const src = doc.layers[layerId]; if (!src) return;
      if (prevActive === undefined) prevActive = doc.activeLayerId;
      if (!clones || !rootCopy) build(doc);
      if (!clones || !rootCopy) return;
      // Insert deep clones of the built templates on every do() — the
      // templates must stay pristine across undo/redo (RT2-1/A).
      for (const c of clones) doc.layers[c.id] = cloneLayerDeep(c);
      const list = src.parentId ? doc.layers[src.parentId]!.childIds : doc.rootIds;
      const idx = list.indexOf(layerId);
      list.splice(idx < 0 ? 0 : idx, 0, rootCopy.id);
      doc.activeLayerId = rootCopy.id;
    },
    undo(doc) {
      if (rootCopy) removeLayerFromDoc(doc, rootCopy.id);
      // Restore the previously active layer (RT2-1/B — RT1 fixed this for
      // add/remove but duplicate and group creation were missed).
      if (prevActive && doc.layers[prevActive]) doc.activeLayerId = prevActive;
    },
  };
}
export function renameLayerCommand(layerId: string, name: string): Command {
  let prev = '';
  return {
    label: 'Rename layer',
    do(doc) { const l = doc.layers[layerId]; if (!l) return; prev = l.name; l.name = name; },
    undo(doc) { const l = doc.layers[layerId]; if (l) l.name = prev; },
  };
}
export function setLayerPropsCommand(
  layerId: string,
  props: Partial<Pick<Layer, 'opacity' | 'blendMode' | 'visible' | 'locked' | 'clipped'>>,
  label = 'Change layer',
): Command {
  let prev: Partial<Layer> | undefined;
  return {
    label,
    do(doc) {
      const l = doc.layers[layerId]; if (!l) return;
      if (!prev) prev = { opacity: l.opacity, blendMode: l.blendMode, visible: l.visible, locked: l.locked, clipped: l.clipped };
      Object.assign(l, props);
    },
    undo(doc) { const l = doc.layers[layerId]; if (l && prev) Object.assign(l, prev); },
  };
}
export function reorderLayerCommand(layerId: string, newIndex: number): Command {
  let oldIndex = 0; let parentId: string | null = null;
  const move = (doc: EditorDocument, to: number) => {
    const l = doc.layers[layerId]; if (!l) return;
    const list = siblingIds(doc, l); const from = list.indexOf(layerId);
    if (from < 0) return; list.splice(from, 1); list.splice(Math.max(0, Math.min(to, list.length)), 0, layerId);
  };
  return {
    label: 'Reorder layer',
    do(doc) { const l = doc.layers[layerId]; if (!l) return; parentId = l.parentId; oldIndex = siblingIds(doc, l).indexOf(layerId); move(doc, newIndex); void parentId; },
    undo(doc) { move(doc, oldIndex); },
  };
}
export function moveLayerToGroupCommand(layerId: string, groupId: string | null): Command {
  // Snapshot pair captured around the actual move (red-team RT-2: the
  // previous version delegated to documentCommand with a no-op apply, so
  // its "after" snapshot was the PRE-move state and redo reverted the move).
  let before: EditorDocument | undefined, after: EditorDocument | undefined;
  return {
    label: 'Move layer',
    do(doc) {
      if (!before) before = cloneDocument(doc);
      if (after) { restoreSnapshot(doc, after); return; }
      const l = doc.layers[layerId]; if (!l) return;
      const from = siblingIds(doc, l); const i = from.indexOf(layerId); if (i >= 0) from.splice(i, 1);
      l.parentId = groupId;
      const to = groupId ? doc.layers[groupId]!.childIds : doc.rootIds;
      to.unshift(layerId);
      after = cloneDocument(doc);
    },
    undo(doc) { if (before) restoreSnapshot(doc, before); },
  };
}
export function transformLayerCommand(layerId: string, t: Transform2D, label = 'Transform layer'): Command {
  let prev: Transform2D | undefined;
  return {
    label,
    do(doc) { const l = doc.layers[layerId]; if (!l) return; if (!prev) prev = { ...l.transform }; l.transform = { ...t }; },
    undo(doc) { const l = doc.layers[layerId]; if (l && prev) l.transform = { ...prev }; },
  };
}
export function maskCommand(label: string, layerId: string, apply: (l: Layer) => void): Command {
  return pixelCommand(label, layerId, apply);
}

/** Command over a layer's DATA fields (text/shape/adjustment/fillColor) —
 * snapshots them before/after so property-panel edits are undoable and
 * dirty-tracked like every other edit (UI audit P1-1: these used to mutate
 * the layer directly, invisible to history and autosave). */
export function layerDataCommand(label: string, layerId: string, apply: (l: Layer) => void): Command {
  let before: Layer | undefined, after: Layer | undefined;
  const fields = (src: Layer, dst: Layer) => {
    const c = cloneLayerDeep(src);
    dst.text = c.text; dst.shape = c.shape; dst.adjustment = c.adjustment; dst.fillColor = c.fillColor;
  };
  return {
    label,
    do(doc) {
      const l = doc.layers[layerId]; if (!l) return;
      if (!before) before = cloneLayerDeep(l);
      if (after) { fields(after, l); return; }
      apply(l);
      after = cloneLayerDeep(l);
    },
    undo(doc) { const l = doc.layers[layerId]; if (l && before) fields(before, l); },
  };
}

/** Command built from explicit before/after layer snapshots — for drag
 * interactions (sliders) that mutate live and commit once at drag end. */
export function layerDataSnapshotCommand(label: string, layerId: string, before: Layer, after: Layer): Command {
  const fields = (src: Layer, dst: Layer) => {
    const c = cloneLayerDeep(src);
    dst.text = c.text; dst.shape = c.shape; dst.adjustment = c.adjustment; dst.fillColor = c.fillColor;
  };
  return {
    label,
    do(doc) { const l = doc.layers[layerId]; if (l) fields(after, l); },
    undo(doc) { const l = doc.layers[layerId]; if (l) fields(before, l); },
  };
}
export function setBlendCommand(layerId: string, mode: BlendMode): Command {
  return setLayerPropsCommand(layerId, { blendMode: mode }, 'Set blend mode');
}
export function setOpacityCommand(layerId: string, opacity: number): Command {
  return setLayerPropsCommand(layerId, { opacity }, 'Set opacity');
}
export function createGroupCommand(name = 'Group'): Command {
  let group: Layer | undefined;
  let prevActive: string | null | undefined;
  return {
    label: 'Create group',
    do(doc) {
      if (prevActive === undefined) prevActive = doc.activeLayerId;
      if (!group) group = createLayer('group', doc.width, doc.height, name);
      // Clone-on-insert (RT2-1/A): the held group object must never enter
      // the document — moveLayerToGroup mutates the in-doc object's
      // childIds, and redo would resurrect that mutated object.
      addLayerToDoc(doc, cloneLayerDeep(group), null, 0); doc.activeLayerId = group.id;
    },
    undo(doc) {
      if (group) removeLayerFromDoc(doc, group.id);
      if (prevActive && doc.layers[prevActive]) doc.activeLayerId = prevActive;
    },
  };
}
