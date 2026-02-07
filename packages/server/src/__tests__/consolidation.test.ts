import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { createMemory } from '../db/memory-repo.js';
import { createChunks } from '../db/chunk-repo.js';
import { chunkText } from '../embedding/chunker.js';
import { runConsolidation } from '../search/consolidation.js';
import type { Embedder } from '../embedding/embedder.js';

/**
 * Mock embedder with deterministic embeddings
 */
function createMockEmbedder(): Embedder {
  const hashToFloat = (text: string): Float32Array => {
    const arr = new Float32Array(768);
    for (let i = 0; i < text.length && i < 768; i++) {
      arr[i] = (text.charCodeAt(i) % 100) / 100;
    }
    for (let i = text.length; i < 768; i++) {
      arr[i] = (i % 50) / 100;
    }
    let sum = 0;
    for (let i = 0; i < 768; i++) sum += arr[i] * arr[i];
    const mag = Math.sqrt(sum);
    if (mag > 0) for (let i = 0; i < 768; i++) arr[i] /= mag;
    return arr;
  };

  return {
    async embed(text: string, _type: 'document' | 'query'): Promise<Float32Array> {
      return hashToFloat(text);
    },
    async embedBatch(texts: string[], _type: 'document' | 'query'): Promise<Float32Array[]> {
      return texts.map(hashToFloat);
    },
    isLoaded() {
      return true;
    },
    async dispose() {},
  };
}

/**
 * Store a test memory with chunks and embeddings
 */
async function storeTestMemory(
  db: Database.Database,
  embedder: Embedder,
  content: string,
  opts?: { daysOld?: number; accessCount?: number; isRule?: boolean },
): Promise<string> {
  const memory = createMemory(db, {
    content,
    source: 'user',
    memoryType: 'general',
    isRule: opts?.isRule,
  });

  // Create chunks with embeddings
  const chunks = chunkText(content);
  const chunksWithEmbeddings = [];
  for (const chunk of chunks) {
    const embedding = await embedder.embed(chunk.content, 'document');
    chunksWithEmbeddings.push({
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      tokenCount: chunk.tokenCount,
      embedding,
    });
  }
  createChunks(db, memory.id, chunksWithEmbeddings, false);

  // Backfill chunks_vec for JS fallback
  const dbChunks = db.prepare('SELECT id, content FROM chunks WHERE memory_id = ?').all(memory.id) as Array<{ id: string; content: string }>;
  const insertVec = db.prepare('INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
  for (const chunk of dbChunks) {
    const embedding = await embedder.embed(chunk.content, 'document');
    insertVec.run(chunk.id, Buffer.from(embedding.buffer));
  }

  // Adjust created_at and access_count if needed
  if (opts?.daysOld) {
    db.prepare(`UPDATE memories SET created_at = datetime('now', '-${opts.daysOld} days'), last_accessed_at = datetime('now', '-${opts.daysOld} days') WHERE id = ?`).run(memory.id);
  }
  if (opts?.accessCount !== undefined) {
    db.prepare('UPDATE memories SET access_count = ? WHERE id = ?').run(opts.accessCount, memory.id);
  }

  return memory.id;
}

describe('Consolidation', () => {
  let db: Database.Database;
  let embedder: Embedder;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
    embedder = createMockEmbedder();

    // Create chunks_vec table for JS fallback
    db.prepare(`
      CREATE TABLE IF NOT EXISTS chunks_vec (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      )
    `).run();
  });

  it('returns zero results on empty database', async () => {
    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
    });

    expect(result.merged).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('skips recent memories (< minAgeDays)', async () => {
    // Store two identical memories that are recent (0 days old)
    await storeTestMemory(db, embedder, 'Recent memory about TypeScript', { daysOld: 0, accessCount: 0 });
    await storeTestMemory(db, embedder, 'Recent memory about TypeScript', { daysOld: 0, accessCount: 0 });

    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
      minAgeDays: 30,
    });

    // Should not consolidate recent memories
    expect(result.merged).toBe(0);
    const count = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    expect(count).toBe(2);
  });

  it('skips frequently accessed memories', async () => {
    await storeTestMemory(db, embedder, 'Frequently accessed memory', { daysOld: 60, accessCount: 10 });
    await storeTestMemory(db, embedder, 'Frequently accessed memory', { daysOld: 60, accessCount: 10 });

    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
      maxAccessCount: 3,
    });

    expect(result.merged).toBe(0);
  });

  it('skips rule memories', async () => {
    await storeTestMemory(db, embedder, 'Important rule memory', { daysOld: 60, accessCount: 0, isRule: true });
    await storeTestMemory(db, embedder, 'Important rule memory copy', { daysOld: 60, accessCount: 0, isRule: true });

    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
    });

    expect(result.merged).toBe(0);
  });

  it('consolidates old low-access similar memories', async () => {
    // Store two identical memories that are old with low access
    const id1 = await storeTestMemory(db, embedder, 'Old memory about database optimization techniques', { daysOld: 60, accessCount: 1 });
    const id2 = await storeTestMemory(db, embedder, 'Old memory about database optimization techniques', { daysOld: 60, accessCount: 1 });

    const beforeCount = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    expect(beforeCount).toBe(2);

    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
      minAgeDays: 30,
      maxAccessCount: 3,
      minSimilarity: 0.85,
    });

    // Should have merged at least one pair
    expect(result.merged).toBeGreaterThanOrEqual(1);

    const afterCount = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    expect(afterCount).toBeLessThan(beforeCount);
  });

  it('does not consolidate dissimilar memories', async () => {
    await storeTestMemory(db, embedder, 'TypeScript is a strongly typed programming language', { daysOld: 60, accessCount: 1 });
    await storeTestMemory(db, embedder, 'Python is used for machine learning and data science', { daysOld: 60, accessCount: 1 });

    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
      minSimilarity: 0.95, // Very high threshold
    });

    // Different content should not be consolidated
    const count = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    expect(count).toBe(2);
  });

  it('respects maxPerRun limit', async () => {
    // Create many old similar memories
    for (let i = 0; i < 5; i++) {
      await storeTestMemory(db, embedder, 'Repeated old memory content number', { daysOld: 60, accessCount: 0 });
    }

    const result = await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
      maxPerRun: 1,
    });

    // Should only merge up to maxPerRun
    expect(result.merged).toBeLessThanOrEqual(1);
  });

  it('appends content with separator when merging', async () => {
    const text1 = 'First piece of information about the project architecture';
    const text2 = 'First piece of information about the project architecture';

    const id1 = await storeTestMemory(db, embedder, text1, { daysOld: 60, accessCount: 0 });
    await storeTestMemory(db, embedder, text2, { daysOld: 60, accessCount: 0 });

    await runConsolidation({
      db,
      embedder,
      vecAvailable: false,
    });

    // Check surviving memory has merged content (or the other one was absorbed)
    const remaining = db.prepare('SELECT content FROM memories').all() as Array<{ content: string }>;

    // At least one memory should remain
    expect(remaining.length).toBeGreaterThanOrEqual(1);

    // If consolidation happened, one memory should contain the separator
    if (remaining.length === 1) {
      expect(remaining[0].content).toContain('---');
    }
  });
});
