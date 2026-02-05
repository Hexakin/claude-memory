import type { MemoryCleanupInput, MemoryCleanupOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { deleteMemory } from '../db/memory-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import pino from 'pino';

const log = pino({ name: 'memory-cleanup' });

/**
 * Clean up old memories by deleting those not accessed since a given date.
 * Defaults to dry-run mode for safety.
 */
export async function handleMemoryCleanup(
  ctx: ServerContext,
  input: MemoryCleanupInput,
): Promise<MemoryCleanupOutput> {
  const dryRun = input.dryRun ?? true;

  // Early return if olderThan is not provided
  if (!input.olderThan) {
    return { wouldDelete: 0, deleted: 0, dryRun };
  }

  // Determine database based on project parameter
  let db = ctx.globalDb;
  let vecAvail = ctx.vecAvailable;

  if (input.project) {
    db = getProjectDb(ctx.dataDir, input.project);
    vecAvail = isVecAvailable();
    runMigrations(db, vecAvail);
  }

  // Build SQL query to find memories older than threshold
  let sql = 'SELECT id FROM memories WHERE last_accessed_at < ? ORDER BY last_accessed_at ASC';
  const params: (string | number)[] = [input.olderThan];

  if (input.maxCount) {
    sql += ' LIMIT ?';
    params.push(input.maxCount);
  }

  const rows = db.prepare(sql).all(...params) as Array<{ id: string }>;
  const totalFound = rows.length;

  // If dryRun: return count without deleting
  if (dryRun) {
    return { wouldDelete: totalFound, deleted: 0, dryRun: true };
  }

  // Delete each memory
  let successCount = 0;
  for (const row of rows) {
    const success = deleteMemory(db, row.id, vecAvail);
    if (success) {
      successCount++;
    }
  }

  log.info({ totalFound, deleted: successCount, project: input.project }, 'Cleanup completed');
  return { wouldDelete: totalFound, deleted: successCount, dryRun: false };
}
