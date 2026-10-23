import { StrategyRecord } from './models';

const DB_NAME = 'strategy-maker';
const STORE = 'strategies';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  all: () => run<StrategyRecord[]>('readonly', (s) => s.getAll()),
  get: (id: string) => run<StrategyRecord | undefined>('readonly', (s) => s.get(id)),
  put: (rec: StrategyRecord) => run('readwrite', (s) => s.put(rec)),
  delete: (id: string) => run('readwrite', (s) => s.delete(id)),
};
