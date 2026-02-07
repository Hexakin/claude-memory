import type { MemoryUpdateInput, MemoryUpdateOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { updateMemory } from '../db/memory-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import { createChunks } from '../db/chunk-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { chunkText } from '../embedding/chunker.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

const log = pino({ name: 'memory-update' });

/**
 * Update a memory's fields. If text changes, re-chunks and re-embeds.
 * Searches global db first, then project databases.
 */
export async function handleMemoryUpdate(
  ctx: ServerContext,
  input: MemoryUpdateInput,
): Promise<MemoryUpdateOutput> {
  // Try global database first
  const globalResult = await tryUpdate(ctx, ctx.globalDb, ctx.vecAvailable, input);
  if (globalResult) return globalResult;

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

    const result = await tryUpdate(ctx, projectDb, vecAvailable, input);
    if (result) return result;
  }

  throw new Error(`Memory not found: ${input.id}`);
}

async function tryUpdate(
  ctx: ServerContext,
  db: import('better-sqlite3').Database,
  vecAvailable: boolean,
  input: MemoryUpdateInput,
): Promise<MemoryUpdateOutput | null> {
  // Check if memory exists in this db
  const existing = db
    .prepare('SELECT id FROM memories WHERE id = ?')
    .get(input.id) as { id: string } | undefined;

  if (!existing) return null;

  // Update memory fields
  const updated = updateMemory(db, input.id, {
    content: input.text,
    memoryType: input.memory_type,
    importanceScore: input.importance,
    isRule: input.is_rule,
  });

  if (!updated) return null;

  // Update tags if provided
  if (input.tags) {
    setMemoryTags(db, input.id, input.tags);
  }

  // If text changed, re-chunk and re-embed
  let chunkCount: number | undefined;
  if (input.text) {
    // Delete old chunks from virtual tables
    const oldChunks = db
      .prepare('SELECT id FROM chunks WHERE memory_id = ?')
      .all(input.id) as Array<{ id: string }>;

    if (oldChunks.length > 0) {
      const deleteVirtual = db.transaction(() => {
        for (const chunk of oldChunks) {
          if (vecAvailable) {
            db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(chunk.id);
          }
          db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.id);
        }
      });
      deleteVirtual();
    }

    // Delete old chunks
    db.prepare('DELETE FROM chunks WHERE memory_id = ?').run(input.id);

    // Re-chunk and re-embed
    const chunks = chunkText(input.text);
    const chunksWithEmbeddings: Array<{
      content: string;
      chunkIndex: number;
      tokenCount: number;
      embedding: Float32Array;
    }> = [];

    for (const chunk of chunks) {
      let embedding: Float32Array;
      const cached = ctx.embeddingCache.get(chunk.content, 'document');
      if (cached) {
        embedding = cached;
      } else {
        embedding = await ctx.embedder.embed(chunk.content, 'document');
        ctx.embeddingCache.set(chunk.content, 'document', embedding);
      }
      chunksWithEmbeddings.push({
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        tokenCount: chunk.tokenCount,
        embedding,
      });
    }

    createChunks(db, input.id, chunksWithEmbeddings, vecAvailable);
    chunkCount = chunks.length;

    log.info({ memoryId: input.id, chunks: chunkCount }, 'Re-chunked memory after text update');
  }

  log.info({ memoryId: input.id }, 'Updated memory');

  return {
    updated: true,
    chunks: chunkCount,
  };
}
