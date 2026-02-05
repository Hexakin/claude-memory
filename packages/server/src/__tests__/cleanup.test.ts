import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { handleMemoryCleanup } from '../tools/memory-cleanup.js';
import { createMemory } from '../db/memory-repo.js';
import { closeAll } from '../db/connection.js';
import type { ServerContext } from '../server.js';
import type { Embedder } from '../embedding/embedder.js';
import type { EmbeddingCache } from '../embedding/cache.js';

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

describe('handleMemoryCleanup', () => {
  let db: Database.Database;
  let ctx: ServerContext;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleanup-test-'));
    db = new Database(':memory:');
    runMigrations(db, false);

    ctx = {
      globalDb: db,
      embedder: createMockEmbedder(),
      embeddingCache: createMockCache(),
      vecAvailable: false,
      dataDir: tmpDir,
    };
  });

  afterEach(() => {
    db.close();
    closeAll(); // Release any cached project DB connections before removing temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows (EBUSY)
    }
  });

  function insertMemoryWithDate(content: string, lastAccessed: string): string {
    const mem = createMemory(db, { content });
    db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(lastAccessed, mem.id);
    return mem.id;
  }

  it('dry run returns count without deleting', async () => {
    insertMemoryWithDate('old memory 1', '2024-01-01T00:00:00');
    insertMemoryWithDate('old memory 2', '2024-06-01T00:00:00');
    insertMemoryWithDate('old memory 3', '2024-03-01T00:00:00');

    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-01-01T00:00:00',
      dryRun: true,
    });

    expect(result.wouldDelete).toBe(3);
    expect(result.deleted).toBe(0);
    expect(result.dryRun).toBe(true);

    // Verify memories still exist
    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(3);
  });

  it('actual deletion removes old memories', async () => {
    insertMemoryWithDate('old memory 1', '2024-01-01T00:00:00');
    insertMemoryWithDate('old memory 2', '2024-06-01T00:00:00');

    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-01-01T00:00:00',
      dryRun: false,
    });

    expect(result.wouldDelete).toBe(2);
    expect(result.deleted).toBe(2);
    expect(result.dryRun).toBe(false);

    // Verify memories are gone
    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('maxCount limits deletions', async () => {
    insertMemoryWithDate('mem 1', '2024-01-01T00:00:00');
    insertMemoryWithDate('mem 2', '2024-02-01T00:00:00');
    insertMemoryWithDate('mem 3', '2024-03-01T00:00:00');
    insertMemoryWithDate('mem 4', '2024-04-01T00:00:00');
    insertMemoryWithDate('mem 5', '2024-05-01T00:00:00');

    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-01-01T00:00:00',
      maxCount: 2,
      dryRun: false,
    });

    expect(result.wouldDelete).toBe(2);
    expect(result.deleted).toBe(2);

    // 3 should remain
    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(3);
  });

  it('only deletes memories older than threshold', async () => {
    insertMemoryWithDate('old memory', '2024-01-01T00:00:00');
    insertMemoryWithDate('recent memory', '2025-08-01T00:00:00');

    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-06-01T00:00:00',
      dryRun: false,
    });

    expect(result.wouldDelete).toBe(1);
    expect(result.deleted).toBe(1);

    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('returns zero when no memories match', async () => {
    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-01-01T00:00:00',
      dryRun: false,
    });

    expect(result.wouldDelete).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.dryRun).toBe(false);
  });

  it('defaults to dryRun=true', async () => {
    insertMemoryWithDate('old memory', '2024-01-01T00:00:00');

    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-01-01T00:00:00',
    });

    expect(result.deleted).toBe(0);
    expect(result.dryRun).toBe(true);

    // Memory should still exist
    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('handles project-scoped cleanup', async () => {
    // Insert into the global db
    insertMemoryWithDate('global memory', '2024-01-01T00:00:00');

    // Cleanup with project scope should not touch global DB memories
    // (it will use a separate project DB)
    const result = await handleMemoryCleanup(ctx, {
      olderThan: '2025-01-01T00:00:00',
      project: 'test-project-id',
      dryRun: true,
    });

    // Project DB is empty, so zero found
    expect(result.wouldDelete).toBe(0);
    expect(result.dryRun).toBe(true);

    // Global memory still untouched
    const count = db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('returns zero when olderThan is not provided', async () => {
    insertMemoryWithDate('some memory', '2024-01-01T00:00:00');

    const result = await handleMemoryCleanup(ctx, {
      dryRun: true,
    });

    expect(result.wouldDelete).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.dryRun).toBe(true);
  });
});
