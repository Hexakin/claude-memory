import type Database from 'better-sqlite3';

/**
 * Ensure a tag exists and return its ID.
 * Inserts if not present, then selects the ID.
 */
export function ensureTag(db: Database.Database, name: string): number {
  db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
  const row = db
    .prepare('SELECT id FROM tags WHERE name = ?')
    .get(name) as { id: number };
  return row.id;
}

/**
 * Set the tags for a memory, replacing any existing tags.
 * Deletes all existing junction rows and inserts new ones.
 */
export function setMemoryTags(
  db: Database.Database,
  memoryId: string,
  tagNames: string[],
): void {
  const setTags = db.transaction(() => {
    // Remove existing tags for this memory
    db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(memoryId);

    if (tagNames.length === 0) return;

    // Ensure all tags exist and insert junction rows
    const insertJunction = db.prepare(
      'INSERT OR IGNORE INTO memory_tags (memory_id, tag_id) VALUES (?, ?)',
    );

    for (const name of tagNames) {
      const tagId = ensureTag(db, name);
      insertJunction.run(memoryId, tagId);
    }
  });

  setTags();
}

/**
 * Get all tag names for a single memory.
 */
export function getTagsForMemory(
  db: Database.Database,
  memoryId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT t.name
       FROM memory_tags mt
       JOIN tags t ON mt.tag_id = t.id
       WHERE mt.memory_id = ?`,
    )
    .all(memoryId) as Array<{ name: string }>;

  return rows.map((r) => r.name);
}

/**
 * Batch fetch tags for multiple memories (avoids N+1 queries).
 * Returns a Map from memoryId to array of tag names.
 */
export function getTagsForMemories(
  db: Database.Database,
  memoryIds: string[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (memoryIds.length === 0) return result;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT mt.memory_id, t.name
       FROM memory_tags mt
       JOIN tags t ON mt.tag_id = t.id
       WHERE mt.memory_id IN (${placeholders})`,
    )
    .all(...memoryIds) as Array<{ memory_id: string; name: string }>;

  for (const row of rows) {
    const existing = result.get(row.memory_id);
    if (existing) {
      existing.push(row.name);
    } else {
      result.set(row.memory_id, [row.name]);
    }
  }

  return result;
}
