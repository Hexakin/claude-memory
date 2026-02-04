import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { hybridSearch } from '../search/hybrid.js';
import { createMemory } from '../db/memory-repo.js';
import { createChunks } from '../db/chunk-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import { chunkText } from '../embedding/chunker.js';
import type { Embedder } from '../embedding/embedder.js';

/**
 * Mock embedder that returns deterministic embeddings based on text hash.
 * This ensures same text always gets same embedding for reproducible tests.
 */
function createMockEmbedder(): Embedder {
  const hashToFloat = (text: string): Float32Array => {
    const arr = new Float32Array(768);
    // Create deterministic values based on text
    for (let i = 0; i < text.length && i < 768; i++) {
      arr[i] = (text.charCodeAt(i) % 100) / 100;
    }
    // Fill remaining with derived values
    for (let i = text.length; i < 768; i++) {
      arr[i] = (i % 50) / 100;
    }
    // L2 normalize
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
 * Helper to store a memory with chunks and embeddings.
 * Creates a chunks_vec table for storing embeddings even when vecAvailable=false,
 * since the JS fallback needs embeddings to work.
 */
async function storeTestMemory(
  db: Database.Database,
  embedder: Embedder,
  text: string,
  opts?: { project?: string; tags?: string[] },
): Promise<string> {
  const memory = createMemory(db, {
    content: text,
    projectId: opts?.project,
  });

  if (opts?.tags) {
    setMemoryTags(db, memory.id, opts.tags);
  }

  // Create chunks with embeddings
  const chunks = chunkText(text);
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

  // Store chunks in regular table
  createChunks(db, memory.id, chunksWithEmbeddings, false);

  // Manually insert embeddings into chunks_vec for JS fallback
  const insertVec = db.prepare('INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
  const getChunkIds = db.prepare('SELECT id FROM chunks WHERE memory_id = ? ORDER BY chunk_index');
  const chunkIds = getChunkIds.all(memory.id) as Array<{ id: string }>;

  for (let i = 0; i < chunksWithEmbeddings.length && i < chunkIds.length; i++) {
    const embeddingBuffer = Buffer.from(chunksWithEmbeddings[i].embedding.buffer);
    insertVec.run(chunkIds[i].id, embeddingBuffer);
  }

  return memory.id;
}

describe('hybrid-search', () => {
  let db: Database.Database;
  let embedder: Embedder;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false); // vecAvailable = false for tests

    // Create chunks_vec table manually for JS fallback in tests
    const createVecTable = `
      CREATE TABLE IF NOT EXISTS chunks_vec (
        chunk_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL
      )
    `;
    db.prepare(createVecTable).run();

    embedder = createMockEmbedder();
  });

  it('should return empty for empty query', async () => {
    await storeTestMemory(db, embedder, 'Some test content');

    const results = await hybridSearch({
      db,
      embedder,
      query: '',
      vecAvailable: false,
    });

    expect(results).toEqual([]);
  });

  it('should return empty for whitespace-only query', async () => {
    await storeTestMemory(db, embedder, 'Some test content');

    const results = await hybridSearch({
      db,
      embedder,
      query: '   ',
      vecAvailable: false,
    });

    expect(results).toEqual([]);
  });

  it('should find memories by FTS keyword match', async () => {
    const text = 'TypeScript generics allow you to create reusable components';
    await storeTestMemory(db, embedder, text);

    const results = await hybridSearch({
      db,
      embedder,
      query: 'TypeScript',
      vecAvailable: false,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe(text);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('should rank better matches higher', async () => {
    const reactText = 'React hooks useState allows you to add state to functional components';
    const dbText = 'Database migration scripts help manage schema changes over time';

    await storeTestMemory(db, embedder, reactText);
    await storeTestMemory(db, embedder, dbText);

    const results = await hybridSearch({
      db,
      embedder,
      query: 'React hooks',
      vecAvailable: false,
    });

    expect(results.length).toBeGreaterThan(0);
    // First result should be the React one
    expect(results[0].content).toBe(reactText);
  });

  it('should filter by tags', async () => {
    const text1 = 'React component with hooks';
    const text2 = 'Database query optimization';

    await storeTestMemory(db, embedder, text1, { tags: ['frontend', 'react'] });
    await storeTestMemory(db, embedder, text2, { tags: ['backend', 'database'] });

    const results = await hybridSearch({
      db,
      embedder,
      query: 'component query',
      tags: ['frontend'],
      vecAvailable: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe(text1);
    expect(results[0].tags).toContain('frontend');
  });

  it('should require all specified tags', async () => {
    const text1 = 'React TypeScript component';
    const text2 = 'React JavaScript component';

    await storeTestMemory(db, embedder, text1, { tags: ['frontend', 'react', 'typescript'] });
    await storeTestMemory(db, embedder, text2, { tags: ['frontend', 'react'] });

    const results = await hybridSearch({
      db,
      embedder,
      query: 'component',
      tags: ['react', 'typescript'],
      vecAvailable: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe(text1);
  });

  it('should respect maxResults limit', async () => {
    for (let i = 0; i < 5; i++) {
      await storeTestMemory(db, embedder, `Memory number ${i} about testing`);
    }

    const results = await hybridSearch({
      db,
      embedder,
      query: 'testing',
      maxResults: 2,
      vecAvailable: false,
    });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should filter by minScore', async () => {
    await storeTestMemory(db, embedder, 'React hooks are powerful');

    // Search with very high minScore - should get no results
    const results = await hybridSearch({
      db,
      embedder,
      query: 'completely unrelated quantum physics',
      minScore: 0.99,
      vecAvailable: false,
    });

    expect(results.length).toBe(0);
  });

  it('should filter by projectId', async () => {
    const text1 = 'Project A memory';
    const text2 = 'Project B memory';

    await storeTestMemory(db, embedder, text1, { project: 'project-a' });
    await storeTestMemory(db, embedder, text2, { project: 'project-b' });

    const results = await hybridSearch({
      db,
      embedder,
      query: 'memory',
      projectId: 'project-a',
      vecAvailable: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe(text1);
  });

  it('should handle multiple chunks per memory', async () => {
    // Create a long text that will be chunked
    const longText = 'TypeScript '.repeat(200) + 'is a typed superset of JavaScript';
    await storeTestMemory(db, embedder, longText);

    const results = await hybridSearch({
      db,
      embedder,
      query: 'TypeScript',
      vecAvailable: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].content).toBe(longText);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('should deduplicate by memory (highest chunk score wins)', async () => {
    // Store a memory with content that appears multiple times
    const text = 'Introduction to React hooks. React hooks are powerful. Conclusion about React.';
    const memoryId = await storeTestMemory(db, embedder, text);

    const results = await hybridSearch({
      db,
      embedder,
      query: 'React',
      vecAvailable: false,
    });

    // Should get exactly one result per memory
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(memoryId);
  });

  it('should include metadata in results', async () => {
    const text = 'Test memory content';
    const memoryId = await storeTestMemory(db, embedder, text, { tags: ['test-tag'] });

    const results = await hybridSearch({
      db,
      embedder,
      query: 'test',
      vecAvailable: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(memoryId);
    expect(results[0].tags).toContain('test-tag');
    expect(results[0].createdAt).toBeDefined();
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('should handle memories with no tags', async () => {
    const text = 'Memory without tags';
    await storeTestMemory(db, embedder, text);

    const results = await hybridSearch({
      db,
      embedder,
      query: 'memory',
      vecAvailable: false,
    });

    expect(results.length).toBe(1);
    expect(results[0].tags).toEqual([]);
  });

  it('should sort results by score descending', async () => {
    await storeTestMemory(db, embedder, 'React hooks useState useEffect');
    await storeTestMemory(db, embedder, 'React introduction');
    await storeTestMemory(db, embedder, 'Database optimization');

    const results = await hybridSearch({
      db,
      embedder,
      query: 'React hooks',
      vecAvailable: false,
    });

    // Verify results are sorted by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});
