import type Database from 'better-sqlite3';
import type { Memory } from '@claude-memory/shared';
import { getTagsForMemory, getTagsForMemories } from './tag-repo.js';

interface CreateMemoryInput {
  content: string;
  source?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

interface ListMemoriesFilters {
  projectId?: string;
  tag?: string;
  source?: string;
  since?: string;
  limit: number;
  offset: number;
}

interface ListMemoriesResult {
  memories: Memory[];
  total: number;
}

interface MemoryRow {
  id: string;
  content: string;
  source: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
  metadata: string;
}

function rowToMemory(row: MemoryRow, tags: string[]): Memory {
  return {
    id: row.id,
    content: row.content,
    source: row.source as Memory['source'],
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
    tags,
  };
}

/**
 * Create a new memory and return it.
 */
export function createMemory(db: Database.Database, input: CreateMemoryInput): Memory {
  const stmt = db.prepare(`
    INSERT INTO memories (content, source, project_id, metadata)
    VALUES (?, ?, ?, ?)
    RETURNING id, content, source, project_id, created_at, updated_at, last_accessed_at, access_count, metadata
  `);

  const row = stmt.get(
    input.content,
    input.source ?? null,
    input.projectId ?? null,
    JSON.stringify(input.metadata ?? {}),
  ) as MemoryRow;

  return rowToMemory(row, []);
}

/**
 * Get a memory by ID, incrementing access count and updating last access time.
 * Returns null if not found.
 */
export function getMemoryById(db: Database.Database, id: string): Memory | null {
  // Update access tracking
  updateAccessTime(db, id);

  const row = db
    .prepare(
      `SELECT id, content, source, project_id, created_at, updated_at, last_accessed_at, access_count, metadata
       FROM memories WHERE id = ?`,
    )
    .get(id) as MemoryRow | undefined;

  if (!row) return null;

  const tags = getTagsForMemory(db, id);
  return rowToMemory(row, tags);
}

/**
 * List memories with optional filters and pagination.
 */
export function listMemories(
  db: Database.Database,
  filters: ListMemoriesFilters,
): ListMemoriesResult {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let joinClause = '';

  if (filters.projectId) {
    conditions.push('m.project_id = ?');
    params.push(filters.projectId);
  }

  if (filters.source) {
    conditions.push('m.source = ?');
    params.push(filters.source);
  }

  if (filters.since) {
    conditions.push('m.created_at >= ?');
    params.push(filters.since);
  }

  if (filters.tag) {
    joinClause =
      'JOIN memory_tags mt ON m.id = mt.memory_id JOIN tags t ON mt.tag_id = t.id';
    conditions.push('t.name = ?');
    params.push(filters.tag);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countRow = db
    .prepare(
      `SELECT COUNT(DISTINCT m.id) as total FROM memories m ${joinClause} ${whereClause}`,
    )
    .get(...params) as { total: number };

  // Get paginated results
  const rows = db
    .prepare(
      `SELECT DISTINCT m.id, m.content, m.source, m.project_id, m.created_at, m.updated_at,
              m.last_accessed_at, m.access_count, m.metadata
       FROM memories m ${joinClause} ${whereClause}
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as MemoryRow[];

  // Batch-fetch tags for all returned memories
  const memoryIds = rows.map((r) => r.id);
  const tagsMap = getTagsForMemories(db, memoryIds);

  const memories = rows.map((row) =>
    rowToMemory(row, tagsMap.get(row.id) ?? []),
  );

  return { memories, total: countRow.total };
}

/**
 * Delete a memory by ID. Returns true if a row was deleted.
 * Cascades to chunks and memory_tags via ON DELETE CASCADE.
 * Virtual tables (chunks_vec, chunks_fts) must be cleaned manually.
 */
export function deleteMemory(
  db: Database.Database,
  id: string,
  vecAvailable: boolean,
): boolean {
  // Get chunk IDs before deleting (for virtual table cleanup)
  const chunkIds = db
    .prepare('SELECT id FROM chunks WHERE memory_id = ?')
    .all(id) as Array<{ id: string }>;

  if (chunkIds.length > 0) {
    const deleteVirtualTables = db.transaction(() => {
      for (const chunk of chunkIds) {
        if (vecAvailable) {
          db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(chunk.id);
        }
        db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.id);
      }
    });
    deleteVirtualTables();
  }

  // Delete the memory (cascades to chunks, memory_tags)
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Update last_accessed_at and increment access_count for a memory.
 */
export function updateAccessTime(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE memories
     SET last_accessed_at = datetime('now'),
         access_count = access_count + 1
     WHERE id = ?`,
  ).run(id);
}

