import { describe, expect, it } from 'vitest';
import {
  identityTransform,
  type EditorDocument,
  type Layer,
} from '../core/contracts';
import {
  ProjectError,
  deserializeProject,
  deserializeProjectFromBase64,
  serializeProject,
  serializeProjectToBase64,
} from './project';

function rasterLayer(id: string, parentId: string | null, seed: number): Layer {
  const data = new Uint8ClampedArray(4 * 3 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (seed + i * 7) % 256;
  return {
    id,
    name: `Raster ${id}`,
    type: 'raster',
    visible: true,
    locked: false,
    opacity: 0.75,
    blendMode: 'multiply',
    transform: identityTransform(),
    parentId,
    childIds: [],
    pixels: { width: 4, height: 3, data },
    maskEnabled: false,
    clipped: false,
  };
}

function buildDoc(): EditorDocument {
  const bg = rasterLayer('layer-bg', null, 3);
  const fg = rasterLayer('layer-fg', 'group-1', 91);
  // Distinct mask values on the foreground layer.
  const maskData = new Uint8Array(4 * 3);
  for (let i = 0; i < maskData.length; i++) maskData[i] = 255 - i * 13;
  fg.mask = { width: 4, height: 3, data: maskData };
  fg.maskEnabled = true;

  const group: Layer = {
    id: 'group-1',
    name: 'Group 1',
    type: 'group',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: identityTransform(),
    parentId: null,
    childIds: ['layer-fg', 'layer-text'],
    maskEnabled: false,
    clipped: false,
  };
  const text: Layer = {
    id: 'layer-text',
    name: 'Headline',
    type: 'text',
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal',
    transform: { x: 5, y: 6, scaleX: 1, scaleY: 1, rotationDeg: 0 },
    parentId: 'group-1',
    childIds: [],
    maskEnabled: false,
    clipped: false,
    text: {
      text: 'Hello World',
      fontFamily: 'Inter',
      fontSize: 24,
      fontWeight: 700,
      italic: false,
      align: 'left',
      color: { r: 10, g: 20, b: 30, a: 255 },
      lineHeight: 1.2,
      letterSpacing: 0.5,
    },
  };

  return {
    id: 'doc-1',
    name: 'Test Doc',
    width: 4,
    height: 3,
    resolution: 72,
    background: { r: 255, g: 255, b: 255, a: 255 },
    layers: {
      'layer-bg': bg,
      'group-1': group,
      'layer-fg': fg,
      'layer-text': text,
    },
    rootIds: ['group-1', 'layer-bg'],
    activeLayerId: 'layer-fg',
    guides: [{ orientation: 'v', position: 2 }],
    grid: { visible: true, spacing: 8, snap: false },
    version: 1,
  };
}

describe('project format', () => {
  it('roundtrips a full document with structure and pixel bytes intact', () => {
    const doc = buildDoc();
    const bytes = serializeProject(doc);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // Magic 'WPSC'
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x57, 0x50, 0x53, 0x43]);

    const restored = deserializeProject(bytes);
    expect(restored).toEqual(doc);
    expect(Array.from(restored.layers['layer-bg']!.pixels!.data)).toEqual(
      Array.from(doc.layers['layer-bg']!.pixels!.data),
    );
    expect(Array.from(restored.layers['layer-fg']!.pixels!.data)).toEqual(
      Array.from(doc.layers['layer-fg']!.pixels!.data),
    );
    expect(Array.from(restored.layers['layer-fg']!.mask!.data)).toEqual(
      Array.from(doc.layers['layer-fg']!.mask!.data),
    );
    // Nested group relationships survive.
    expect(restored.layers['group-1']!.childIds).toEqual(['layer-fg', 'layer-text']);
    expect(restored.layers['layer-text']!.parentId).toBe('group-1');
    expect(restored.rootIds).toEqual(['group-1', 'layer-bg']);
    expect(restored.layers['layer-text']!.text?.text).toBe('Hello World');
  });

  it('roundtrips through the base64 helpers', () => {
    const doc = buildDoc();
    const b64 = serializeProjectToBase64(doc);
    expect(typeof b64).toBe('string');
    expect(deserializeProjectFromBase64(b64)).toEqual(doc);
  });

  it('rejects a corrupted binary section with a checksum error', () => {
    const bytes = serializeProject(buildDoc());
    const corrupted = new Uint8Array(bytes);
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
    let caught: unknown;
    try {
      deserializeProject(corrupted);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectError);
    expect((caught as ProjectError).code).toBe('checksum');
  });

  it('rejects wrong magic with a ProjectError', () => {
    const bytes = serializeProject(buildDoc());
    const bad = new Uint8Array(bytes);
    bad[0] = 0x00;
    expect(() => deserializeProject(bad)).toThrow(ProjectError);
  });

  it('rejects an unsupported manifest version', () => {
    const bytes = serializeProject(buildDoc());
    const headerLen = new DataView(bytes.buffer).getUint32(4, true);
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes.subarray(8, 8 + headerLen)),
    ) as Record<string, unknown>;
    manifest.version = 99;
    const header = new TextEncoder().encode(JSON.stringify(manifest));
    const rebuilt = new Uint8Array(8 + header.length + (bytes.length - 8 - headerLen));
    rebuilt.set(bytes.subarray(0, 4), 0);
    new DataView(rebuilt.buffer).setUint32(4, header.length, true);
    rebuilt.set(header, 8);
    rebuilt.set(bytes.subarray(8 + headerLen), 8 + header.length);

    let caught: unknown;
    try {
      deserializeProject(rebuilt);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectError);
    expect((caught as ProjectError).code).toBe('unsupported-version');
  });

  it('rejects malformed manifest JSON as corrupt', () => {
    const bytes = serializeProject(buildDoc());
    const bad = new Uint8Array(bytes);
    bad[8] = 0x21; // '!' — breaks the leading '{'
    let caught: unknown;
    try {
      deserializeProject(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectError);
    expect((caught as ProjectError).code).toBe('corrupt');
  });

  it('rejects oversized documents on write', () => {
    const doc = buildDoc();
    doc.width = 9000;
    expect(() => serializeProject(doc)).toThrow(ProjectError);
  });
});
