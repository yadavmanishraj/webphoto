/**
 * Autosave / crash recovery (prompt §36/§111).
 * Records are opaque to the store: the project is serialized with the
 * WPSC format and base64-encoded so it can live in IndexedDB or
 * localStorage. Stores never block on huge synchronous work beyond the
 * serialization itself.
 */
import type { EditorDocument } from '../core/contracts';
import { serializeProjectToBase64 } from './project';

export interface RecoveryRecord {
  savedAt: number;
  docName: string;
  dataB64: string;
}

export interface AutosaveStore {
  save(r: RecoveryRecord): Promise<void>;
  load(): Promise<RecoveryRecord | null>;
  clear(): Promise<void>;
}

export function makeRecoveryRecord(doc: EditorDocument): RecoveryRecord {
  return {
    savedAt: Date.now(),
    docName: doc.name,
    dataB64: serializeProjectToBase64(doc),
  };
}

/** In-memory store — tests, non-persistent fallback. */
export class MemoryAutosaveStore implements AutosaveStore {
  private record: RecoveryRecord | null = null;

  async save(r: RecoveryRecord): Promise<void> {
    this.record = { ...r };
  }

  async load(): Promise<RecoveryRecord | null> {
    return this.record === null ? null : { ...this.record };
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

const DB_NAME = 'wps-clone';
const STORE_NAME = 'recovery';
const RECORD_KEY = 'current';

function requireIndexedDb(): IDBFactory {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (idb === undefined) {
    throw new Error('indexeddb-unavailable');
  }
  return idb;
}

function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb-open-failed'));
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb-request-failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb-transaction-failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb-transaction-aborted'));
  });
}

/** IndexedDB-backed store: db 'wps-clone', store 'recovery', key 'current'. */
export class IndexedDbAutosaveStore implements AutosaveStore {
  async save(r: RecoveryRecord): Promise<void> {
    const idb = requireIndexedDb();
    const db = await openDb(idb);
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(STORE_NAME).put({ ...r }, RECORD_KEY);
      await done;
    } finally {
      db.close();
    }
  }

  async load(): Promise<RecoveryRecord | null> {
    const idb = requireIndexedDb();
    const db = await openDb(idb);
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const result = await requestToPromise(
        tx.objectStore(STORE_NAME).get(RECORD_KEY) as IDBRequest<RecoveryRecord | undefined>,
      );
      return result ?? null;
    } finally {
      db.close();
    }
  }

  async clear(): Promise<void> {
    const idb = requireIndexedDb();
    const db = await openDb(idb);
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const done = transactionDone(tx);
      tx.objectStore(STORE_NAME).delete(RECORD_KEY);
      await done;
    } finally {
      db.close();
    }
  }
}
