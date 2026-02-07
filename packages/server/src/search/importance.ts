import type Database from 'better-sqlite3';

interface MemoryForImportance {
  source: string | null;
  memoryType: string;
  lastAccessedAt: string;
  accessCount: number;
  isRule: boolean;
}

/**
 * Calculate importance score for a single memory.
 *
 * Formula: importance = source_weight * type_weight * recency_factor * access_factor
 *
 * - source_weight: Based on memory source (user=1.0, extraction=0.7, etc.)
 * - type_weight: Based on memory type (rule=1.0, mistake=0.9, etc.)
 * - recency_factor: Exponential decay with 30-day half-life
 * - access_factor: Logarithmic scale based on access_count
 *
 * Final importance is clamped to [0.0, 1.0].
 * Rules (isRule=true) are always >= 0.9.
 */
export function calculateImportance(memory: {
  source: string | null;
  memoryType: string;
  lastAccessedAt: string;
  accessCount: number;
  isRule: boolean;
}): number {
  // Source weights
  const sourceWeights: Record<string, number> = {
    user: 1.0,
    consolidation: 0.8,
    extraction: 0.7,
    'session-summary': 0.6,
    automation: 0.5,
    hook: 0.5,
  };
  const sourceWeight = memory.source ? sourceWeights[memory.source] ?? 0.5 : 0.5;

  // Type weights
  const typeWeights: Record<string, number> = {
    rule: 1.0,
    mistake: 0.9,
    learning: 0.8,
    preference: 0.7,
    objective: 0.7,
    general: 0.6,
    episode: 0.5,
  };
  const typeWeight = typeWeights[memory.memoryType] ?? 0.5;

  // Recency factor: exponential decay with 30-day half-life
  const lastAccessTime = new Date(memory.lastAccessedAt).getTime();
  const now = Date.now();
  const daysSinceLastAccess = (now - lastAccessTime) / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.max(0.1, Math.min(1.0, Math.pow(0.5, daysSinceLastAccess / 30)));

  // Access factor: logarithmic scale
  const accessFactor = Math.min(1.0, 0.5 + 0.1 * Math.log2(1 + memory.accessCount));

  // Calculate final importance
  let importance = sourceWeight * typeWeight * recencyFactor * accessFactor;

  // Clamp to [0.0, 1.0]
  importance = Math.max(0.0, Math.min(1.0, importance));

  // Rules are always >= 0.9
  if (memory.isRule) {
    importance = Math.max(0.9, importance);
  }

  return importance;
}

/**
 * Recalculate importance scores for all memories in a database.
 *
 * Updates the importance_score column for all memories based on their
 * current source, type, access patterns, and recency.
 *
 * @returns Object with count of updated memories
 */
export function recalculateAllImportance(db: Database.Database): { updated: number } {
  // Fetch all memories
  const memories = db
    .prepare(
      `SELECT id, source, memory_type, last_accessed_at, access_count, is_rule
       FROM memories`,
    )
    .all() as Array<{
    id: string;
    source: string | null;
    memory_type: string;
    last_accessed_at: string;
    access_count: number;
    is_rule: number;
  }>;

  // Prepare update statement
  const updateStmt = db.prepare(
    `UPDATE memories SET importance_score = ? WHERE id = ?`,
  );

  // Batch update in a transaction
  const batchUpdate = db.transaction(() => {
    for (const row of memories) {
      const newImportance = calculateImportance({
        source: row.source,
        memoryType: row.memory_type,
        lastAccessedAt: row.last_accessed_at,
        accessCount: row.access_count,
        isRule: row.is_rule === 1,
      });

      updateStmt.run(newImportance, row.id);
    }
  });

  batchUpdate();

  return { updated: memories.length };
}
