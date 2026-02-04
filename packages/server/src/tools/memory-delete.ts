import type { MemoryDeleteInput, MemoryDeleteOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { deleteMemory } from '../db/memory-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

const log = pino({ name: 'memory-delete' });

/**
 * Delete a specific memory and all its chunks.
 * Searches global db first, then scans project databases if not found.
 */
export async function handleMemoryDelete(
  ctx: ServerContext,
  input: MemoryDeleteInput,
): Promise<MemoryDeleteOutput> {
  // Try global database first
  const globalDeleted = deleteMemory(ctx.globalDb, input.id, ctx.vecAvailable);
  if (globalDeleted) {
    log.info({ memoryId: input.id, source: 'global' }, 'Memory deleted');
    return { deleted: true };
  }

  // Scan project databases
  const projectsDir = join(ctx.dataDir, 'projects');
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // projects directory may not exist yet
  }

  for (const projectId of projectDirs) {
    const projectDb = getProjectDb(ctx.dataDir, projectId);
    const vecAvailable = isVecAvailable();
    runMigrations(projectDb, vecAvailable);

    const deleted = deleteMemory(projectDb, input.id, vecAvailable);
    if (deleted) {
      log.info({ memoryId: input.id, source: 'project', projectId }, 'Memory deleted');
      return { deleted: true };
    }
  }

  log.info({ memoryId: input.id }, 'Memory not found for deletion');
  return { deleted: false };
}
