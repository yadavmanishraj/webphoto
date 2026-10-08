/**
 * Native project format (WPSC) — prompt §33/§112/§113.
 *
 * Layout (all integers little-endian u32):
 *   bytes 0..3    magic 'WPSC'
 *   bytes 4..7    header length H
 *   bytes 8..8+H  UTF-8 JSON manifest
 *   rest          binary section: sequence of length-prefixed blobs
 *                 (u32 length + raw bytes), referenced from the manifest
 *                 by index (pixelsBlob / maskBlob).
 *
 * Pixels are stored as raw non-premultiplied RGBA bytes; masks as raw
 * single-channel bytes. The manifest carries an FNV-1a 32-bit checksum
 * over the whole binary section; any corruption there is detected on load.
 */
import {
  BLEND_MODES,
  LIMITS,
  type EditorDocument,
  type Layer,
} from '../core/contracts';

const LAYER_TYPES = ['raster', 'group', 'text', 'shape', 'adjustment', 'fill'] as const;

function headerChecksumOf(manifest: Manifest, binary: Uint8Array): string {
  const canonical = JSON.stringify({ ...manifest, headerChecksum: '00000000' });
  const head = new TextEncoder().encode(canonical);
  const joined = new Uint8Array(head.length + binary.length);
  joined.set(head, 0); joined.set(binary, head.length);
  return fnv1a(joined).toString(16).padStart(8, '0');
}

/** Structural validation of the layer graph + enums (red-team RT-1:
 * cyclic groups, duplicate ids, dangling refs, invalid blend modes and
 * out-of-range opacity were all previously accepted silently). */
function validateGraph(manifest: Manifest): void {
  const bad = (msg: string) => { throw new ProjectError('corrupt', msg); };
  const ids = new Set<string>();
  for (const m of manifest.layers) {
    if (ids.has(m.id)) bad(`Duplicate layer id ${m.id}`);
    ids.add(m.id);
    if (!(LAYER_TYPES as readonly string[]).includes(m.type)) bad(`Invalid layer type ${String(m.type)}`);
    if (!(BLEND_MODES as readonly string[]).includes(m.blendMode)) bad(`Invalid blend mode ${String(m.blendMode)}`);
    if (typeof m.opacity !== 'number' || !Number.isFinite(m.opacity) || m.opacity < 0 || m.opacity > 1)
      bad(`Invalid opacity for layer ${m.id}`);
  }
  const byId = new Map(manifest.layers.map(l => [l.id, l]));
  for (const m of manifest.layers) {
    // A non-finite gradient angle cannot survive JSON (NaN serializes to
    // null); reject it as corrupt instead of silently loading a mutated
    // value (red-team RT2 probe P-B).
    if (m.gradient !== undefined && (typeof m.gradient.angleDeg !== 'number' || !Number.isFinite(m.gradient.angleDeg)))
      bad(`Invalid gradient angle for layer ${m.id}`);
  }
  const membership = new Map<string, number>();
  const mark = (id: string) => membership.set(id, (membership.get(id) ?? 0) + 1);
  for (const id of manifest.doc.rootIds) { if (!ids.has(id)) bad(`Dangling rootId ${id}`); mark(id); }
  for (const m of manifest.layers) {
    if (m.type !== 'group' && (m.childIds?.length ?? 0) > 0) bad(`Non-group layer ${m.id} has children`);
    for (const cid of m.childIds ?? []) {
      if (!ids.has(cid)) bad(`Dangling childId ${cid} in ${m.id}`);
      mark(cid);
      const child = byId.get(cid)!;
      if (child.parentId !== m.id) bad(`Layer ${cid} parentId does not match its group`);
    }
    if (m.parentId !== null && !ids.has(m.parentId)) bad(`Dangling parentId ${m.parentId}`);
    if (m.parentId === null && !manifest.doc.rootIds.includes(m.id)) bad(`Layer ${m.id} is orphaned (no parent, not a root)`);
  }
  for (const [id, n] of membership) if (n !== 1) bad(`Layer ${id} appears ${n} times in the tree`);
  if (membership.size !== manifest.layers.length) bad('Layer tree does not cover every layer (cycle or orphan)');
  // Depth cap: the renderer holds one full-frame accumulator per nesting
  // level, so an unbounded-depth file is a memory-amplification vector
  // (security audit P2). 64 is far beyond any real document.
  const MAX_GROUP_DEPTH = 64;
  const depthOf = new Map<string, number>();
  const walkDepth = (ids: string[], d: number): void => {
    if (d > MAX_GROUP_DEPTH) bad(`Group nesting exceeds ${MAX_GROUP_DEPTH} levels`);
    for (const id of ids) { depthOf.set(id, d); const l = byId.get(id); if (l?.type === 'group') walkDepth(l.childIds ?? [], d + 1); }
  };
  walkDepth(manifest.doc.rootIds, 1);
  if (manifest.doc.activeLayerId !== null && !ids.has(manifest.doc.activeLayerId))
    bad(`Dangling activeLayerId ${manifest.doc.activeLayerId}`);
}

export class ProjectError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? `Project error: ${code}`);
    this.name = 'ProjectError';
    this.code = code;
  }
}

const MAGIC = [0x57, 0x50, 0x53, 0x43]; // 'WPSC'
const FORMAT_VERSION = 1;

interface LayerManifest {
  id: string;
  name: string;
  type: Layer['type'];
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: Layer['blendMode'];
  transform: Layer['transform'];
  parentId: string | null;
  childIds: string[];
  maskEnabled: boolean;
  clipped: boolean;
  text?: Layer['text'];
  shape?: Layer['shape'];
  gradient?: Layer['gradient'];
  adjustment?: Layer['adjustment'];
  fillColor?: Layer['fillColor'];
  pixelsWidth?: number;
  pixelsHeight?: number;
  pixelsBlob?: number;
  maskWidth?: number;
  maskHeight?: number;
  maskBlob?: number;
}

interface Manifest {
  version: number;
  checksum: number;
  /** FNV-1a over the canonical manifest JSON (with this field zeroed to
   * '00000000') concatenated with the binary section, as 8-char hex.
   * Added after red-team RT-1 proved the binary-only checksum let
   * same-length manifest edits (e.g. a renamed doc) load silently. */
  headerChecksum?: string;
  doc: {
    id: string;
    name: string;
    width: number;
    height: number;
    resolution: number;
    background: EditorDocument['background'];
    guides: EditorDocument['guides'];
    grid: EditorDocument['grid'];
    rootIds: string[];
    activeLayerId: string | null;
  };
  layers: LayerManifest[];
}

/** FNV-1a 32-bit hash. */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function validateDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 ||
    width > LIMITS.maxDimension || height > LIMITS.maxDimension
  ) {
    throw new ProjectError(
      'too-large',
      `Document dimensions ${width}x${height} exceed limit ${LIMITS.maxDimension}`,
    );
  }
}

export function serializeProject(doc: EditorDocument): Uint8Array {
  validateDimensions(doc.width, doc.height);
  const layerList = Object.values(doc.layers);
  if (layerList.length > LIMITS.maxLayers) {
    throw new ProjectError('too-many-layers', `Layer count ${layerList.length} exceeds ${LIMITS.maxLayers}`);
  }

  const blobs: Uint8Array[] = [];
  const layerManifests: LayerManifest[] = layerList.map((layer) => {
    const m: LayerManifest = {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      transform: { ...layer.transform },
      parentId: layer.parentId,
      childIds: [...layer.childIds],
      maskEnabled: layer.maskEnabled,
      clipped: layer.clipped,
    };
    if (layer.text !== undefined) m.text = layer.text;
    if (layer.shape !== undefined) m.shape = layer.shape;
    if (layer.gradient !== undefined) m.gradient = layer.gradient;
    if (layer.adjustment !== undefined) m.adjustment = layer.adjustment;
    if (layer.fillColor !== undefined) m.fillColor = layer.fillColor;
    if (layer.pixels !== undefined) {
      const expected = layer.pixels.width * layer.pixels.height * 4;
      if (layer.pixels.data.length !== expected) {
        throw new ProjectError('corrupt', `Layer ${layer.id} pixel buffer length mismatch`);
      }
      m.pixelsWidth = layer.pixels.width;
      m.pixelsHeight = layer.pixels.height;
      m.pixelsBlob = blobs.length;
      blobs.push(new Uint8Array(layer.pixels.data));
    }
    if (layer.mask !== undefined) {
      const expected = layer.mask.width * layer.mask.height;
      if (layer.mask.data.length !== expected) {
        throw new ProjectError('corrupt', `Layer ${layer.id} mask buffer length mismatch`);
      }
      m.maskWidth = layer.mask.width;
      m.maskHeight = layer.mask.height;
      m.maskBlob = blobs.length;
      blobs.push(new Uint8Array(layer.mask.data));
    }
    return m;
  });

  // Build binary section: length-prefixed blobs.
  let binaryLen = 0;
  for (const b of blobs) binaryLen += 4 + b.length;
  const binary = new Uint8Array(binaryLen);
  {
    const view = new DataView(binary.buffer);
    let off = 0;
    for (const b of blobs) {
      view.setUint32(off, b.length, true);
      off += 4;
      binary.set(b, off);
      off += b.length;
    }
  }

  const manifest: Manifest = {
    version: FORMAT_VERSION,
    checksum: fnv1a(binary),
    headerChecksum: '00000000',
    doc: {
      id: doc.id,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      resolution: doc.resolution,
      background: doc.background,
      guides: doc.guides,
      grid: doc.grid,
      rootIds: [...doc.rootIds],
      activeLayerId: doc.activeLayerId,
    },
    layers: layerManifests,
  };

  manifest.headerChecksum = headerChecksumOf(manifest, binary);
  const header = new TextEncoder().encode(JSON.stringify(manifest));
  const total = 8 + header.length + binary.length;
  if (total > LIMITS.maxProjectBytes) {
    throw new ProjectError('too-large', `Project size ${total} exceeds ${LIMITS.maxProjectBytes}`);
  }
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(binary, 8 + header.length);
  return out;
}

export function deserializeProject(bytes: Uint8Array): EditorDocument {
  if (bytes.length > LIMITS.maxProjectBytes) {
    throw new ProjectError('too-large', `Project size ${bytes.length} exceeds ${LIMITS.maxProjectBytes}`);
  }
  if (bytes.length < 8) {
    throw new ProjectError('corrupt', 'File too short');
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new ProjectError('corrupt', 'Bad magic — not a WPSC project');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  if (8 + headerLen > bytes.length) {
    throw new ProjectError('corrupt', 'Header length out of bounds');
  }

  let manifest: Manifest;
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(8, 8 + headerLen),
    );
    manifest = JSON.parse(json) as Manifest;
  } catch {
    throw new ProjectError('corrupt', 'Malformed manifest JSON');
  }
  if (manifest === null || typeof manifest !== 'object' || manifest.doc === undefined || !Array.isArray(manifest.layers)) {
    throw new ProjectError('corrupt', 'Manifest missing required sections');
  }
  if (manifest.version !== FORMAT_VERSION) {
    throw new ProjectError('unsupported-version', `Unsupported project version: ${String(manifest.version)}`);
  }

  const { doc } = manifest;
  validateDimensions(doc.width, doc.height);
  if (manifest.layers.length > LIMITS.maxLayers) {
    throw new ProjectError('too-many-layers', `Layer count ${manifest.layers.length} exceeds ${LIMITS.maxLayers}`);
  }

  const binary = bytes.subarray(8 + headerLen);
  if (fnv1a(binary) !== (manifest.checksum >>> 0)) {
    throw new ProjectError('checksum', 'Binary section checksum mismatch');
  }
  // Manifest integrity: files written by this version carry a header
  // checksum; when present it must verify. (Checked after version and
  // dimension limits so those errors keep their specific codes.)
  if (manifest.headerChecksum !== undefined && manifest.headerChecksum !== headerChecksumOf(manifest, binary)) {
    throw new ProjectError('checksum', 'Manifest header checksum mismatch');
  }
  validateGraph(manifest);

  // Parse length-prefixed blobs.
  const blobs: Uint8Array[] = [];
  {
    let off = 0;
    const bview = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
    while (off < binary.length) {
      if (off + 4 > binary.length) throw new ProjectError('corrupt', 'Truncated blob header');
      const len = bview.getUint32(off, true);
      off += 4;
      if (off + len > binary.length) throw new ProjectError('corrupt', 'Truncated blob data');
      blobs.push(binary.subarray(off, off + len));
      off += len;
    }
  }

  const layers: Record<string, Layer> = {};
  for (const m of manifest.layers) {
    if (typeof m.id !== 'string' || typeof m.name !== 'string' || typeof m.type !== 'string') {
      throw new ProjectError('corrupt', 'Layer manifest missing required fields');
    }
    const layer: Layer = {
      id: m.id,
      name: m.name,
      type: m.type,
      visible: m.visible,
      locked: m.locked,
      opacity: m.opacity,
      blendMode: m.blendMode,
      transform: m.transform,
      parentId: m.parentId,
      childIds: [...(m.childIds ?? [])],
      maskEnabled: m.maskEnabled,
      clipped: m.clipped,
    };
    if (m.text !== undefined) layer.text = m.text;
    if (m.shape !== undefined) layer.shape = m.shape;
    if (m.gradient !== undefined) layer.gradient = m.gradient;
    if (m.adjustment !== undefined) layer.adjustment = m.adjustment;
    if (m.fillColor !== undefined) layer.fillColor = m.fillColor;
    if (m.pixelsBlob !== undefined) {
      const blob = blobs[m.pixelsBlob];
      if (blob === undefined || m.pixelsWidth === undefined || m.pixelsHeight === undefined) {
        throw new ProjectError('corrupt', `Layer ${m.id} references missing pixel blob`);
      }
      validateDimensions(m.pixelsWidth, m.pixelsHeight);
      if (blob.length !== m.pixelsWidth * m.pixelsHeight * 4) {
        throw new ProjectError('corrupt', `Layer ${m.id} pixel blob length mismatch`);
      }
      const data = new Uint8ClampedArray(blob.length);
      data.set(blob);
      layer.pixels = { width: m.pixelsWidth, height: m.pixelsHeight, data };
    }
    if (m.maskBlob !== undefined) {
      const blob = blobs[m.maskBlob];
      if (blob === undefined || m.maskWidth === undefined || m.maskHeight === undefined) {
        throw new ProjectError('corrupt', `Layer ${m.id} references missing mask blob`);
      }
      validateDimensions(m.maskWidth, m.maskHeight);
      if (blob.length !== m.maskWidth * m.maskHeight) {
        throw new ProjectError('corrupt', `Layer ${m.id} mask blob length mismatch`);
      }
      const data = new Uint8Array(blob.length);
      data.set(blob);
      layer.mask = { width: m.maskWidth, height: m.maskHeight, data };
    }
    layers[layer.id] = layer;
  }

  return {
    id: doc.id,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    resolution: doc.resolution,
    background: doc.background,
    layers,
    rootIds: [...doc.rootIds],
    activeLayerId: doc.activeLayerId,
    guides: doc.guides,
    grid: doc.grid,
    version: FORMAT_VERSION,
  };
}

/** Base64 helpers for IndexedDB / localStorage storage. */
export function serializeProjectToBase64(doc: EditorDocument): string {
  const bytes = serializeProject(doc);
  let binaryStr = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binaryStr += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binaryStr);
}

export function deserializeProjectFromBase64(data: string): EditorDocument {
  let binaryStr: string;
  try {
    binaryStr = atob(data);
  } catch {
    throw new ProjectError('corrupt', 'Invalid base64 project data');
  }
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return deserializeProject(bytes);
}
