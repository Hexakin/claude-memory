import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export type { Database } from 'better-sqlite3';

const connections = new Map<string, Database.Database>();
let vecAvailable = false;

const esmRequire = createRequire(import.meta.url);

function loadVecExtension(db: Database.Database): void {
  try {
    const sqliteVec = esmRequire('sqlite-vec');
    sqliteVec.load(db);
    vecAvailable = true;
  } catch {
    console.warn(
      '[claude-memory] sqlite-vec extension not available — vector search disabled, falling back to FTS-only',
    );
    vecAvailable = false;
  }
}

/**
 * Open or return a cached SQLite connection.
 * Enables WAL mode and attempts to load sqlite-vec on first open.
 */
export function getDatabase(dbPath: string): Database.Database {
  const existing = connections.get(dbPath);
  if (existing) return existing;

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Attempt to load sqlite-vec extension
  loadVecExtension(db);

  connections.set(dbPath, db);
  return db;
}

/**
 * Check whether the sqlite-vec extension loaded successfully.
 */
export function isVecAvailable(): boolean {
  return vecAvailable;
}

/**
 * Get the global database instance.
 * Located at {dataDir}/global.db
 */
export function getGlobalDb(dataDir: string): Database.Database {
  const dbPath = join(dataDir, 'global.db');
  return getDatabase(dbPath);
}

/**
 * Get a per-project database instance.
 * Located at {dataDir}/projects/{projectId}.db
 */
export function getProjectDb(dataDir: string, projectId: string): Database.Database {
  const dbPath = join(dataDir, 'projects', projectId, 'project.db');
  return getDatabase(dbPath);
}

/**
 * Close all cached database connections.
 */
export function closeAll(): void {
  for (const [path, db] of connections) {
    try {
      db.close();
    } catch {
      // Ignore close errors during shutdown
    }
    connections.delete(path);
  }
}
