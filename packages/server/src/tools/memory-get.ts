import type { MemoryGetInput, MemoryGetOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { getMemoryById } from '../db/memory-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

const log = pino({ name: 'memory-get' });

/**
 * Get a specific memory by ID with full metadata.
 * Searches global db first, then scans project databases if not found.
 */
export async function handleMemoryGet(
  ctx: ServerContext,
  input: MemoryGetInput,
): Promise<MemoryGetOutput> {
  // Try global database first
  const globalResult = getMemoryById(ctx.globalDb, input.id);
  if (globalResult) {
    log.info({ memoryId: input.id, source: 'global' }, 'Memory found');
    return memoryToOutput(globalResult);
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

    const result = getMemoryById(projectDb, input.id);
    if (result) {
      log.info({ memoryId: input.id, source: 'project', projectId }, 'Memory found');
      return memoryToOutput(result);
    }
  }

  throw new Error(`Memory not found: ${input.id}`);
}

function memoryToOutput(memory: {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  metadata: Record<string, unknown>;
}): MemoryGetOutput {
  return {
    id: memory.id,
    content: memory.content,
    tags: memory.tags,
    source: memory.source as MemoryGetOutput['source'],
    project: memory.projectId,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    accessCount: memory.accessCount,
    metadata: memory.metadata,
  };
}
