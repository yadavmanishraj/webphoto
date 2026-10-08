/**
 * SHARED CONTRACTS — the single source of truth for all workstreams.
 * Agents must NOT change this file without lead approval. All pixel data is
 * NON-premultiplied RGBA, row-major, Uint8ClampedArray, length = w*h*4.
 * Selection/mask data is single-channel Uint8Array (0..255 coverage), length = w*h.
 */
export type ID = string;
export const newId = (): ID =>
  'id-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36);

export interface RGBA { r: number; g: number; b: number; a: number } // each 0..255

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light'
  | 'difference' | 'exclusion';

export const BLEND_MODES: BlendMode[] = [
  'normal','multiply','screen','overlay','darken','lighten',
  'color-dodge','color-burn','hard-light','soft-light','difference','exclusion',
];

export interface Transform2D {
  x: number; y: number;          // translation in document px
  scaleX: number; scaleY: number;
  rotationDeg: number;
}
export const identityTransform = (): Transform2D =>
  ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotationDeg: 0 });

export interface PixelBuffer { width: number; height: number; data: Uint8ClampedArray }
export interface MaskBuffer { width: number; height: number; data: Uint8Array }

export type LayerType = 'raster' | 'group' | 'text' | 'shape' | 'adjustment' | 'fill';

export interface TextData {
  text: string; fontFamily: string; fontSize: number; fontWeight: number;
  italic: boolean; align: 'left' | 'center' | 'right';
  color: RGBA; lineHeight: number; letterSpacing: number;
}
export type ShapeKind = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'polygon' | 'line';
export interface ShapeData {
  kind: ShapeKind; w: number; h: number; cornerRadius: number; sides: number;
  fill: RGBA | null; stroke: RGBA | null; strokeWidth: number;
}
export interface GradientStop { offset: number; color: RGBA }
export interface GradientData {
  kind: 'linear' | 'radial'; angleDeg: number; stops: GradientStop[]; reverse: boolean;
}
export type AdjustmentKind =
  | 'brightness-contrast' | 'hue-saturation' | 'levels' | 'invert'
  | 'grayscale' | 'posterize' | 'threshold' | 'gamma' | 'color-balance';
export interface AdjustmentData { kind: AdjustmentKind; params: Record<string, number> }

export interface Layer {
  id: ID; name: string; type: LayerType;
  visible: boolean; locked: boolean;
  opacity: number;            // 0..1
  blendMode: BlendMode;
  transform: Transform2D;
  parentId: ID | null;
  childIds: ID[];             // groups only, top-most first
  pixels?: PixelBuffer;       // raster only
  mask?: MaskBuffer;          // any layer; white=revealed
  maskEnabled: boolean;
  text?: TextData; shape?: ShapeData; gradient?: GradientData;
  adjustment?: AdjustmentData;
  fillColor?: RGBA;           // fill layers
  clipped: boolean;
}

export interface Guide { orientation: 'h' | 'v'; position: number }
export interface EditorDocument {
  id: ID; name: string;
  width: number; height: number; resolution: number;
  background: RGBA;
  layers: Record<ID, Layer>;
  rootIds: ID[];              // top-level order, top-most first
  activeLayerId: ID | null;
  guides: Guide[];
  grid: { visible: boolean; spacing: number; snap: boolean };
  version: number;            // project format version = 1
}

export interface Selection {
  width: number; height: number;
  mask: Uint8Array;           // 0..255 coverage, document-sized
}
export const emptySelection = (w: number, h: number): Selection =>
  ({ width: w, height: h, mask: new Uint8Array(w * h) });
export const fullSelection = (w: number, h: number): Selection =>
  ({ width: w, height: h, mask: new Uint8Array(w * h).fill(255) });

/** Command contract: every mutating operation goes through this. */
export interface Command {
  label: string;
  do(doc: EditorDocument): void;
  undo(doc: EditorDocument): void;
}

/** Resource limits (prompt §113) */
export const LIMITS = {
  maxDimension: 8192,
  maxLayers: 500,
  maxHistoryEntries: 100,
  maxImportBytes: 100 * 1024 * 1024,
  maxProjectBytes: 500 * 1024 * 1024,
} as const;
