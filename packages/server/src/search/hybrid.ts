import type Database from 'better-sqlite3';
import type { Embedder } from '../embedding/embedder.js';
import type { MemorySearchResult, MemorySource } from '@claude-memory/shared';
import {
  DEFAULT_VECTOR_WEIGHT,
  DEFAULT_FTS_WEIGHT,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MIN_SCORE,
} from '@claude-memory/shared';
import { searchVector, searchFTS, getAllChunkEmbeddings } from '../db/chunk-repo.js';
import { searchVectorJS } from '../embedding/fallback.js';

export interface HybridSearchOptions {
  db: Database.Database;
  embedder: Embedder;
  query: string;
  projectId?: string | null;
  tags?: string[];
  maxResults?: number;
  minScore?: number;
  vectorWeight?: number;
  ftsWeight?: number;
  vecAvailable: boolean;
}

interface MergedChunk {
  chunkId: string;
  memoryId: string;
  content: string;
  vectorScore: number;
  ftsScore: number;
  finalScore: number;
}

interface MemoryRow {
  id: string;
  content: string;
  source: string | null;
  project_id: string | null;
  created_at: string;
}

/**
 * Perform hybrid search combining vector similarity and full-text search.
 *
 * Algorithm:
 * 1. Embed the query
 * 2. Run vector + FTS searches concurrently
 * 3. Merge results by weighted score
 * 4. Group by memoryId (highest chunk per memory)
 * 5. Fetch memory metadata and tags
 * 6. Apply project/tag filters
 * 7. Return sorted results
 */
export async function hybridSearch(
  options: HybridSearchOptions,
): Promise<MemorySearchResult[]> {
  const {
    db,
    embedder,
    query,
    projectId,
    tags,
    maxResults = DEFAULT_MAX_RESULTS,
    minScore = DEFAULT_MIN_SCORE,
    vectorWeight = DEFAULT_VECTOR_WEIGHT,
    ftsWeight = DEFAULT_FTS_WEIGHT,
    vecAvailable,
  } = options;

  // Empty or whitespace-only queries
  if (!query || query.trim().length === 0) {
    return [];
  }

  // Step 1: Embed the query
  const queryEmbedding = await embedder.embed(query, 'query');

  // Fetch enough candidates for merging
  const fetchLimit = maxResults * 3;

  // Step 2: Run vector and FTS searches concurrently
  const [vectorResults, ftsResults] = await Promise.all([
    (async () => {
      if (vecAvailable) {
        return searchVector(db, queryEmbedding, fetchLimit);
      } else {
        // Fallback: load all embeddings and use JS-based search
        const allChunks = getAllChunkEmbeddings(db);
        const chunksWithContent = db
          .prepare('SELECT id, memory_id, content FROM chunks')
          .all() as Array<{ id: string; memory_id: string; content: string }>;

        const chunkMap = new Map(
          chunksWithContent.map((c) => [c.id, { memoryId: c.memory_id, content: c.content }]),
        );

        const enrichedChunks = allChunks.map((chunk) => {
          const meta = chunkMap.get(chunk.chunkId);
          return {
            chunkId: chunk.chunkId,
            memoryId: meta?.memoryId ?? chunk.memoryId,
            content: meta?.content ?? '',
            embedding: chunk.embedding,
          };
        });

        return searchVectorJS(queryEmbedding, enrichedChunks, fetchLimit);
      }
    })(),
    searchFTS(db, query, fetchLimit),
  ]);

  // Step 3: Merge results by chunkId
  const chunkScores = new Map<string, MergedChunk>();

  for (const result of vectorResults) {
    chunkScores.set(result.chunkId, {
      chunkId: result.chunkId,
      memoryId: result.memoryId,
      content: result.content,
      vectorScore: result.score,
      ftsScore: 0,
      finalScore: vectorWeight * result.score,
    });
  }

  for (const result of ftsResults) {
    const existing = chunkScores.get(result.chunkId);
    if (existing) {
      existing.ftsScore = result.score;
      existing.finalScore = vectorWeight * existing.vectorScore + ftsWeight * result.score;
    } else {
      chunkScores.set(result.chunkId, {
        chunkId: result.chunkId,
        memoryId: result.memoryId,
        content: result.content,
        vectorScore: 0,
        ftsScore: result.score,
        finalScore: ftsWeight * result.score,
      });
    }
  }

  // Step 4: Filter by minScore and group by memoryId (take highest chunk per memory)
  const mergedChunks = Array.from(chunkScores.values()).filter(
    (chunk) => chunk.finalScore >= minScore,
  );

  mergedChunks.sort((a, b) => b.finalScore - a.finalScore);

  // Group by memoryId: keep only the highest-scoring chunk per memory
  const memoryMap = new Map<string, MergedChunk>();
  for (const chunk of mergedChunks) {
    const existing = memoryMap.get(chunk.memoryId);
    if (!existing || chunk.finalScore > existing.finalScore) {
      memoryMap.set(chunk.memoryId, chunk);
    }
  }

  const topMemoryChunks = Array.from(memoryMap.values());
  topMemoryChunks.sort((a, b) => b.finalScore - a.finalScore);

  // Limit to maxResults before fetching metadata
  const limitedChunks = topMemoryChunks.slice(0, maxResults);

  if (limitedChunks.length === 0) {
    return [];
  }

  // Step 5: Fetch memory metadata for the top chunks
  const memoryIds = limitedChunks.map((c) => c.memoryId);
  const placeholders = memoryIds.map(() => '?').join(',');

  const memoryRows = db
    .prepare(
      `SELECT id, content, source, project_id, created_at
       FROM memories
       WHERE id IN (${placeholders})`,
    )
    .all(...memoryIds) as MemoryRow[];

  const memoryRowMap = new Map(memoryRows.map((row) => [row.id, row]));

  // Fetch tags for all memories in batch
  const tagsRows = db
    .prepare(
      `SELECT mt.memory_id, t.name
       FROM memory_tags mt
       JOIN tags t ON mt.tag_id = t.id
       WHERE mt.memory_id IN (${placeholders})`,
    )
    .all(...memoryIds) as Array<{ memory_id: string; name: string }>;

  const memoryTagsMap = new Map<string, string[]>();
  for (const row of tagsRows) {
    const existing = memoryTagsMap.get(row.memory_id);
    if (existing) {
      existing.push(row.name);
    } else {
      memoryTagsMap.set(row.memory_id, [row.name]);
    }
  }

  // Step 6: Build final results with filters
  const results: MemorySearchResult[] = [];

  for (const chunk of limitedChunks) {
    const memoryRow = memoryRowMap.get(chunk.memoryId);
    if (!memoryRow) continue;

    // Apply projectId filter
    if (projectId !== undefined && projectId !== null) {
      if (memoryRow.project_id !== projectId) continue;
    }

    const memoryTags = memoryTagsMap.get(chunk.memoryId) ?? [];

    // Apply tags filter: memory must have ALL specified tags
    if (tags && tags.length > 0) {
      const hasAllTags = tags.every((tag) => memoryTags.includes(tag));
      if (!hasAllTags) continue;
    }

    const source = (memoryRow.source as MemorySource) ?? null;

    results.push({
      id: memoryRow.id,
      content: memoryRow.content,
      score: chunk.finalScore,
      tags: memoryTags,
      source,
      createdAt: memoryRow.created_at,
    });
  }

  return results;
}
