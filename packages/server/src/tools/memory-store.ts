import type { MemoryStoreInput, MemoryStoreOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { createMemory } from '../db/memory-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import { createChunks } from '../db/chunk-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { chunkText } from '../embedding/chunker.js';
import { hashForCache } from '../embedding/embedder.js';
import pino from 'pino';

const log = pino({ name: 'memory-store' });

/**
 * Store a memory with automatic chunking and embedding.
 * Supports tags and project scoping.
 */
export async function handleMemoryStore(
  ctx: ServerContext,
  input: MemoryStoreInput,
): Promise<MemoryStoreOutput> {
  // Determine which database to use
  let db = ctx.globalDb;
  let vecAvailable = ctx.vecAvailable;

  if (input.project) {
    db = getProjectDb(ctx.dataDir, input.project);
    vecAvailable = isVecAvailable();
    runMigrations(db, vecAvailable);
  }

  // Create the memory record
  const memory = createMemory(db, {
    content: input.text,
    source: input.source,
    projectId: input.project,
    metadata: input.metadata,
  });

  // Set tags if provided
  if (input.tags && input.tags.length > 0) {
    setMemoryTags(db, memory.id, input.tags);
  }

  // Chunk the text
  const chunks = chunkText(input.text);

  // Generate embeddings for each chunk (with cache)
  const chunksWithEmbeddings: Array<{
    content: string;
    chunkIndex: number;
    tokenCount: number;
    embedding: Float32Array;
  }> = [];

  for (const chunk of chunks) {
    let embedding: Float32Array;

    // Check cache first
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

  // Insert chunks into database
  createChunks(db, memory.id, chunksWithEmbeddings, vecAvailable);

  log.info({ memoryId: memory.id, chunks: chunks.length }, 'Stored memory');

  return {
    id: memory.id,
    chunks: chunks.length,
  };
}
