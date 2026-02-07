import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { createMemory } from '../db/memory-repo.js';
import { handleMemoryFeedback } from '../tools/memory-feedback.js';
import type { ServerContext } from '../server.js';
import type { Embedder } from '../embedding/embedder.js';
import type { EmbeddingCache } from '../embedding/cache.js';

function createMockEmbedder(): Embedder {
  return {
    async embed(): Promise<Float32Array> { return new Float32Array(768); },
    async embedBatch(): Promise<Float32Array[]> { return []; },
    isLoaded() { return true; },
    async dispose() {},
  };
}

function createMockCache(): EmbeddingCache {
  return {
    get() { return null; },
    set() {},
    stats() { return { size: 0, hits: 0, misses: 0 }; },
  };
}

describe('Memory Feedback', () => {
  let ctx: ServerContext;
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
    dataDir = mkdtempSync(join(tmpdir(), 'claude-memory-feedback-test-'));
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

  it('boosts importance for useful rating', async () => {
    const mem = createMemory(db, { content: 'Useful memory', source: 'user', importanceScore: 0.5 });
    const result = await handleMemoryFeedback(ctx, { id: mem.id, rating: 'useful' });

    expect(result.updated).toBe(true);
    expect(result.action).toBe('importance_boosted');
    expect(result.newImportance).toBe(0.6);
  });

  it('caps useful boost at 1.0', async () => {
    const mem = createMemory(db, { content: 'Important memory', source: 'user', importanceScore: 0.95 });
    const result = await handleMemoryFeedback(ctx, { id: mem.id, rating: 'useful' });

    expect(result.newImportance).toBe(1.0);
  });

  it('halves importance for outdated rating', async () => {
    const mem = createMemory(db, { content: 'Old memory', source: 'user', importanceScore: 0.8 });
    const result = await handleMemoryFeedback(ctx, { id: mem.id, rating: 'outdated' });

    expect(result.updated).toBe(true);
    expect(result.action).toBe('importance_halved');
    expect(result.newImportance).toBe(0.4);
  });

  it('sets importance to 0 and adds disputed tag for wrong rating', async () => {
    const mem = createMemory(db, { content: 'Wrong memory', source: 'user', importanceScore: 0.7 });
    const result = await handleMemoryFeedback(ctx, { id: mem.id, rating: 'wrong' });

    expect(result.updated).toBe(true);
    expect(result.action).toBe('disputed');
    expect(result.newImportance).toBe(0);

    // Check disputed tag
    const tags = db.prepare(
      `SELECT t.name FROM memory_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.memory_id = ?`
    ).all(mem.id) as Array<{ name: string }>;
    expect(tags.some(t => t.name === 'disputed')).toBe(true);
  });

  it('adds consolidation-candidate tag for duplicate rating', async () => {
    const mem = createMemory(db, { content: 'Duplicate memory', source: 'user', importanceScore: 0.5 });
    const result = await handleMemoryFeedback(ctx, { id: mem.id, rating: 'duplicate' });

    expect(result.updated).toBe(true);
    expect(result.action).toBe('marked_for_consolidation');

    const tags = db.prepare(
      `SELECT t.name FROM memory_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.memory_id = ?`
    ).all(mem.id) as Array<{ name: string }>;
    expect(tags.some(t => t.name === 'consolidation-candidate')).toBe(true);
  });

  it('returns not_found for non-existent memory', async () => {
    const result = await handleMemoryFeedback(ctx, { id: 'non-existent', rating: 'useful' });
    expect(result.updated).toBe(false);
    expect(result.action).toBe('not_found');
  });
});
