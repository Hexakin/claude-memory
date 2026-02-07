import type Database from 'better-sqlite3';
import type { Embedder } from '../embedding/embedder.js';
import { searchVector, getAllChunkEmbeddings, deleteByMemoryId, createChunks } from '../db/chunk-repo.js';
import { updateMemory } from '../db/memory-repo.js';
import { searchVectorJS } from '../embedding/fallback.js';
import { chunkText } from '../embedding/chunker.js';
import pino from 'pino';

const log = pino({ name: 'consolidation' });

export interface ConsolidationOptions {
  db: Database.Database;
  embedder: Embedder;
  vecAvailable: boolean;
  /** Minimum age in days before a memory is eligible for consolidation */
  minAgeDays?: number;
  /** Maximum access count - memories accessed more than this are excluded */
  maxAccessCount?: number;
  /** Minimum cosine similarity to consider merging */
  minSimilarity?: number;
  /** Maximum number of memories to consolidate per run */
  maxPerRun?: number;
}

export interface ConsolidationResult {
  merged: number;
  deleted: number;
  skipped: number;
}

/**
 * Run consolidation: find old, low-access memories with high similarity and merge them.
 *
 * Algorithm:
 * 1. Find candidate memories: old (>30 days), low access (<3), not rules
 * 2. For each candidate, embed and search for similar memories
 * 3. If similarity > 0.85, merge the two memories (append content, delete old chunks, re-chunk)
 * 4. Track which memories have already been merged to avoid double-processing
 */
export async function runConsolidation(options: ConsolidationOptions): Promise<ConsolidationResult> {
  const {
    db,
    embedder,
    vecAvailable,
    minAgeDays = 30,
    maxAccessCount = 3,
    minSimilarity = 0.85,
    maxPerRun = 20,
  } = options;

  log.info({ minAgeDays, maxAccessCount, minSimilarity, maxPerRun }, 'Starting consolidation');

  // Find candidate memories
  const candidates = db.prepare(`
    SELECT id, content, source, memory_type, access_count
    FROM memories
    WHERE is_rule = 0
      AND access_count <= ?
      AND created_at < datetime('now', '-' || ? || ' days')
    ORDER BY access_count ASC, created_at ASC
    LIMIT ?
  `).all(maxAccessCount, minAgeDays, maxPerRun * 2) as Array<{
    id: string;
    content: string;
    source: string | null;
    memory_type: string;
    access_count: number;
  }>;

  log.info({ candidateCount: candidates.length }, 'Found consolidation candidates');

  const mergedIds = new Set<string>();
  let merged = 0;
  let deleted = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (merged >= maxPerRun) break;
    if (mergedIds.has(candidate.id)) {
      skipped++;
      continue;
    }

    // Embed the candidate
    const embedding = await embedder.embed(candidate.content, 'query');

    // Search for similar
    let results: Array<{ chunkId: string; memoryId: string; content: string; score: number }>;
    if (vecAvailable) {
      results = searchVector(db, embedding, 5);
    } else {
      const allEmbeddings = getAllChunkEmbeddings(db);
      const chunksWithContent = allEmbeddings.map(e => {
        const chunkRow = db.prepare('SELECT content FROM chunks WHERE id = ?').get(e.chunkId) as { content: string } | undefined;
        return { chunkId: e.chunkId, memoryId: e.memoryId, content: chunkRow?.content ?? '', embedding: e.embedding };
      });
      results = searchVectorJS(embedding, chunksWithContent, 5);
    }

    // Group by memoryId, take highest score
    const memoryScores = new Map<string, number>();
    for (const r of results) {
      if (r.memoryId === candidate.id) continue; // Skip self
      if (mergedIds.has(r.memoryId)) continue; // Already merged
      const existing = memoryScores.get(r.memoryId);
      if (!existing || r.score > existing) {
        memoryScores.set(r.memoryId, r.score);
      }
    }

    // Find best match above threshold
    let bestMatch: { id: string; score: number } | null = null;
    for (const [id, score] of memoryScores) {
      if (score >= minSimilarity) {
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { id, score };
        }
      }
    }

    if (!bestMatch) {
      skipped++;
      continue;
    }

    // Merge: append candidate content to best match
    const targetMemory = db.prepare('SELECT content FROM memories WHERE id = ?').get(bestMatch.id) as { content: string } | undefined;
    if (!targetMemory) {
      skipped++;
      continue;
    }

    const mergedContent = targetMemory.content + '\n\n---\n\n' + candidate.content;

    // Update target memory
    updateMemory(db, bestMatch.id, { content: mergedContent });

    // Delete old chunks for target, re-chunk
    deleteByMemoryId(db, bestMatch.id, vecAvailable);
    const chunks = chunkText(mergedContent);
    const chunksWithEmbeddings: Array<{ content: string; chunkIndex: number; tokenCount: number; embedding: Float32Array }> = [];

    for (const chunk of chunks) {
      const chunkEmb = await embedder.embed(chunk.content, 'document');
      chunksWithEmbeddings.push({
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        tokenCount: chunk.tokenCount,
        embedding: chunkEmb,
      });
    }
    createChunks(db, bestMatch.id, chunksWithEmbeddings, vecAvailable);

    // Delete the candidate memory (it's been absorbed)
    deleteByMemoryId(db, candidate.id, vecAvailable);
    db.prepare('DELETE FROM memories WHERE id = ?').run(candidate.id);

    mergedIds.add(candidate.id);
    mergedIds.add(bestMatch.id);
    merged++;
    deleted++;

    log.info({ candidateId: candidate.id, targetId: bestMatch.id, score: bestMatch.score }, 'Consolidated memories');
  }

  log.info({ merged, deleted, skipped }, 'Consolidation complete');
  return { merged, deleted, skipped };
}
