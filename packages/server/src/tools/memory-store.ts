import type { MemoryStoreInput, MemoryStoreOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { createMemory, updateMemory, updateAccessTime } from '../db/memory-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import { createChunks, searchVector, getAllChunkEmbeddings, deleteByMemoryId } from '../db/chunk-repo.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { chunkText } from '../embedding/chunker.js';
import { searchVectorJS } from '../embedding/fallback.js';
import pino from 'pino';

const log = pino({ name: 'memory-store' });

/**
 * Store a memory with automatic chunking and embedding.
 * Supports tags and project scoping.
 * Implements deduplication: merges similar memories, bumps near-duplicates.
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

  // Embed the input text for similarity search
  let queryEmbedding: Float32Array;
  const cached = ctx.embeddingCache.get(input.text, 'query');
  if (cached) {
    queryEmbedding = cached;
  } else {
    queryEmbedding = await ctx.embedder.embed(input.text, 'query');
    ctx.embeddingCache.set(input.text, 'query', queryEmbedding);
  }

  // Search for similar existing memories
  let searchResults: Array<{ chunkId: string; memoryId: string; content: string; score: number }>;

  if (vecAvailable) {
    searchResults = searchVector(db, queryEmbedding, 10);
  } else {
    const allEmbeddings = getAllChunkEmbeddings(db);
    const chunksWithContent = allEmbeddings.map(e => {
      // Fetch content for each chunk
      const chunkRow = db
        .prepare('SELECT content FROM chunks WHERE id = ?')
        .get(e.chunkId) as { content: string } | undefined;
      return {
        chunkId: e.chunkId,
        memoryId: e.memoryId,
        content: chunkRow?.content ?? '',
        embedding: e.embedding,
      };
    });
    searchResults = searchVectorJS(queryEmbedding, chunksWithContent, 10);
  }

  // Group by memoryId and take highest score per memory
  const memoryScores = new Map<string, { score: number; content: string }>();
  for (const result of searchResults) {
    const existing = memoryScores.get(result.memoryId);
    if (!existing || result.score > existing.score) {
      memoryScores.set(result.memoryId, { score: result.score, content: result.content });
    }
  }

  // Sort by score descending
  const sortedMemories = Array.from(memoryScores.entries())
    .map(([id, data]) => ({ id, score: data.score, content: data.content }))
    .sort((a, b) => b.score - a.score);

  // Check deduplication thresholds
  const topMatch = sortedMemories[0];

  // Near-duplicate (>0.95): bump access count
  if (topMatch && topMatch.score > 0.95) {
    updateAccessTime(db, topMatch.id);
    log.info({ memoryId: topMatch.id, score: topMatch.score }, 'Deduplicated memory');
    return { id: topMatch.id, chunks: 0, deduplicated: true };
  }

  // Very similar (0.9-0.95): merge
  if (topMatch && topMatch.score >= 0.9 && topMatch.score <= 0.95) {
    // Fetch existing memory content
    const existingMemory = db
      .prepare('SELECT content FROM memories WHERE id = ?')
      .get(topMatch.id) as { content: string } | undefined;

    if (existingMemory) {
      const mergedContent = existingMemory.content + '\n\n---\n\n' + input.text;

      // Delete old chunks
      deleteByMemoryId(db, topMatch.id, vecAvailable);

      // Update memory content
      updateMemory(db, topMatch.id, { content: mergedContent });

      // Re-chunk and re-embed
      const chunks = chunkText(mergedContent);
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

      createChunks(db, topMatch.id, chunksWithEmbeddings, vecAvailable);
      log.info({ memoryId: topMatch.id, score: topMatch.score, chunks: chunks.length }, 'Merged memory');
      return { id: topMatch.id, chunks: chunks.length, merged: true };
    }
  }

  // Novel memory (<0.9): store as new
  const memory = createMemory(db, {
    content: input.text,
    source: input.source,
    projectId: input.project,
    metadata: input.metadata,
    memoryType: input.memory_type,
    importanceScore: input.importance,
    isRule: input.is_rule,
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

  // Advisory: similar memories in 0.85-0.9 range
  const similarAdvisory = sortedMemories
    .filter(m => m.score >= 0.85 && m.score < 0.9)
    .slice(0, 3)
    .map(m => ({ id: m.id, content: m.content, score: m.score }));

  const result: MemoryStoreOutput = { id: memory.id, chunks: chunks.length };
  if (similarAdvisory.length > 0) {
    result.similar_memories = similarAdvisory;
  }

  log.info({ memoryId: memory.id, chunks: chunks.length, similarCount: similarAdvisory.length }, 'Stored memory');

  return result;
}
