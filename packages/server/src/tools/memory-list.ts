import type { MemoryListInput, MemoryListOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { listMemories } from '../db/memory-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import pino from 'pino';

const log = pino({ name: 'memory-list' });

/**
 * List memories with optional filtering by project, tag, source, and date.
 */
export async function handleMemoryList(
  ctx: ServerContext,
  input: MemoryListInput,
): Promise<MemoryListOutput> {
  // Determine which database to use
  let db = ctx.globalDb;

  if (input.project) {
    db = getProjectDb(ctx.dataDir, input.project);
    const vecAvailable = isVecAvailable();
    runMigrations(db, vecAvailable);
  }

  const result = listMemories(db, {
    projectId: input.project,
    tag: input.tag,
    source: input.source,
    since: input.since,
    limit: input.limit ?? 20,
    offset: input.offset ?? 0,
  });

  log.info({ count: result.memories.length, total: result.total }, 'Listed memories');

  return {
    memories: result.memories.map((m) => ({
      id: m.id,
      content: m.content,
      tags: m.tags,
      source: m.source,
      createdAt: m.createdAt,
    })),
    total: result.total,
  };
}
