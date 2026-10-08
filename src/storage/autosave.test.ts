import { describe, expect, it } from 'vitest';
import type { EditorDocument } from '../core/contracts';
import {
  IndexedDbAutosaveStore,
  MemoryAutosaveStore,
  makeRecoveryRecord,
  type RecoveryRecord,
} from './autosave';
import { deserializeProjectFromBase64 } from './project';

function minimalDoc(): EditorDocument {
  return {
    id: 'doc-min',
    name: 'Autosave Doc',
    width: 2,
    height: 2,
    resolution: 72,
    background: { r: 0, g: 0, b: 0, a: 255 },
    layers: {},
    rootIds: [],
    activeLayerId: null,
    guides: [],
    grid: { visible: false, spacing: 10, snap: false },
    version: 1,
  };
}

describe('MemoryAutosaveStore', () => {
  it('loads null when empty', async () => {
    const store = new MemoryAutosaveStore();
    await expect(store.load()).resolves.toBeNull();
  });

  it('saves, loads and clears a record', async () => {
    const store = new MemoryAutosaveStore();
    const record: RecoveryRecord = { savedAt: 123, docName: 'X', dataB64: 'AAAA' };
    await store.save(record);
    await expect(store.load()).resolves.toEqual(record);
    await store.clear();
    await expect(store.load()).resolves.toBeNull();
  });
});

describe('makeRecoveryRecord', () => {
  it('captures doc name, timestamp and a restorable payload', () => {
    const doc = minimalDoc();
    const before = Date.now();
    const record = makeRecoveryRecord(doc);
    expect(record.docName).toBe('Autosave Doc');
    expect(record.savedAt).toBeGreaterThanOrEqual(before);
    expect(deserializeProjectFromBase64(record.dataB64)).toEqual(doc);
  });

  it('roundtrips through MemoryAutosaveStore', async () => {
    const doc = minimalDoc();
    const store = new MemoryAutosaveStore();
    await store.save(makeRecoveryRecord(doc));
    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(deserializeProjectFromBase64(loaded!.dataB64)).toEqual(doc);
  });
});

describe('IndexedDbAutosaveStore', () => {
  it('rejects with indexeddb-unavailable when IndexedDB is missing', async () => {
    // Vitest runs in Node here, where globalThis.indexedDB is undefined.
    if ((globalThis as { indexedDB?: unknown }).indexedDB !== undefined) return;
    const store = new IndexedDbAutosaveStore();
    await expect(store.load()).rejects.toThrow('indexeddb-unavailable');
    await expect(store.save({ savedAt: 1, docName: 'x', dataB64: '' })).rejects.toThrow(
      'indexeddb-unavailable',
    );
    await expect(store.clear()).rejects.toThrow('indexeddb-unavailable');
  });
});
