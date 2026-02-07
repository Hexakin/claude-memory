import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { calculateImportance, recalculateAllImportance } from '../search/importance.js';
import { createMemory } from '../db/memory-repo.js';

describe('Importance Scoring', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
  });

  describe('calculateImportance', () => {
    it('should calculate importance for user-sourced rule memory', () => {
      const now = new Date().toISOString();
      const importance = calculateImportance({
        source: 'user',
        memoryType: 'rule',
        lastAccessedAt: now,
        accessCount: 10,
        isRule: true,
      });

      // user=1.0, rule=1.0, recency=1.0 (just accessed), access=~0.8
      // Final: 1.0 * 1.0 * 1.0 * 0.8 = 0.8, but rules are clamped to >= 0.9
      expect(importance).toBeGreaterThanOrEqual(0.9);
      expect(importance).toBeLessThanOrEqual(1.0);
    });

    it('should calculate importance for extraction-sourced learning memory', () => {
      const now = new Date().toISOString();
      const importance = calculateImportance({
        source: 'extraction',
        memoryType: 'learning',
        lastAccessedAt: now,
        accessCount: 5,
        isRule: false,
      });

      // extraction=0.7, learning=0.8, recency=1.0, access=~0.7
      // Final: 0.7 * 0.8 * 1.0 * 0.7 = ~0.39
      expect(importance).toBeGreaterThan(0.3);
      expect(importance).toBeLessThan(0.5);
    });

    it('should apply recency decay for old memories', () => {
      // 30 days ago (1 half-life)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const importance = calculateImportance({
        source: 'user',
        memoryType: 'general',
        lastAccessedAt: thirtyDaysAgo,
        accessCount: 1,
        isRule: false,
      });

      // user=1.0, general=0.6, recency=0.5 (30 days = 1 half-life), access=0.5
      // Final: 1.0 * 0.6 * 0.5 * 0.5 = 0.15
      expect(importance).toBeGreaterThan(0.1);
      expect(importance).toBeLessThan(0.2);
    });

    it('should apply access count boost for frequently accessed memories', () => {
      const now = new Date().toISOString();
      const lowAccess = calculateImportance({
        source: 'user',
        memoryType: 'general',
        lastAccessedAt: now,
        accessCount: 1,
        isRule: false,
      });

      const highAccess = calculateImportance({
        source: 'user',
        memoryType: 'general',
        lastAccessedAt: now,
        accessCount: 100,
        isRule: false,
      });

      // High access should have higher importance
      expect(highAccess).toBeGreaterThan(lowAccess);
    });

    it('should prioritize mistake type memories', () => {
      const now = new Date().toISOString();
      const mistake = calculateImportance({
        source: 'user',
        memoryType: 'mistake',
        lastAccessedAt: now,
        accessCount: 5,
        isRule: false,
      });

      const general = calculateImportance({
        source: 'user',
        memoryType: 'general',
        lastAccessedAt: now,
        accessCount: 5,
        isRule: false,
      });

      // mistake=0.9, general=0.6
      expect(mistake).toBeGreaterThan(general);
    });

    it('should clamp importance to [0.0, 1.0]', () => {
      const now = new Date().toISOString();
      const importance = calculateImportance({
        source: 'user',
        memoryType: 'rule',
        lastAccessedAt: now,
        accessCount: 1000,
        isRule: false,
      });

      expect(importance).toBeGreaterThanOrEqual(0.0);
      expect(importance).toBeLessThanOrEqual(1.0);
    });

    it('should handle null source as default weight', () => {
      const now = new Date().toISOString();
      const importance = calculateImportance({
        source: null,
        memoryType: 'general',
        lastAccessedAt: now,
        accessCount: 5,
        isRule: false,
      });

      // null source = 0.5, general=0.6, recency=1.0, access=~0.7
      // Final: 0.5 * 0.6 * 1.0 * 0.7 = 0.21
      expect(importance).toBeGreaterThan(0.15);
      expect(importance).toBeLessThan(0.3);
    });

    it('should enforce minimum 0.9 for rules', () => {
      // Very old rule with low access
      const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const importance = calculateImportance({
        source: 'automation',
        memoryType: 'general',
        lastAccessedAt: veryOld,
        accessCount: 0,
        isRule: true,
      });

      // Even with low source, type, recency, and access, rules must be >= 0.9
      expect(importance).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('recalculateAllImportance', () => {
    it('should recalculate importance for all memories', () => {
      // Create test memories
      createMemory(db, {
        content: 'User rule memory',
        source: 'user',
        memoryType: 'rule',
        isRule: true,
      });

      createMemory(db, {
        content: 'Extraction learning',
        source: 'extraction',
        memoryType: 'learning',
      });

      createMemory(db, {
        content: 'General memory',
        source: 'hook',
        memoryType: 'general',
      });

      // Recalculate
      const result = recalculateAllImportance(db);
      expect(result.updated).toBe(3);

      // Verify scores were updated
      const memories = db
        .prepare('SELECT id, importance_score, is_rule FROM memories ORDER BY importance_score DESC')
        .all() as Array<{ id: string; importance_score: number; is_rule: number }>;

      expect(memories).toHaveLength(3);

      // Rule should have highest importance (>= 0.9)
      expect(memories[0].is_rule).toBe(1);
      expect(memories[0].importance_score).toBeGreaterThanOrEqual(0.9);

      // All should have valid importance scores
      for (const memory of memories) {
        expect(memory.importance_score).toBeGreaterThanOrEqual(0.0);
        expect(memory.importance_score).toBeLessThanOrEqual(1.0);
      }
    });

    it('should handle empty database', () => {
      const result = recalculateAllImportance(db);
      expect(result.updated).toBe(0);
    });

    it('should update existing importance scores', () => {
      // Create memory with default importance
      const memory = createMemory(db, {
        content: 'Test memory',
        source: 'user',
        memoryType: 'rule',
        isRule: true,
        importanceScore: 0.5, // Start with low score
      });

      expect(memory.importanceScore).toBe(0.5);

      // Recalculate
      recalculateAllImportance(db);

      // Fetch updated memory
      const updated = db
        .prepare('SELECT importance_score FROM memories WHERE id = ?')
        .get(memory.id) as { importance_score: number };

      // Should now be >= 0.9 because it's a rule
      expect(updated.importance_score).toBeGreaterThanOrEqual(0.9);
      expect(updated.importance_score).not.toBe(0.5);
    });
  });
});
