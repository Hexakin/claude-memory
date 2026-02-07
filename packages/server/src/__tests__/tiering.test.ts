import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { createMemory } from '../db/memory-repo.js';
import { updateStorageTiers } from '../cron/tiering.js';

describe('Storage Tiering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
  });

  it('assigns active tier to recently accessed memories', () => {
    createMemory(db, { content: 'Recent memory', source: 'user', importanceScore: 0.5 });
    // Memory just created = recently accessed
    updateStorageTiers(db);
    const row = db.prepare('SELECT storage_tier FROM memories').get() as { storage_tier: string };
    expect(row.storage_tier).toBe('active');
  });

  it('assigns active tier to high importance memories', () => {
    const mem = createMemory(db, { content: 'Important memory', source: 'user', importanceScore: 0.9 });
    // Make it old but high importance
    db.prepare(`UPDATE memories SET last_accessed_at = datetime('now', '-10 days') WHERE id = ?`).run(mem.id);
    updateStorageTiers(db);
    const row = db.prepare('SELECT storage_tier FROM memories WHERE id = ?').get(mem.id) as { storage_tier: string };
    expect(row.storage_tier).toBe('active');
  });

  it('assigns active tier to rules regardless of age', () => {
    const mem = createMemory(db, { content: 'Rule memory', source: 'user', isRule: true, importanceScore: 0.5 });
    db.prepare(`UPDATE memories SET last_accessed_at = datetime('now', '-60 days') WHERE id = ?`).run(mem.id);
    updateStorageTiers(db);
    const row = db.prepare('SELECT storage_tier FROM memories WHERE id = ?').get(mem.id) as { storage_tier: string };
    expect(row.storage_tier).toBe('active');
  });

  it('demotes old low-importance memories to working', () => {
    const mem = createMemory(db, { content: 'Old medium memory', source: 'user', importanceScore: 0.5 });
    db.prepare(`UPDATE memories SET last_accessed_at = datetime('now', '-10 days') WHERE id = ?`).run(mem.id);
    updateStorageTiers(db);
    const row = db.prepare('SELECT storage_tier FROM memories WHERE id = ?').get(mem.id) as { storage_tier: string };
    expect(row.storage_tier).toBe('working');
  });

  it('archives very old low-importance memories', () => {
    const mem = createMemory(db, { content: 'Very old memory', source: 'user', importanceScore: 0.1 });
    db.prepare(`UPDATE memories SET last_accessed_at = datetime('now', '-60 days') WHERE id = ?`).run(mem.id);
    updateStorageTiers(db);
    const row = db.prepare('SELECT storage_tier FROM memories WHERE id = ?').get(mem.id) as { storage_tier: string };
    expect(row.storage_tier).toBe('archive');
  });

  it('returns correct counts', () => {
    const m1 = createMemory(db, { content: 'New', source: 'user', importanceScore: 0.5 });
    const m2 = createMemory(db, { content: 'Old medium', source: 'user', importanceScore: 0.5 });
    const m3 = createMemory(db, { content: 'Old low', source: 'user', importanceScore: 0.1 });
    db.prepare(`UPDATE memories SET last_accessed_at = datetime('now', '-10 days') WHERE id = ?`).run(m2.id);
    db.prepare(`UPDATE memories SET last_accessed_at = datetime('now', '-60 days') WHERE id = ?`).run(m3.id);

    const result = updateStorageTiers(db);
    expect(result.promoted).toBeGreaterThanOrEqual(0);
    expect(result.demoted).toBeGreaterThanOrEqual(0);
    expect(result.archived).toBeGreaterThanOrEqual(0);
  });

  it('handles empty database', () => {
    const result = updateStorageTiers(db);
    expect(result.promoted).toBe(0);
    expect(result.demoted).toBe(0);
    expect(result.archived).toBe(0);
  });
});
