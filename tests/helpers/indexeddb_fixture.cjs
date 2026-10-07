"use strict";

// Browser API boundary for the existing VM save tests. Real IndexedDB
// transactions, structured cloning and crash recovery run in Chromium tests.
function indexedDBFixture() {
  const stores = new Map();
  const db = {
    close() {},
    transaction(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const rows = stores.get(name);
      return {
        objectStore: () => ({
          get: (key) => ({ result: rows.get(key) }),
          put: (row) => { const key = row.saveToken || row.key; rows.set(key, { ...row }); return { result: key }; },
          delete: (key) => { rows.delete(key); return {}; },
        }),
        set oncomplete(callback) { queueMicrotask(callback); },
      };
    },
  };
  return { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } };
}

module.exports = { indexedDBFixture };
