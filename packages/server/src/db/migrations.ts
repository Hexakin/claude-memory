import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 1;

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    content TEXT NOT NULL,
    source TEXT,
    project_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (memory_id, tag_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag_id);

  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    token_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(memory_id, chunk_index)
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_memory ON chunks(memory_id);

  CREATE TABLE IF NOT EXISTS embedding_cache (
    text_hash TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    model_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    description TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'custom',
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 0,
    project_id TEXT,
    repo_url TEXT,
    scheduled_for TEXT,
    started_at TEXT,
    completed_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 1,
    timeout_ms INTEGER NOT NULL DEFAULT 1800000,
    context TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_for);

  CREATE TABLE IF NOT EXISTS task_results (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    output TEXT NOT NULL,
    summary TEXT,
    success INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    duration_ms INTEGER,
    tokens_used INTEGER,
    cost_usd REAL,
    memory_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(task_id);
`;

const VEC_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
    chunk_id TEXT PRIMARY KEY,
    embedding float[768]
  );
`;

const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    chunk_id UNINDEXED,
    memory_id UNINDEXED,
    tokenize='porter unicode61'
  );
`;

/**
 * Run all schema migrations.
 * Forward-only: checks schema_version in meta table and applies new statements.
 */
export function runMigrations(db: Database.Database, vecAvailable: boolean): void {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Check current schema version
  const version = getSchemaVersion(db);

  if (version < 1) {
    applyV1(db, vecAvailable);
  }

  // Future migrations would go here:
  // if (version < 2) { applyV2(db); }
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    // meta table does not exist yet
    return 0;
  }
}

function applyV1(db: Database.Database, vecAvailable: boolean): void {
  db.exec(BASE_SCHEMA);

  if (vecAvailable) {
    db.exec(VEC_SCHEMA);
  }

  db.exec(FTS_SCHEMA);

  // Store schema version
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
  ).run(String(CURRENT_SCHEMA_VERSION));
}
