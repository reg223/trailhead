import { openDB, type DBSchema } from 'idb';

export interface TrailheadSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface TrailheadEntry {
  id: string;
  sessionId: string;
  url: string;
  text: string;
  note: string;
  citation: string;
  needsCitation: boolean;
  keywords: string[];
  timestamp: number;
  updatedAt: number;
}

export interface TrailheadDB extends DBSchema {
  sessions: {
    key: string;
    value: TrailheadSession;
  };
  entries: {
    key: string;
    value: TrailheadEntry;
    indexes: { 'by-session': string };
  };
}

export const DEFAULT_SESSION_ID = 'default-session';
export const NOTE_LIMIT = 150;

export const dbPromise = openDB<TrailheadDB>('trailhead-db', 4, {
  upgrade(db, _oldVersion, _newVersion, transaction) {
    if (!db.objectStoreNames.contains('sessions')) {
      db.createObjectStore('sessions', { keyPath: 'id' });
    }

    if (!db.objectStoreNames.contains('entries')) {
      const entryStore = db.createObjectStore('entries', { keyPath: 'id' });
      entryStore.createIndex('by-session', 'sessionId');
    } else {
      const entryStore = transaction.objectStore('entries');
      if (!entryStore.indexNames.contains('by-session')) {
        entryStore.createIndex('by-session', 'sessionId');
      }
    }
  },
});

export async function ensureDefaultSession() {
  const db = await dbPromise;
  const existingSession = await db.get('sessions', DEFAULT_SESSION_ID);

  if (existingSession) {
    const normalizedSession: TrailheadSession = {
      ...existingSession,
      updatedAt: existingSession.updatedAt ?? existingSession.createdAt ?? Date.now(),
    };

    if (normalizedSession.updatedAt !== existingSession.updatedAt) {
      await db.put('sessions', normalizedSession);
    }

    return normalizedSession;
  }

  const now = Date.now();
  const session: TrailheadSession = {
    id: DEFAULT_SESSION_ID,
    title: 'Inbox',
    createdAt: now,
    updatedAt: now,
  };

  await db.put('sessions', session);
  return session;
}
