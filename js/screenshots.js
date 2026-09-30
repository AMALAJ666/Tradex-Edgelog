(() => {
  'use strict';

  const DB_NAME = 'edgelog';
  const DB_VERSION = 1;
  const STORE = 'screenshots';

  let dbPromise = null;

  class ScreenshotError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new ScreenshotError('unsupported', 'This browser does not support local image storage.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('journalId', 'journalId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new ScreenshotError('open-failed', 'Local image storage could not be opened.'));
      request.onblocked = () => reject(new ScreenshotError('blocked', 'Close other tabs of this app and try again.'));
    });
    return dbPromise;
  }

  async function run(mode, work) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result;
      try {
        result = work(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result?.value !== undefined ? result.value : result);
      transaction.onabort = () => {
        const error = transaction.error;
        if (error?.name === 'QuotaExceededError') reject(new ScreenshotError('quota', 'Not enough local storage space for this screenshot. Remove some images or export and clear old journals.'));
        else reject(new ScreenshotError('write-failed', 'The screenshot could not be saved locally.'));
      };
      transaction.onerror = () => { /* surfaced by onabort */ };
    });
  }

  function requestValue(request) {
    const box = { value: undefined };
    request.onsuccess = () => { box.value = request.result; };
    return box;
  }

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `shot-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function isReference(value) {
    return typeof value === 'string' && value.startsWith('shot-');
  }

  function isLegacyDataUrl(value) {
    return typeof value === 'string' && value.startsWith('data:');
  }

  async function put(journalId, slot, blob) {
    return putWithId(newId(), journalId, slot, blob);
  }

  async function putWithId(id, journalId, slot, blob) {
    const record = {
      id,
      journalId,
      slot,
      blob,
      mimeType: blob.type || 'image/png',
      size: blob.size,
      createdAt: new Date().toISOString()
    };
    await run('readwrite', (store) => store.put(record));
    return record.id;
  }

  async function get(id) {
    if (!isReference(id)) return null;
    return run('readonly', (store) => requestValue(store.get(id)));
  }

  async function remove(id) {
    if (!isReference(id)) return;
    await run('readwrite', (store) => store.delete(id));
  }

  async function list() {
    return (await run('readonly', (store) => requestValue(store.getAll()))) || [];
  }

  async function clear() {
    await run('readwrite', (store) => store.clear());
  }

  // Deletes stored images no longer referenced by any journal.
  async function pruneOrphans(journals) {
    const referenced = new Set();
    journals.forEach((journal) => {
      Object.values(journal.screenshots || {}).forEach((value) => { if (isReference(value)) referenced.add(value); });
    });
    const stored = await list();
    const orphans = stored.filter((record) => !referenced.has(record.id));
    if (!orphans.length) return 0;
    await run('readwrite', (store) => orphans.forEach((record) => store.delete(record.id)));
    return orphans.length;
  }

  function dataUrlToBlob(dataUrl) {
    const [header, encoded] = dataUrl.split(',');
    const mimeType = header.slice(header.indexOf(':') + 1, header.indexOf(';')) || 'image/png';
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new ScreenshotError('read-failed', 'A stored screenshot could not be read.'));
      reader.readAsDataURL(blob);
    });
  }

  async function estimate() {
    if (!navigator.storage?.estimate) return null;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota, percent: quota ? (usage / quota) * 100 : 0 };
    } catch {
      return null;
    }
  }

  async function requestPersistence() {
    if (!navigator.storage?.persist) return false;
    try {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }

  window.ScreenshotStore = Object.freeze({
    put,
    putWithId,
    get,
    remove,
    list,
    clear,
    pruneOrphans,
    estimate,
    requestPersistence,
    dataUrlToBlob,
    blobToDataUrl,
    isReference,
    isLegacyDataUrl,
    ScreenshotError
  });
})();
