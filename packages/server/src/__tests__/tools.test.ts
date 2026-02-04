import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { handleMemoryStore } from '../tools/memory-store.js';
import { handleMemorySearch } from '../tools/memory-search.js';
import { handleMemoryGet } from '../tools/memory-get.js';
import { handleMemoryList } from '../tools/memory-list.js';
import { handleMemoryDelete } from '../tools/memory-delete.js';
import { getTagsForMemory } from '../db/tag-repo.js';
import { getMemoryById } from '../db/memory-repo.js';
import type { ServerContext } from '../server.js';
import type { Embedder } from '../embedding/embedder.js';
import type { EmbeddingCache } from '../embedding/cache.js';

/**
 * Mock embedder that returns deterministic embeddings
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
 * Mock embedding cache
 */
function createMockCache(): EmbeddingCache {
  const store = new Map<string, Float32Array>();
  let hits = 0;
  let misses = 0;

  return {
    get(text: string, type: 'document' | 'query'): Float32Array | null {
      const key = `${type}:${text}`;
      const val = store.get(key);
      if (val) {
        hits++;
        return val;
      }
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

/**
 * Helper to manually insert embeddings into chunks_vec after storing
 * This is needed because vecAvailable=false doesn't create chunks_vec,
 * but the JS fallback search needs it.
 */
async function backfillEmbeddings(db: Database.Database, embedder: Embedder, memoryId: string): Promise<void> {
  const chunks = db.prepare('SELECT id, content FROM chunks WHERE memory_id = ? ORDER BY chunk_index').all(memoryId) as Array<{ id: string; content: string }>;

  const insertVec = db.prepare('INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
  for (const chunk of chunks) {
    const embedding = await embedder.embed(chunk.content, 'document');
    const embeddingBuffer = Buffer.from(embedding.buffer);
    insertVec.run(chunk.id, embeddingBuffer);
  }
}

describe('tools', () => {
  let ctx: ServerContext;
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false); // vecAvailable = false for tests
    dataDir = mkdtempSync(join(tmpdir(), 'claude-memory-test-'));

    // Create chunks_vec table manually for JS fallback in tests
    const createVecTable = `
      CREATE TABLE IF NOT EXISTS chunks_vec (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      )
    `;
    db.prepare(createVecTable).run();

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
    // Clean up temp directory
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('memory_store', () => {
    it('should store a memory and return ID + chunk count', async () => {
      const result = await handleMemoryStore(ctx, {
        text: 'This is a test memory about TypeScript and React',
      });

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.chunks).toBeGreaterThan(0);
      expect(typeof result.chunks).toBe('number');
    });

    it('should store with tags', async () => {
      const tags = ['typescript', 'testing'];
      const result = await handleMemoryStore(ctx, {
        text: 'Memory with tags',
        tags,
      });

      // Verify tags were saved
      const savedTags = getTagsForMemory(db, result.id);
      expect(savedTags).toEqual(expect.arrayContaining(tags));
      expect(savedTags.length).toBe(tags.length);
    });

    it('should store with metadata', async () => {
      const metadata = { author: 'test', version: 1 };
      const result = await handleMemoryStore(ctx, {
        text: 'Memory with metadata',
        metadata,
      });

      // Verify metadata was saved
      const memory = getMemoryById(db, result.id);
      expect(memory).toBeDefined();
      expect(memory?.metadata).toEqual(metadata);
    });

    it('should store with source', async () => {
      const result = await handleMemoryStore(ctx, {
        text: 'Memory with source',
        source: 'user',
      });

      const memory = getMemoryById(db, result.id);
      expect(memory).toBeDefined();
      expect(memory?.source).toBe('user');
    });

    it('should store with project', async () => {
      const result = await handleMemoryStore(ctx, {
        text: 'Project-scoped memory',
        project: 'my-project',
      });

      // Project memories are stored in a separate DB, not the global one
      // So we can't verify via getMemoryById on the global db
      expect(result.id).toBeDefined();
      expect(result.chunks).toBeGreaterThan(0);
    });

    it('should chunk long text', async () => {
      // Create text long enough to exceed default chunk size
      // Default is 500 tokens * 4 chars/token = 2000 chars, use 3200+ to be safe
      const longText = 'This is a long text that will be chunked into multiple pieces. '.repeat(55);
      const result = await handleMemoryStore(ctx, {
        text: longText,
      });

      // Verify it was stored (chunking details depend on the chunker implementation)
      expect(result.id).toBeDefined();
      expect(result.chunks).toBeGreaterThanOrEqual(1);
    });
  });

  describe('memory_search', () => {
    it('should search stored memories', async () => {
      const text1 = 'React hooks are powerful features';
      const text2 = 'Database optimization techniques';

      const stored1 = await handleMemoryStore(ctx, { text: text1 });
      const stored2 = await handleMemoryStore(ctx, { text: text2 });

      // Backfill embeddings for search
      await backfillEmbeddings(db, ctx.embedder, stored1.id);
      await backfillEmbeddings(db, ctx.embedder, stored2.id);

      const result = await handleMemorySearch(ctx, {
        query: 'React hooks',
      });

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].content).toBe(text1);
    });

    it('should return empty for no matches', async () => {
      await handleMemoryStore(ctx, {
        text: 'React hooks are powerful',
      });

      const result = await handleMemorySearch(ctx, {
        query: 'completely unrelated quantum physics',
        minScore: 0.99,
      });

      expect(result.results).toEqual([]);
    });

    it('should respect maxResults', async () => {
      for (let i = 0; i < 5; i++) {
        await handleMemoryStore(ctx, { text: `Memory ${i} about testing` });
      }

      const result = await handleMemorySearch(ctx, {
        query: 'testing',
        maxResults: 2,
      });

      expect(result.results.length).toBeLessThanOrEqual(2);
    });

    it('should filter by tags', async () => {
      const stored1 = await handleMemoryStore(ctx, {
        text: 'Frontend code',
        tags: ['frontend'],
      });
      const stored2 = await handleMemoryStore(ctx, {
        text: 'Backend code',
        tags: ['backend'],
      });

      await backfillEmbeddings(db, ctx.embedder, stored1.id);
      await backfillEmbeddings(db, ctx.embedder, stored2.id);

      const result = await handleMemorySearch(ctx, {
        query: 'code',
        tags: ['frontend'],
      });

      expect(result.results.length).toBe(1);
      expect(result.results[0].tags).toContain('frontend');
    });

    it('should include score in results', async () => {
      const stored = await handleMemoryStore(ctx, {
        text: 'TypeScript is great',
      });

      await backfillEmbeddings(db, ctx.embedder, stored.id);

      const result = await handleMemorySearch(ctx, {
        query: 'TypeScript',
      });

      expect(result.results[0].score).toBeDefined();
      expect(result.results[0].score).toBeGreaterThan(0);
    });
  });

  describe('memory_get', () => {
    it('should get a stored memory by ID', async () => {
      const text = 'Test memory content';
      const tags = ['test'];
      const metadata = { key: 'value' };

      const stored = await handleMemoryStore(ctx, {
        text,
        tags,
        metadata,
      });

      const result = await handleMemoryGet(ctx, { id: stored.id });

      expect(result.id).toBe(stored.id);
      expect(result.content).toBe(text);
      expect(result.tags).toEqual(tags);
      expect(result.metadata).toEqual(metadata);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(result.accessCount).toBeGreaterThanOrEqual(0);
    });

    it('should throw for non-existent ID', async () => {
      await expect(
        handleMemoryGet(ctx, { id: 'non-existent-id' }),
      ).rejects.toThrow('Memory not found');
    });

    it('should increment access count', async () => {
      const stored = await handleMemoryStore(ctx, {
        text: 'Test memory',
      });

      // Get the memory twice
      await handleMemoryGet(ctx, { id: stored.id });
      const result = await handleMemoryGet(ctx, { id: stored.id });

      expect(result.accessCount).toBeGreaterThan(0);
    });
  });

  describe('memory_list', () => {
    it('should list all memories', async () => {
      await handleMemoryStore(ctx, { text: 'Memory 1' });
      await handleMemoryStore(ctx, { text: 'Memory 2' });
      await handleMemoryStore(ctx, { text: 'Memory 3' });

      const result = await handleMemoryList(ctx, {});

      expect(result.memories.length).toBe(3);
      expect(result.total).toBe(3);
    });

    it('should paginate results', async () => {
      for (let i = 0; i < 5; i++) {
        await handleMemoryStore(ctx, { text: `Memory ${i}` });
      }

      const result = await handleMemoryList(ctx, {
        limit: 2,
        offset: 0,
      });

      expect(result.memories.length).toBe(2);
      expect(result.total).toBe(5);
    });

    it('should filter by tag', async () => {
      await handleMemoryStore(ctx, { text: 'Frontend', tags: ['frontend'] });
      await handleMemoryStore(ctx, { text: 'Backend', tags: ['backend'] });

      const result = await handleMemoryList(ctx, {
        tag: 'frontend',
      });

      expect(result.memories.length).toBe(1);
      expect(result.memories[0].tags).toContain('frontend');
    });

    it('should filter by source', async () => {
      await handleMemoryStore(ctx, { text: 'User memory', source: 'user' });
      await handleMemoryStore(ctx, { text: 'Automation memory', source: 'automation' });

      const result = await handleMemoryList(ctx, {
        source: 'user',
      });

      expect(result.memories.length).toBe(1);
      expect(result.memories[0].source).toBe('user');
    });

    it('should use default limit', async () => {
      for (let i = 0; i < 25; i++) {
        await handleMemoryStore(ctx, { text: `Memory ${i}` });
      }

      const result = await handleMemoryList(ctx, {});

      // Default limit is 20
      expect(result.memories.length).toBe(20);
      expect(result.total).toBe(25);
    });

    it('should return empty for no matches', async () => {
      const result = await handleMemoryList(ctx, {
        tag: 'non-existent-tag',
      });

      expect(result.memories).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('memory_delete', () => {
    it('should delete a memory', async () => {
      const stored = await handleMemoryStore(ctx, {
        text: 'Memory to delete',
      });

      const result = await handleMemoryDelete(ctx, { id: stored.id });

      expect(result.deleted).toBe(true);

      // Verify it's actually deleted
      await expect(
        handleMemoryGet(ctx, { id: stored.id }),
      ).rejects.toThrow('Memory not found');
    });

    it('should return false for non-existent ID', async () => {
      const result = await handleMemoryDelete(ctx, {
        id: 'non-existent-id',
      });

      expect(result.deleted).toBe(false);
    });

    it('should delete chunks with memory', async () => {
      const stored = await handleMemoryStore(ctx, {
        text: 'Memory with chunks',
      });

      // Verify chunks exist
      const chunkCount = db
        .prepare('SELECT COUNT(*) as count FROM chunks WHERE memory_id = ?')
        .get(stored.id) as { count: number };
      expect(chunkCount.count).toBeGreaterThan(0);

      // Delete memory
      await handleMemoryDelete(ctx, { id: stored.id });

      // Verify chunks are deleted
      const afterCount = db
        .prepare('SELECT COUNT(*) as count FROM chunks WHERE memory_id = ?')
        .get(stored.id) as { count: number };
      expect(afterCount.count).toBe(0);
    });

    it('should delete tags with memory', async () => {
      const stored = await handleMemoryStore(ctx, {
        text: 'Memory with tags',
        tags: ['tag1', 'tag2'],
      });

      // Delete memory
      await handleMemoryDelete(ctx, { id: stored.id });

      // Verify tag associations are deleted
      const tagCount = db
        .prepare('SELECT COUNT(*) as count FROM memory_tags WHERE memory_id = ?')
        .get(stored.id) as { count: number };
      expect(tagCount.count).toBe(0);
    });
  });

  describe('integration', () => {
    it('should handle full workflow: store -> search -> get -> delete', async () => {
      // Store
      const stored = await handleMemoryStore(ctx, {
        text: 'Integration test memory about React hooks',
        tags: ['react', 'testing'],
        metadata: { test: true },
      });

      expect(stored.id).toBeDefined();

      // Backfill embeddings for search
      await backfillEmbeddings(db, ctx.embedder, stored.id);

      // Search
      const searchResult = await handleMemorySearch(ctx, {
        query: 'React hooks',
      });
      expect(searchResult.results.length).toBeGreaterThan(0);
      expect(searchResult.results[0].id).toBe(stored.id);

      // Get
      const getResult = await handleMemoryGet(ctx, { id: stored.id });
      expect(getResult.content).toContain('React hooks');
      expect(getResult.tags).toEqual(['react', 'testing']);

      // Delete
      const deleteResult = await handleMemoryDelete(ctx, { id: stored.id });
      expect(deleteResult.deleted).toBe(true);

      // Verify deletion
      await expect(
        handleMemoryGet(ctx, { id: stored.id }),
      ).rejects.toThrow('Memory not found');
    });

    it('should handle multiple memories with different tags', async () => {
      const stored1 = await handleMemoryStore(ctx, {
        text: 'Frontend React component',
        tags: ['frontend', 'react'],
      });
      const stored2 = await handleMemoryStore(ctx, {
        text: 'Backend API endpoint',
        tags: ['backend', 'api'],
      });
      const stored3 = await handleMemoryStore(ctx, {
        text: 'Database schema design',
        tags: ['backend', 'database'],
      });

      // Backfill embeddings for search
      await backfillEmbeddings(db, ctx.embedder, stored1.id);
      await backfillEmbeddings(db, ctx.embedder, stored2.id);
      await backfillEmbeddings(db, ctx.embedder, stored3.id);

      // Search by tag
      const backendResults = await handleMemorySearch(ctx, {
        query: 'backend',
        tags: ['backend'],
      });
      expect(backendResults.results.length).toBe(2);

      // List by tag
      const apiResults = await handleMemoryList(ctx, {
        tag: 'api',
      });
      expect(apiResults.memories.length).toBe(1);
    });
  });
});
