const DB_NAME = 'redview-tile-cache';
const DB_VERSION = 1;
const STORE_NAME = 'ign-bil-tiles';
const SESSION_KEY = 'redview-session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ---------------------------------------------------------------------------
// Session tracking (12h window)
// ---------------------------------------------------------------------------

interface SessionData {
  id: string;
  createdAt: number;
}

function getSession(): SessionData {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const session: SessionData = JSON.parse(raw);
      if (Date.now() - session.createdAt < SESSION_TTL_MS) {
        return session;
      }
    }
  } catch { /* corrupted, create new */ }

  const session: SessionData = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function getSessionId(): string {
  return getSession().id;
}

// ---------------------------------------------------------------------------
// IndexedDB tile cache
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

interface CachedTile {
  key: string;
  sessionId: string;
  timestamp: number;
  data: ArrayBuffer;
}

export async function getCachedTile(key: string): Promise<Float32Array | null> {
  try {
    const db = await openDB();
    const session = getSession();

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result as CachedTile | undefined;
        if (!result) {
          resolve(null);
          return;
        }
        // Only use cache from current 12h session
        if (result.sessionId !== session.id) {
          resolve(null);
          return;
        }
        resolve(new Float32Array(result.data));
      };

      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedTile(key: string, data: Float32Array): Promise<void> {
  try {
    const db = await openDB();
    const session = getSession();

    const entry: CachedTile = {
      key,
      sessionId: session.id,
      timestamp: Date.now(),
      data: data.buffer.slice(0) as ArrayBuffer,
    };

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Cache write failure is non-critical
  }
}

export async function clearExpiredSessions(): Promise<void> {
  try {
    const db = await openDB();
    const currentSession = getSession();

    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('sessionId');
      const request = index.openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const entry = cursor.value as CachedTile;
        if (entry.sessionId !== currentSession.id) {
          cursor.delete();
        }
        cursor.continue();
      };

      request.onerror = () => resolve();
    });
  } catch {
    // Non-critical
  }
}
