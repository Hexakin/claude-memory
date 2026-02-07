import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { createMemory } from '../db/memory-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import { handleMemoryBulkDelete, handleMemoryExport, handleMemoryImport } from '../tools/memory-bulk.js';
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

describe('Bulk Operations', () => {
  let ctx: ServerContext;
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
    dataDir = mkdtempSync(join(tmpdir(), 'claude-memory-bulk-test-'));
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

  describe('bulk delete', () => {
    it('requires confirm to be true', async () => {
      createMemory(db, { content: 'Memory 1', source: 'user' });
      const result = await handleMemoryBulkDelete(ctx, { confirm: false, tag: 'test' });
      expect(result.deleted).toBe(0);
    });

    it('requires at least one filter', async () => {
      createMemory(db, { content: 'Memory 1', source: 'user' });
      const result = await handleMemoryBulkDelete(ctx, { confirm: true });
      expect(result.deleted).toBe(0);
    });

    it('deletes by tag', async () => {
      const m1 = createMemory(db, { content: 'Tagged memory', source: 'user' });
      setMemoryTags(db, m1.id, ['delete-me']);
      createMemory(db, { content: 'Untagged memory', source: 'user' });

      const result = await handleMemoryBulkDelete(ctx, { confirm: true, tag: 'delete-me' });
      expect(result.deleted).toBe(1);

      const count = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
      expect(count).toBe(1);
    });

    it('deletes by project', async () => {
      createMemory(db, { content: 'Project memory', source: 'user', projectId: 'proj1' });
      createMemory(db, { content: 'Other memory', source: 'user', projectId: 'proj2' });

      const result = await handleMemoryBulkDelete(ctx, { confirm: true, project: 'proj1' });
      expect(result.deleted).toBe(1);
    });
  });

  describe('export', () => {
    it('exports as JSON', async () => {
      createMemory(db, { content: 'Memory for export', source: 'user' });
      const result = await handleMemoryExport(ctx, { format: 'json' });

      expect(result.count).toBe(1);
      expect(result.format).toBe('json');
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].content).toBe('Memory for export');
    });

    it('exports as markdown', async () => {
      createMemory(db, { content: 'Markdown memory', source: 'user' });
      const result = await handleMemoryExport(ctx, { format: 'markdown' });

      expect(result.count).toBe(1);
      expect(result.format).toBe('markdown');
      expect(result.data).toContain('Markdown memory');
      expect(result.data).toContain('# Exported Memories');
    });

    it('filters by project', async () => {
      createMemory(db, { content: 'P1 memory', source: 'user', projectId: 'p1' });
      createMemory(db, { content: 'P2 memory', source: 'user', projectId: 'p2' });

      const result = await handleMemoryExport(ctx, { project: 'p1', format: 'json' });
      expect(result.count).toBe(1);
      const parsed = JSON.parse(result.data);
      expect(parsed[0].content).toBe('P1 memory');
    });
  });

  describe('import', () => {
    it('imports from JSON', async () => {
      const data = JSON.stringify([
        { content: 'Imported memory 1', source: 'user', tags: ['test'] },
        { content: 'Imported memory 2', source: 'user' },
      ]);

      const result = await handleMemoryImport(ctx, { data });
      expect(result.imported).toBe(2);
      expect(result.errors).toBe(0);

      const count = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
      expect(count).toBe(2);
    });

    it('handles invalid JSON', async () => {
      const result = await handleMemoryImport(ctx, { data: 'not json' });
      expect(result.imported).toBe(0);
      expect(result.errors).toBe(1);
    });

    it('skips entries without content', async () => {
      const data = JSON.stringify([
        { content: 'Valid', source: 'user' },
        { source: 'user' },
        { content: '', source: 'user' },
      ]);

      const result = await handleMemoryImport(ctx, { data });
      expect(result.imported).toBe(1);
      expect(result.errors).toBe(2);
    });

    it('applies project override', async () => {
      const data = JSON.stringify([
        { content: 'Imported to project', source: 'user' },
      ]);

      await handleMemoryImport(ctx, { data, project: 'override-proj' });
      const row = db.prepare('SELECT project_id FROM memories').get() as { project_id: string };
      expect(row.project_id).toBe('override-proj');
    });
  });
});
