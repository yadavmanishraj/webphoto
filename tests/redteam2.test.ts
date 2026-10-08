/**
 * RED TEAM ROUND 2 — adversarial. Assumes round 1 made the team complacent.
 *
 * Round 1 (tests/redteam.test.ts) covered serialization fuzz, history
 * undo-all/redo-all byte-exactness, blend W3C, selection algebra, limits,
 * transform algebra. NONE of that is repeated here. New surfaces:
 *
 *  RT2-1 MODEL-BASED ORACLE: a random command script (with interleaved
 *        undo/redo) is driven through the real History. After EVERY step the
 *        live document is compared against an independent replay oracle: a
 *        fresh document + fresh command instances executing only the
 *        effective (non-undone) prefix. Any snapshot-aliasing, lazy-capture,
 *        or closure-state bug in a command shows up as a fingerprint
 *        divergence even when undo-all/redo-all would end byte-exact.
 *  RT2-2 Renderer fuzz: determinism, output sanity, renderer purity
 *        (composite must not mutate the doc), mask/opacity invisibility.
 *  RT2-3 cloneDocument independence in both directions.
 *  RT2-4 Extremes: polygon sides, gradient angles (incl. NaN), text layout
 *        degenerate inputs, zero/negative shape sizes, 60-deep nesting.
 *  RT2-5 Aliasing: layers sharing one PixelBuffer object.
 *
 * Broken invariants were originally encoded as it.fails with a
 * // CONFIRMED BUG: comment. POST-FIX (critique wave 2): RT2-1/A (stale
 * held layer objects resurrected on redo) and RT2-1/B (group/duplicate
 * undo not restoring the previously active layer) are FIXED — commands now
 * insert deep clones of held templates and capture/restore prevActive —
 * and every former it.fails below is promoted to a strict assertion.
 */
import { describe, it, expect } from 'vitest';
import {
  BLEND_MODES,
  type BlendMode, type EditorDocument, type Layer, type LayerType, type RGBA,
} from '../src/core/contracts';
import {
  addLayerToDoc, cloneDocument, createDocument, createLayer,
} from '../src/core/document';
import { History } from '../src/core/history';
import * as C from '../src/core/commands';
import { compositeDocument } from '../src/core/render';
import { deserializeProject, serializeProject } from '../src/storage/project';
import { paintStroke, type BrushSettings } from '../src/engine/brush/brush';
import { rasterizeShape } from '../src/engine/shapes/shapes';
import { renderGradient } from '../src/engine/gradient/gradient';
import { layoutText, type MeasureFn } from '../src/engine/text/textLayout';

// ---------------------------------------------------------------------------
// Deterministic RNG + helpers
// ---------------------------------------------------------------------------
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

const bytes = (a: Uint8Array | Uint8ClampedArray): string => Array.from(a).join(',');
const bytesEqual = (a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------
// RT2-1 — Model-based oracle
// ---------------------------------------------------------------------------
const W = 10, H = 8;
const BRUSH: BrushSettings = { size: 6, hardness: 1, opacity: 1, flow: 1, spacing: 0.25, roundness: 1, angleDeg: 0 };

type Op =
  | { k: 'add'; sym: string; type: LayerType; parent: string | null; fill: RGBA }
  | { k: 'group'; sym: string }
  | { k: 'remove'; sym: string }
  | { k: 'dup'; sym: string; dup: string }
  | { k: 'move'; sym: string; group: string | null }
  | { k: 'reorder'; sym: string; index: number }
  | { k: 'rename'; sym: string; name: string }
  | { k: 'props'; sym: string; props: { opacity?: number; blendMode?: BlendMode; visible?: boolean } }
  | { k: 'transform'; sym: string; x: number; y: number; rot: number }
  | { k: 'stroke'; sym: string; x: number; y: number; color: RGBA }
  | { k: 'undo' }
  | { k: 'redo' };
type ExecOp = Exclude<Op, { k: 'undo' } | { k: 'redo' }>;

// --- symbolic model: folds an exec-op stack into a symbolic layer tree ----
interface SymLayer { sym: string; type: LayerType; parent: string | null; children: string[] }
interface SymState { layers: Map<string, SymLayer>; roots: string[] }

function initialSymState(): SymState {
  const layers = new Map<string, SymLayer>();
  layers.set('BG', { sym: 'BG', type: 'raster', parent: null, children: [] });
  return { layers, roots: ['BG'] };
}
function symSubtreePreorder(st: SymState, root: string): string[] {
  const out: string[] = [];
  const walk = (s: string) => { out.push(s); st.layers.get(s)!.children.forEach(walk); };
  walk(root);
  return out;
}
function foldSym(stack: ExecOp[]): SymState {
  const st = initialSymState();
  const siblingsOf = (s: SymLayer): string[] => (s.parent ? st.layers.get(s.parent)!.children : st.roots);
  for (const op of stack) {
    switch (op.k) {
      case 'add': {
        st.layers.set(op.sym, { sym: op.sym, type: op.type, parent: op.parent, children: [] });
        siblingsOf(st.layers.get(op.sym)!).unshift(op.sym);
        break;
      }
      case 'group': {
        st.layers.set(op.sym, { sym: op.sym, type: 'group', parent: null, children: [] });
        st.roots.unshift(op.sym);
        break;
      }
      case 'remove': {
        const l = st.layers.get(op.sym); if (!l) break;
        const sib = siblingsOf(l); sib.splice(sib.indexOf(op.sym), 1);
        for (const s of symSubtreePreorder(st, op.sym)) st.layers.delete(s);
        break;
      }
      case 'dup': {
        const src = st.layers.get(op.sym); if (!src) break;
        const pre = symSubtreePreorder(st, op.sym);
        const map = new Map<string, string>();
        pre.forEach((s, i) => map.set(s, i === 0 ? op.dup : `${op.dup}#${i - 1}`));
        // create clones bottom-up-safe: parents are always earlier in preorder
        for (const s of pre) {
          const orig = st.layers.get(s)!;
          const ns = map.get(s)!;
          st.layers.set(ns, {
            sym: ns, type: orig.type,
            parent: orig.parent === null ? null : (map.get(orig.parent) ?? orig.parent),
            children: orig.children.map(c => map.get(c)!),
          });
        }
        const sib = siblingsOf(src);
        sib.splice(sib.indexOf(op.sym), 0, op.dup);
        break;
      }
      case 'move': {
        const l = st.layers.get(op.sym); if (!l) break;
        const from = siblingsOf(l); from.splice(from.indexOf(op.sym), 1);
        l.parent = op.group;
        (op.group ? st.layers.get(op.group)!.children : st.roots).unshift(op.sym);
        break;
      }
      case 'reorder': {
        const l = st.layers.get(op.sym); if (!l) break;
        const sib = siblingsOf(l); sib.splice(sib.indexOf(op.sym), 1);
        sib.splice(Math.max(0, Math.min(op.index, sib.length)), 0, op.sym);
        break;
      }
      default: break; // rename/props/transform/stroke: no structural effect
    }
  }
  return st;
}

// --- canonical fingerprint: real ids -> symbolic names, then full dump -----
function canonical(doc: EditorDocument, realToSym: Map<string, string>): string {
  const sym = (id: string | null): string => (id === null ? 'null' : (realToSym.get(id) ?? `?UNMAPPED:${id}`));
  const parts: string[] = [];
  parts.push(
    `doc:${doc.width}x${doc.height}:${doc.name}:${JSON.stringify(doc.background)}:` +
    `roots=${JSON.stringify(doc.rootIds.map(sym))}:active=${sym(doc.activeLayerId)}:` +
    `guides=${JSON.stringify(doc.guides)}:grid=${JSON.stringify(doc.grid)}`,
  );
  const layers = Object.values(doc.layers).sort((a, b) => sym(a.id).localeCompare(sym(b.id)));
  for (const l of layers) {
    parts.push([
      sym(l.id), l.name, l.type, l.visible, l.locked, l.opacity, l.blendMode,
      JSON.stringify(l.transform), sym(l.parentId), JSON.stringify(l.childIds.map(sym)),
      l.maskEnabled, l.clipped,
      l.pixels ? `px${l.pixels.width}x${l.pixels.height}[${bytes(l.pixels.data)}]` : '-',
      l.mask ? `mk${l.mask.width}x${l.mask.height}[${bytes(l.mask.data)}]` : '-',
      JSON.stringify(l.text ?? null), JSON.stringify(l.shape ?? null),
      JSON.stringify(l.gradient ?? null), JSON.stringify(l.adjustment ?? null),
      JSON.stringify(l.fillColor ?? null),
    ].join('|'));
  }
  return parts.join('\n');
}

// --- executor: applies ops to a real doc, maintaining the sym<->real map ---
interface Ctx {
  doc: EditorDocument;
  hist: History;
  symToReal: Map<string, string>;
  realToSym: Map<string, string>;
}
function makeCtx(): Ctx {
  const doc = createDocument(W, H, 'Oracle', { r: 250, g: 250, b: 250, a: 255 });
  const bgId = doc.rootIds[0]!;
  return {
    doc, hist: new History(),
    symToReal: new Map([['BG', bgId]]),
    realToSym: new Map([[bgId, 'BG']]),
  };
}
function register(ctx: Ctx, symName: string, realId: string): void {
  ctx.symToReal.set(symName, realId); ctx.realToSym.set(realId, symName);
}
function subtreeRealPreorder(doc: EditorDocument, rootId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => { out.push(id); doc.layers[id]!.childIds.forEach(walk); };
  walk(rootId);
  return out;
}
function execOp(ctx: Ctx, op: ExecOp): void {
  const real = (s: string | null): string | null => (s === null ? null : ctx.symToReal.get(s)!);
  switch (op.k) {
    case 'add': {
      const layer = createLayer(op.type, W, H, `N-${op.sym}`);
      if (op.type === 'raster' && layer.pixels) layer.pixels.data.set(solidData(op.fill));
      if (op.type === 'fill') layer.fillColor = { ...op.fill };
      if (op.type === 'text' && layer.text) layer.text.text = `T-${op.sym}`;
      register(ctx, op.sym, layer.id);
      ctx.hist.execute(C.addLayerCommand(layer, real(op.parent)), ctx.doc);
      break;
    }
    case 'group': {
      const before = new Set(Object.keys(ctx.doc.layers));
      ctx.hist.execute(C.createGroupCommand(`G-${op.sym}`), ctx.doc);
      const fresh = Object.keys(ctx.doc.layers).filter(id => !before.has(id));
      if (fresh.length === 1) register(ctx, op.sym, fresh[0]!);
      break;
    }
    case 'remove': ctx.hist.execute(C.removeLayerCommand(real(op.sym)!), ctx.doc); break;
    case 'dup': {
      const srcReal = real(op.sym)!;
      const already = ctx.symToReal.has(op.dup) && !!ctx.doc.layers[ctx.symToReal.get(op.dup)!];
      ctx.hist.execute(C.duplicateLayerCommand(srcReal), ctx.doc);
      if (!already) {
        const before = new Set<string>(); // ids that existed pre-dup are NOT the clones
        // rediscover: clones are layers whose ids we have never mapped
        const cloneRoot = Object.values(ctx.doc.layers).find(
          l => !ctx.realToSym.has(l.id) && l.parentId === ctx.doc.layers[srcReal]!.parentId &&
            (ctx.doc.layers[srcReal]!.parentId === null || true),
        );
        void before;
        if (cloneRoot) {
          const srcPre = subtreeRealPreorder(ctx.doc, srcReal);
          const dupPre = subtreeRealPreorder(ctx.doc, cloneRoot.id);
          if (srcPre.length === dupPre.length) {
            dupPre.forEach((rid, i) => register(ctx, i === 0 ? op.dup : `${op.dup}#${i - 1}`, rid));
          }
        }
      }
      break;
    }
    case 'move': ctx.hist.execute(C.moveLayerToGroupCommand(real(op.sym)!, real(op.group)), ctx.doc); break;
    case 'reorder': ctx.hist.execute(C.reorderLayerCommand(real(op.sym)!, op.index), ctx.doc); break;
    case 'rename': ctx.hist.execute(C.renameLayerCommand(real(op.sym)!, op.name), ctx.doc); break;
    case 'props': ctx.hist.execute(C.setLayerPropsCommand(real(op.sym)!, op.props), ctx.doc); break;
    case 'transform':
      ctx.hist.execute(C.transformLayerCommand(real(op.sym)!, { x: op.x, y: op.y, scaleX: 1, scaleY: 1, rotationDeg: op.rot }), ctx.doc);
      break;
    case 'stroke': {
      const rid = real(op.sym)!;
      ctx.hist.execute(C.pixelCommand('stroke', rid, (l: Layer) => {
        if (l.pixels) paintStroke(l.pixels, [{ x: op.x, y: op.y }], BRUSH, op.color, 'paint');
      }), ctx.doc);
      break;
    }
  }
}
function solidData(c: RGBA): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = c.a; }
  return d;
}
/** Replay oracle: fresh doc, fresh commands, only the effective stack. */
function replayFingerprint(stack: ExecOp[]): string {
  const ctx = makeCtx();
  for (const op of stack) execOp(ctx, op);
  return canonical(ctx.doc, ctx.realToSym);
}

// --- script generator -------------------------------------------------------
function generateScript(rng: Rng, steps: number): Op[] {
  const script: Op[] = [];
  const stack: ExecOp[] = [];
  const undone: ExecOp[] = [];
  let mint = 0;
  const color = (): RGBA => ({ r: Math.floor(rng() * 256), g: Math.floor(rng() * 256), b: Math.floor(rng() * 256), a: 255 });
  for (let s = 0; s < steps; s++) {
    const st = foldSym(stack);
    const all = [...st.layers.values()];
    const roll = rng();
    if (roll < 0.16 && stack.length > 0) {
      script.push({ k: 'undo' }); undone.push(stack.pop()!); continue;
    }
    if (roll < 0.26 && undone.length > 0) {
      script.push({ k: 'redo' }); stack.push(undone.pop()!); continue;
    }
    const groups = all.filter(l => l.type === 'group');
    const rasters = all.filter(l => l.type === 'raster');
    const choice = rng();
    let op: ExecOp;
    if (choice < 0.20 || all.length <= 1) {
      const type = pick(rng, ['raster', 'raster', 'text', 'shape', 'fill', 'adjustment'] as LayerType[]);
      op = { k: 'add', sym: `S${mint++}`, type, parent: groups.length && rng() < 0.35 ? pick(rng, groups).sym : null, fill: color() };
    } else if (choice < 0.28) {
      op = { k: 'group', sym: `S${mint++}` };
    } else if (choice < 0.40 && all.length > 1) {
      op = { k: 'remove', sym: pick(rng, all).sym };
    } else if (choice < 0.50) {
      op = { k: 'dup', sym: pick(rng, all).sym, dup: `S${mint++}` };
    } else if (choice < 0.60) {
      const target = pick(rng, all);
      const forbidden = new Set(symSubtreePreorder(st, target.sym));
      const dests = groups.filter(g => !forbidden.has(g.sym));
      op = { k: 'move', sym: target.sym, group: dests.length && rng() < 0.7 ? pick(rng, dests).sym : null };
    } else if (choice < 0.68) {
      const target = pick(rng, all);
      const sibCount = target.parent ? st.layers.get(target.parent)!.children.length : st.roots.length;
      op = { k: 'reorder', sym: target.sym, index: ri(rng, Math.max(1, sibCount)) };
    } else if (choice < 0.76) {
      op = { k: 'rename', sym: pick(rng, all).sym, name: `R${mint++}` };
    } else if (choice < 0.86) {
      const props: { opacity?: number; blendMode?: BlendMode; visible?: boolean } = {};
      if (rng() < 0.6) props.opacity = pick(rng, [0, 0.5, 0.75, 1]);
      if (rng() < 0.5) props.blendMode = pick(rng, BLEND_MODES);
      if (rng() < 0.4) props.visible = rng() < 0.7;
      if (Object.keys(props).length === 0) props.opacity = 0.5;
      op = { k: 'props', sym: pick(rng, all).sym, props };
    } else if (choice < 0.93 && rasters.length) {
      op = { k: 'stroke', sym: pick(rng, rasters).sym, x: ri(rng, W), y: ri(rng, H), color: color() };
    } else {
      op = { k: 'transform', sym: pick(rng, all).sym, x: ri(rng, 5) - 2, y: ri(rng, 5) - 2, rot: pick(rng, [0, 45, 90, 180]) };
    }
    script.push(op); stack.push(op); undone.length = 0;
  }
  return script;
}

function runScriptAgainstOracle(script: Op[], label: string): void {
  const ctx = makeCtx();
  const stack: ExecOp[] = [];
  const undone: ExecOp[] = [];
  script.forEach((op, i) => {
    if (op.k === 'undo') { ctx.hist.undo(ctx.doc); const p = stack.pop(); if (p) undone.push(p); }
    else if (op.k === 'redo') { ctx.hist.redo(ctx.doc); const p = undone.pop(); if (p) stack.push(p); }
    else { execOp(ctx, op); stack.push(op); undone.length = 0; }
    const live = canonical(ctx.doc, ctx.realToSym);
    const oracle = replayFingerprint(stack);
    expect(live, `${label} step ${i} after ${JSON.stringify(op)}`).toBe(oracle);
  });
}

describe('RT2-1 model-based oracle (live History vs from-scratch replay)', () => {
  // WAS CONFIRMED BUG (RT2-1/B, fixed in critique wave 2): createGroupCommand.undo and
  // duplicateLayerCommand.undo never restore the previously active layer —
  // they fall through to removeLayerFromDoc's rootIds[0] heuristic
  // (src/core/commands.ts:195-202 createGroupCommand has no prevActive
  // capture; duplicateLayerCommand.undo at :118 neither). addLayerCommand
  // and removeLayerCommand got exactly this fix in the RT1 wave; these two
  // were missed. First divergences (structure identical, active differs):
  // seed 11 step 46 undo{group S18}: live active=S13, oracle S15.
  // seed 222 step 10 undo{dup S1->S3}: live active=S1, oracle S2.
  // seed 44444 step 40 undo{dup S21->S22}: live active=S12, oracle S21.
  for (const seed of [1, 2, 3, 11, 222, 3333, 44444, 777]) {
    it(`seed ${seed}: 70-step random script with undo/redo matches replay after every step`, () => {
      runScriptAgainstOracle(generateScript(mulberry32(seed), 70), `seed${seed}`);
    });
  }
  // WAS CONFIRMED BUG (RT2-1/A, fixed in critique wave 2): stale command-held layer object resurrects
  // mutated structure on redo. createGroupCommand holds its group Layer
  // object (src/core/commands.ts:198); moveLayerToGroupCommand.do mutates
  // that very object's childIds (pushes 'A'); undoing the move restores the
  // doc from a snapshot CLONE, leaving the held original with childIds=['A'];
  // undoing the group-add removes the clone; REDOING the group-add
  // re-inserts the stale original — the group now lists A as a child while
  // A also sits at root with parentId=null (layer in two parents).
  // Evidence: step 7 (redo of group-add): live G.childIds=["A"], oracle [].
  it('targeted: add -> stroke -> move-to-group -> undo x3 -> redo x3', () => {
    runScriptAgainstOracle([
      { k: 'add', sym: 'A', type: 'raster', parent: null, fill: { r: 10, g: 20, b: 30, a: 255 } },
      { k: 'group', sym: 'G' },
      { k: 'stroke', sym: 'A', x: 3, y: 3, color: { r: 255, g: 0, b: 0, a: 255 } },
      { k: 'move', sym: 'A', group: 'G' },
      { k: 'undo' }, { k: 'undo' }, { k: 'undo' },
      { k: 'redo' }, { k: 'redo' }, { k: 'redo' },
    ], 'targeted-move');
  });
  // WAS CONFIRMED BUG (RT2-1/B, duplicate-undo facet, fixed): after dup G->D (active=D)
  // and undo, live active=G (rootIds[0] heuristic) but the pre-duplicate
  // active layer was A (a child of G). Evidence: step 5, active G vs A.
  it('targeted: duplicate group, stroke the copy, unwind and rewind across the duplicate', () => {
    runScriptAgainstOracle([
      { k: 'group', sym: 'G' },
      { k: 'add', sym: 'A', type: 'raster', parent: 'G', fill: { r: 1, g: 2, b: 3, a: 255 } },
      { k: 'dup', sym: 'G', dup: 'D' },
      { k: 'stroke', sym: 'D#0', x: 2, y: 2, color: { r: 0, g: 255, b: 0, a: 255 } },
      { k: 'undo' }, { k: 'undo' }, { k: 'redo' }, { k: 'redo' },
      { k: 'remove', sym: 'D' },
      { k: 'undo' }, { k: 'redo' }, { k: 'undo' },
    ], 'targeted-dup');
  });
  it('targeted: remove subtree with active inside, undo/redo oscillation', () => {
    runScriptAgainstOracle([
      { k: 'group', sym: 'G' },
      { k: 'add', sym: 'A', type: 'raster', parent: 'G', fill: { r: 9, g: 9, b: 9, a: 255 } },
      { k: 'add', sym: 'B', type: 'raster', parent: null, fill: { r: 5, g: 5, b: 5, a: 255 } },
      { k: 'remove', sym: 'G' },
      { k: 'undo' }, { k: 'redo' }, { k: 'undo' }, { k: 'redo' }, { k: 'undo' },
    ], 'targeted-remove');
  });
});

// ---------------------------------------------------------------------------
// RT2-2 — Renderer fuzz
// ---------------------------------------------------------------------------
function randomRenderDoc(rng: Rng): EditorDocument {
  const w = 12, h = 10;
  const doc = createDocument(w, h, 'Fuzz', { r: 255, g: 255, b: 255, a: 255 });
  const mkRaster = (name: string): Layer => {
    const l = createLayer('raster', w, h, name);
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i++) d[i] = Math.floor(rng() * 256);
    l.pixels = { width: w, height: h, data: d };
    if (rng() < 0.5) {
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = Math.floor(rng() * 256);
      l.mask = { width: w, height: h, data: m };
    }
    return l;
  };
  const decorate = (l: Layer): Layer => {
    l.opacity = pick(rng, [0, 0.3, 0.7, 1]);
    l.blendMode = pick(rng, BLEND_MODES);
    l.visible = rng() > 0.15;
    l.transform = { x: ri(rng, 9) - 4, y: ri(rng, 9) - 4, scaleX: pick(rng, [0.5, 1, 1.5]), scaleY: 1, rotationDeg: pick(rng, [0, 0, 30, 90]) };
    return l;
  };
  addLayerToDoc(doc, decorate(mkRaster('r1')), null);
  const fill = createLayer('fill', w, h, 'fill'); fill.fillColor = { r: 200, g: 40, b: 40, a: 180 };
  addLayerToDoc(doc, decorate(fill), null);
  const shape = createLayer('shape', w, h, 'shape');
  shape.shape = { kind: pick(rng, ['rectangle', 'ellipse', 'polygon'] as const), w: 8, h: 6, cornerRadius: 1, sides: 5, fill: { r: 0, g: 120, b: 255, a: 200 }, stroke: null, strokeWidth: 0 };
  shape.transform = { x: 2, y: 2, scaleX: 1, scaleY: 1, rotationDeg: 0 };
  addLayerToDoc(doc, decorate(shape), null);
  const grad = createLayer('raster', w, h, 'grad');
  grad.gradient = { kind: pick(rng, ['linear', 'radial'] as const), angleDeg: ri(rng, 360), stops: [{ offset: 0, color: { r: 255, g: 0, b: 0, a: 255 } }, { offset: 1, color: { r: 0, g: 0, b: 255, a: 128 } }], reverse: rng() < 0.5 };
  addLayerToDoc(doc, decorate(grad), null);
  const grp = createLayer('group', w, h, 'grp');
  addLayerToDoc(doc, grp, null);
  addLayerToDoc(doc, decorate(mkRaster('child')), grp.id);
  const adj = createLayer('adjustment', w, h, 'adj');
  adj.adjustment = { kind: pick(rng, ['invert', 'grayscale', 'posterize', 'brightness-contrast'] as const), params: { levels: 3, brightness: 20, contrast: 10 } };
  if (rng() < 0.8) addLayerToDoc(doc, adj, null);
  return doc;
}

describe('RT2-2 renderer fuzz', () => {
  for (const seed of [7, 99, 1234]) {
    it(`seed ${seed}: deterministic, well-formed, and does not mutate the document`, () => {
      const doc = randomRenderDoc(mulberry32(seed));
      const beforeBytes = serializeProject(doc);
      const a = compositeDocument(doc);
      const b = compositeDocument(doc);
      expect(a.width).toBe(doc.width); expect(a.height).toBe(doc.height);
      expect(a.data.length).toBe(doc.width * doc.height * 4);
      expect(bytesEqual(a.data, b.data)).toBe(true);
      // Renderer purity: serializing after rendering must be byte-identical.
      expect(bytesEqual(serializeProject(doc), beforeBytes)).toBe(true);
      for (let i = 0; i < a.data.length; i++) {
        const v = a.data[i]!;
        expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
      }
    });
  }
  it('fully-masked layer and opacity-0 layer are each invisible', () => {
    const doc = createDocument(8, 6, 'MaskVis', { r: 255, g: 255, b: 255, a: 255 });
    const base = compositeDocument(doc);
    const red = createLayer('raster', 8, 6, 'red');
    red.pixels!.data.set(solidData({ r: 255, g: 0, b: 0, a: 255 }).subarray(0, 8 * 6 * 4));
    red.mask = { width: 8, height: 6, data: new Uint8Array(8 * 6) }; // all zero = fully hidden
    addLayerToDoc(doc, red, null);
    expect(bytesEqual(compositeDocument(doc).data, base.data)).toBe(true);
    red.mask = undefined; red.opacity = 0;
    expect(bytesEqual(compositeDocument(doc).data, base.data)).toBe(true);
    red.opacity = 1; // sanity: unmasked opaque red MUST change the picture
    expect(bytesEqual(compositeDocument(doc).data, base.data)).toBe(false);
  });
  it('document with every layer invisible renders fully transparent', () => {
    const doc = createDocument(6, 5, 'Ghost', { r: 255, g: 0, b: 0, a: 255 });
    const extra = createLayer('raster', 6, 5, 'x');
    addLayerToDoc(doc, extra, null);
    for (const l of Object.values(doc.layers)) l.visible = false;
    const out = compositeDocument(doc);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// RT2-3 — cloneDocument independence
// ---------------------------------------------------------------------------
describe('RT2-3 cloneDocument independence', () => {
  function richDoc(): EditorDocument {
    const doc = createDocument(8, 6, 'CloneMe', { r: 12, g: 34, b: 56, a: 255 });
    const r = createLayer('raster', 8, 6, 'r');
    r.pixels!.data.set(solidData({ r: 200, g: 10, b: 10, a: 255 }).subarray(0, 8 * 6 * 4));
    r.mask = { width: 8, height: 6, data: new Uint8Array(8 * 6).fill(128) };
    const t = createLayer('text', 8, 6, 't');
    const s = createLayer('shape', 8, 6, 's');
    const a = createLayer('adjustment', 8, 6, 'a');
    const f = createLayer('fill', 8, 6, 'f');
    const g = createLayer('raster', 8, 6, 'g');
    g.gradient = { kind: 'linear', angleDeg: 45, stops: [{ offset: 0, color: { r: 1, g: 2, b: 3, a: 255 } }, { offset: 1, color: { r: 4, g: 5, b: 6, a: 200 } }], reverse: false };
    for (const l of [r, t, s, a, f, g]) addLayerToDoc(doc, l, null);
    doc.guides.push({ orientation: 'h', position: 3 });
    return doc;
  }
  const fp = (d: EditorDocument): string => bytes(serializeProject(d));
  it('mutating every nested field of the clone leaves the original byte-identical', () => {
    const doc = richDoc();
    const clone = cloneDocument(doc);
    const before = fp(doc);
    const cl = Object.values(clone.layers);
    for (const l of cl) {
      if (l.pixels) l.pixels.data.fill(77);
      if (l.mask) l.mask.data.fill(3);
      if (l.text) { l.text.text = 'HACKED'; l.text.fontSize = 999; l.text.color.r = 111; }
      if (l.shape) { l.shape.w = 1; if (l.shape.fill) l.shape.fill.r = 222; if (l.shape.stroke) l.shape.stroke.g = 5; }
      if (l.adjustment) { l.adjustment.kind = 'invert'; l.adjustment.params.brightness = 555; }
      if (l.gradient) { l.gradient.stops[0]!.color.r = 250; l.gradient.stops[0]!.offset = 0.9; l.gradient.angleDeg = 1; }
      if (l.fillColor) l.fillColor.r = 42;
      l.transform.x = 777; l.childIds.push('bogus'); l.opacity = 0.01;
    }
    clone.rootIds.reverse();
    clone.guides[0]!.position = 999; clone.guides.push({ orientation: 'v', position: 1 });
    clone.grid.spacing = 1234; clone.background.r = 200; clone.name = 'Pwned';
    expect(fp(doc)).toBe(before);
  });
  it('mutating the original after cloning leaves the clone byte-identical', () => {
    const doc = richDoc();
    const clone = cloneDocument(doc);
    const cloneBefore = fp(clone);
    for (const l of Object.values(doc.layers)) {
      if (l.pixels) l.pixels.data.fill(1);
      if (l.mask) l.mask.data.fill(254);
      if (l.text) l.text.color.b = 99;
      if (l.gradient) l.gradient.stops[1]!.color.a = 0;
      l.transform.rotationDeg = 33;
    }
    doc.guides.push({ orientation: 'v', position: 2 });
    expect(fp(clone)).toBe(cloneBefore);
  });
});

// ---------------------------------------------------------------------------
// RT2-4 — Extremes
// ---------------------------------------------------------------------------
describe('RT2-4 extremes', () => {
  it('polygon shapes with 3 and 100 sides rasterize sanely', () => {
    for (const sides of [3, 100]) {
      const buf = rasterizeShape({ kind: 'polygon', w: 40, h: 40, cornerRadius: 0, sides, fill: { r: 255, g: 0, b: 0, a: 255 }, stroke: null, strokeWidth: 0 });
      expect(buf.data.length).toBe(40 * 40 * 4);
      const at = (x: number, y: number) => buf.data[(y * 40 + x) * 4 + 3]!;
      expect(at(20, 20)).toBe(255);       // center inside
      expect(at(0, 0)).toBe(0);          // corner outside
      let filled = 0;
      for (let i = 3; i < buf.data.length; i += 4) if (buf.data[i] === 255) filled++;
      expect(filled).toBeGreaterThan(100);
      expect(filled).toBeLessThan(40 * 40);
      if (sides === 100) { // ~circle: area fraction near pi/4
        expect(filled / 1600).toBeGreaterThan(0.6);
        expect(filled / 1600).toBeLessThan(0.9);
      }
    }
  });
  it('gradient angles wrap: 720 and -720 render identically to 0', () => {
    const stops = [{ offset: 0, color: { r: 10, g: 20, b: 30, a: 255 } }, { offset: 1, color: { r: 200, g: 210, b: 220, a: 255 } }];
    const a0 = renderGradient(16, 12, { kind: 'linear', angleDeg: 0, stops, reverse: false });
    const a720 = renderGradient(16, 12, { kind: 'linear', angleDeg: 720, stops, reverse: false });
    const am720 = renderGradient(16, 12, { kind: 'linear', angleDeg: -720, stops, reverse: false });
    expect(bytesEqual(a720.data, a0.data)).toBe(true);
    expect(bytesEqual(am720.data, a0.data)).toBe(true);
  });
  it('gradient with NaN angle renders exactly as 0 degrees (sanitized, critique wave 2)', () => {
    const stops = [{ offset: 0, color: { r: 10, g: 20, b: 30, a: 255 } }, { offset: 1, color: { r: 200, g: 210, b: 220, a: 255 } }];
    const nan = renderGradient(8, 8, { kind: 'linear', angleDeg: NaN, stops, reverse: false });
    const zero = renderGradient(8, 8, { kind: 'linear', angleDeg: 0, stops, reverse: false });
    expect(bytesEqual(nan.data, zero.data)).toBe(true);
  });
  it('a saved gradient whose angle became null (NaN via JSON) is rejected on load, never silently mutated', () => {
    const doc = createDocument(8, 8, 'NanAngle');
    const g = createLayer('raster', 8, 8, 'grad');
    g.gradient = { kind: 'linear', angleDeg: NaN, stops: [{ offset: 0, color: { r: 255, g: 0, b: 0, a: 255 } }, { offset: 1, color: { r: 0, g: 0, b: 255, a: 255 } }], reverse: false };
    addLayerToDoc(doc, g, null);
    // The loader must refuse (typed ProjectError) rather than load a
    // silently-mutated document.
    expect(() => deserializeProject(serializeProject(doc))).toThrowError(/checksum|Invalid gradient angle|corrupt/i);
  });
  const measure: MeasureFn = (t) => t.length * 10;
  const baseText = { fontFamily: 'X', fontWeight: 400, italic: false, align: 'left' as const, color: { r: 0, g: 0, b: 0, a: 255 }, lineHeight: 1.5 };
  it('text layout degenerate inputs never crash or loop', () => {
    const empty = layoutText({ ...baseText, text: '', fontSize: 20, letterSpacing: 0 }, 100, measure);
    expect(empty.lines).toEqual([{ text: '', width: 0 }]);
    const spaces = layoutText({ ...baseText, text: '     ', fontSize: 20, letterSpacing: 0 }, 100, measure);
    expect(spaces.lines).toEqual([{ text: '', width: 0 }]);
    const zero = layoutText({ ...baseText, text: 'hello world', fontSize: 0, letterSpacing: 0 }, 100, measure);
    expect(zero.lineHeightPx).toBe(0); expect(zero.totalHeight).toBe(0);
    expect(zero.lines.length).toBeGreaterThanOrEqual(1);
    const huge = layoutText({ ...baseText, text: 'a b c', fontSize: 10, letterSpacing: 1_000_000 }, 100, measure);
    expect(huge.lines.length).toBe(3); // every word overflows -> own line
    const longWord = 'x'.repeat(500);
    const lw = layoutText({ ...baseText, text: longWord, fontSize: 10, letterSpacing: 0 }, 100, measure);
    expect(lw.lines.length).toBe(1); expect(lw.lines[0]!.text).toBe(longWord);
    const paras = layoutText({ ...baseText, text: 'a\n\nb', fontSize: 10, letterSpacing: 0 }, 100, measure);
    expect(paras.lines.map(l => l.text)).toEqual(['a', '', 'b']);
  });
  it('shape sizes 0 / negative / fractional are clamped, never a corrupt buffer', () => {
    for (const [w, h] of [[0, 10], [10, 0], [-5, 10], [10, -1], [10.7, 5.2]] as const) {
      const buf = rasterizeShape({ kind: 'rectangle', w, h, cornerRadius: 0, sides: 4, fill: { r: 1, g: 2, b: 3, a: 255 }, stroke: null, strokeWidth: 0 });
      expect(buf.width).toBe(Math.max(0, Math.floor(w)));
      expect(buf.height).toBe(Math.max(0, Math.floor(h)));
      expect(buf.data.length).toBe(buf.width * buf.height * 4);
    }
  });
  it('60-deep group nesting serializes, deserializes, clones and renders', () => {
    const doc = createDocument(6, 6, 'Deep', { r: 255, g: 255, b: 255, a: 255 });
    let parent: string | null = null;
    let topGroup = '';
    for (let i = 0; i < 60; i++) {
      const g = createLayer('group', 6, 6, `G${i}`);
      addLayerToDoc(doc, g, parent);
      if (i === 0) topGroup = g.id;
      parent = g.id;
    }
    const leaf = createLayer('raster', 6, 6, 'leaf');
    leaf.pixels!.data.set(solidData({ r: 255, g: 0, b: 0, a: 255 }).subarray(0, 6 * 6 * 4));
    addLayerToDoc(doc, leaf, parent);
    const round = deserializeProject(serializeProject(doc));
    expect(Object.keys(round.layers).length).toBe(Object.keys(doc.layers).length);
    expect(bytes(serializeProject(round))).toBe(bytes(serializeProject(doc)));
    const cloned = cloneDocument(doc);
    expect(Object.keys(cloned.layers).length).toBe(Object.keys(doc.layers).length);
    const out = compositeDocument(doc);
    const center = (3 * 6 + 3) * 4;
    expect(out.data[center]).toBe(255); expect(out.data[center + 1]).toBe(0); // red leaf visible through 60 groups
    void topGroup;
  });
});

// ---------------------------------------------------------------------------
// RT2-5 — Aliasing: shared PixelBuffer objects
// ---------------------------------------------------------------------------
describe('RT2-5 aliasing', () => {
  function sharedDoc(): { doc: EditorDocument; a: Layer; b: Layer; shared: { width: number; height: number; data: Uint8ClampedArray } } {
    const doc = createDocument(8, 6, 'Alias', { r: 255, g: 255, b: 255, a: 255 });
    const shared = { width: 8, height: 6, data: solidData({ r: 10, g: 10, b: 10, a: 255 }).subarray(0, 8 * 6 * 4) as Uint8ClampedArray };
    // rebuild as a standalone buffer object (subarray shares memory with a temp; copy to be exact)
    shared.data = new Uint8ClampedArray(shared.data);
    const a = createLayer('raster', 8, 6, 'A'); a.pixels = shared;
    const b = createLayer('raster', 8, 6, 'B'); b.pixels = shared;
    addLayerToDoc(doc, a, null); addLayerToDoc(doc, b, null);
    return { doc, a, b, shared };
  }
  it('pixelCommand undo restores the TARGET layer even after the aliased sibling was painted in between', () => {
    const { doc, a, b } = sharedDoc();
    const hist = new History();
    const original = new Uint8ClampedArray(a.pixels!.data);
    hist.execute(C.pixelCommand('paint A', a.id, (l) => {
      paintStroke(l.pixels!, [{ x: 2, y: 2 }], BRUSH, { r: 255, g: 0, b: 0, a: 255 }, 'paint');
    }), doc);
    const afterA = new Uint8ClampedArray(doc.layers[a.id]!.pixels!.data);
    expect(bytesEqual(afterA, original)).toBe(false);
    hist.execute(C.pixelCommand('paint B', b.id, (l) => {
      paintStroke(l.pixels!, [{ x: 5, y: 4 }], BRUSH, { r: 0, g: 0, b: 255, a: 255 }, 'paint');
    }), doc);
    hist.undo(doc); // undo paint B -> B back to its before-state (= afterA bytes)
    expect(bytesEqual(doc.layers[b.id]!.pixels!.data, afterA)).toBe(true);
    hist.undo(doc); // undo paint A -> A back to the original bytes
    expect(bytesEqual(doc.layers[a.id]!.pixels!.data, original)).toBe(true);
    hist.redo(doc); // redo paint A
    expect(bytesEqual(doc.layers[a.id]!.pixels!.data, afterA)).toBe(true);
  });
  it('pixelCommand on a layer without pixels (text) is a harmless no-op under undo/redo', () => {
    const doc = createDocument(8, 6, 'NoPx', { r: 255, g: 255, b: 255, a: 255 });
    const t = createLayer('text', 8, 6, 't');
    addLayerToDoc(doc, t, null);
    const hist = new History();
    const before = bytes(serializeProject(doc));
    hist.execute(C.pixelCommand('noop', t.id, (l) => { if (l.pixels) l.pixels.data.fill(0); }), doc);
    hist.undo(doc); hist.redo(doc); hist.undo(doc);
    expect(bytes(serializeProject(doc))).toBe(before);
  });
});
