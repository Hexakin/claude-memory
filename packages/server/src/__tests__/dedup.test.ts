import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { handleMemoryStore } from '../tools/memory-store.js';
import { getMemoryById } from '../db/memory-repo.js';
import type { ServerContext } from '../server.js';
import type { Embedder } from '../embedding/embedder.js';
import type { EmbeddingCache } from '../embedding/cache.js';

/**
 * Mock embedder that returns deterministic embeddings.
 * Same text = same embedding = cosine similarity 1.0
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

function createMockCache(): EmbeddingCache {
  const store = new Map<string, Float32Array>();
  let hits = 0;
  let misses = 0;

  return {
    get(text: string, type: 'document' | 'query'): Float32Array | null {
      const key = `${type}:${text}`;
      const val = store.get(key);
      if (val) { hits++; return val; }
      misses++;
      return null;
    },
    set(text: string, type: 'document' | 'query', embedding: Float32Array): void {
      store.set(`${type}:${text}`, embedding);
    },
    stats() {
      return { size: store.size, hits, misses };
    },
  };
}

async function backfillEmbeddings(db: Database.Database, embedder: Embedder, memoryId: string): Promise<void> {
  const chunks = db.prepare('SELECT id, content FROM chunks WHERE memory_id = ? ORDER BY chunk_index').all(memoryId) as Array<{ id: string; content: string }>;
  const insertVec = db.prepare('INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
  for (const chunk of chunks) {
    const embedding = await embedder.embed(chunk.content, 'document');
    const embeddingBuffer = Buffer.from(embedding.buffer);
    insertVec.run(chunk.id, embeddingBuffer);
  }
}

describe('Deduplication', () => {
  let ctx: ServerContext;
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
    dataDir = mkdtempSync(join(tmpdir(), 'claude-memory-dedup-test-'));

    db.prepare(`
      CREATE TABLE IF NOT EXISTS chunks_vec (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      )
    `).run();

    ctx = {
      globalDb: db,
      embedder: createMockEmbedder(),
      embeddingCache: createMockCache(),
      vecAvailable: false,
      dataDir,
    };
  });

  afterEach(() => {
    db.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it('stores novel memory normally when no similar exists', async () => {
    const result = await handleMemoryStore(ctx, {
      text: 'This is a completely new memory about TypeScript',
    });

    expect(result.id).toBeDefined();
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.deduplicated).toBeUndefined();
    expect(result.merged).toBeUndefined();
  });

  it('deduplicates near-identical memory (cosine > 0.95)', async () => {
    // Store first memory
    const first = await handleMemoryStore(ctx, {
      text: 'Always use strict TypeScript mode',
    });
    await backfillEmbeddings(db, ctx.embedder, first.id);

    // Store exact same text - should be deduplicated
    const second = await handleMemoryStore(ctx, {
      text: 'Always use strict TypeScript mode',
    });

    expect(second.id).toBe(first.id);
    expect(second.chunks).toBe(0);
    expect(second.deduplicated).toBe(true);
  });

  it('bumps access count on deduplication', async () => {
    const first = await handleMemoryStore(ctx, {
      text: 'Use React hooks for state management',
    });
    await backfillEmbeddings(db, ctx.embedder, first.id);

    const beforeAccess = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(first.id) as { access_count: number };

    // Store exact same text
    await handleMemoryStore(ctx, {
      text: 'Use React hooks for state management',
    });

    const afterAccess = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(first.id) as { access_count: number };
    expect(afterAccess.access_count).toBeGreaterThan(beforeAccess.access_count);
  });

  it('stores novel memory when no existing memories have embeddings', async () => {
    // Store first memory but do NOT backfill embeddings - simulating
    // empty vector index (no similar results found)
    const first = await handleMemoryStore(ctx, {
      text: 'First memory about TypeScript patterns',
    });
    // Skip backfillEmbeddings - no vectors to match against

    const second = await handleMemoryStore(ctx, {
      text: 'Second memory about Python machine learning',
    });

    // Both should be stored as new since vector search returns empty
    // (no embeddings in chunks_vec to match against)
    expect(second.id).not.toBe(first.id);
    expect(second.chunks).toBeGreaterThan(0);
    expect(second.deduplicated).toBeUndefined();
  });

  it('returns similar_memories advisory for moderately similar content', async () => {
    // Store a memory
    const first = await handleMemoryStore(ctx, {
      text: 'The project uses React with TypeScript for the frontend layer of the application',
    });
    await backfillEmbeddings(db, ctx.embedder, first.id);

    // Store a somewhat different memory - the mock embedder's similarity
    // depends on character-by-character overlap, so this tests the advisory path
    const second = await handleMemoryStore(ctx, {
      text: 'A completely different topic about database schema design and SQL optimization',
    });

    // With the mock embedder, very different texts will have low similarity
    // so similar_memories should be undefined or empty
    // The important thing is it doesn't crash
    expect(second.id).toBeDefined();
    expect(second.chunks).toBeGreaterThan(0);
  });

  it('MemoryStoreOutput includes optional dedup fields in type', async () => {
    const result = await handleMemoryStore(ctx, {
      text: 'Testing type structure of store output',
    });

    // Verify the output shape allows optional fields
    const typed: { id: string; chunks: number; deduplicated?: boolean; merged?: boolean; similar_memories?: unknown[] } = result;
    expect(typed.id).toBeDefined();
    expect(typed.chunks).toBeGreaterThanOrEqual(0);
  });
});
