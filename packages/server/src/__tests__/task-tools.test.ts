import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { handleTaskAdd } from '../tools/task-add.js';
import { handleTaskList } from '../tools/task-list.js';
import { handleTaskResults } from '../tools/task-results.js';
import { handleTaskCancel } from '../tools/task-cancel.js';
import { completeTask } from '../db/task-repo.js';
import type { ServerContext } from '../server.js';
import type { Embedder } from '../embedding/embedder.js';
import type { EmbeddingCache } from '../embedding/cache.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal mock embedder — task tools don't use embeddings */
function createMockEmbedder(): Embedder {
  return {
    async embed(_text: string, _type: 'document' | 'query'): Promise<Float32Array> {
      return new Float32Array(768);
    },
    async embedBatch(texts: string[], _type: 'document' | 'query'): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(768));
    },
    isLoaded() {
      return true;
    },
    async dispose() {},
  };
}

/** Minimal mock embedding cache */
function createMockCache(): EmbeddingCache {
  return {
    get(_text: string, _type: 'document' | 'query'): Float32Array | null {
      return null;
    },
    set(_text: string, _type: 'document' | 'query', _embedding: Float32Array): void {},
    stats() {
      return { size: 0, hits: 0, misses: 0 };
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('task tools', () => {
  let ctx: ServerContext;
  let db: Database.Database;
  let dataDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
    dataDir = mkdtempSync(join(tmpdir(), 'claude-memory-task-test-'));

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
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── task_add ─────────────────────────────────────────────────────────────

  describe('task_add', () => {
    it('should add a task with default values', async () => {
      const result = await handleTaskAdd(ctx, {
        description: 'Review the codebase',
      });

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.scheduledFor).toBe('next cron window');
    });

    it('should add a task with custom type and priority', async () => {
      const result = await handleTaskAdd(ctx, {
        description: 'Review code quality',
        type: 'code-review',
        priority: 5,
      });

      expect(result.id).toBeDefined();

      // Verify via task_list that the task was stored with correct type
      const listResult = await handleTaskList(ctx, {});
      const task = listResult.tasks.find((t) => t.id === result.id);
      expect(task).toBeDefined();
      expect(task!.type).toBe('code-review');
    });

    it('should add a scheduled task', async () => {
      const scheduledFor = '2025-12-31T23:59:59.000Z';
      const result = await handleTaskAdd(ctx, {
        description: 'Scheduled review',
        scheduledFor,
      });

      expect(result.id).toBeDefined();
      expect(result.scheduledFor).toBe(scheduledFor);
    });

    it('should add a task with context', async () => {
      const result = await handleTaskAdd(ctx, {
        description: 'Task with extra context',
        context: { branch: 'feature-branch', scope: 'api' },
      });

      expect(result.id).toBeDefined();
    });
  });

  // ── task_list ────────────────────────────────────────────────────────────

  describe('task_list', () => {
    it('should list all tasks', async () => {
      await handleTaskAdd(ctx, { description: 'Task 1' });
      await handleTaskAdd(ctx, { description: 'Task 2' });
      await handleTaskAdd(ctx, { description: 'Task 3' });

      const result = await handleTaskList(ctx, {});

      expect(result.tasks.length).toBe(3);
    });

    it('should filter by status', async () => {
      const added = await handleTaskAdd(ctx, { description: 'Will be cancelled' });
      await handleTaskAdd(ctx, { description: 'Will stay pending' });

      // Cancel the first task
      await handleTaskCancel(ctx, { id: added.id });

      const pending = await handleTaskList(ctx, { status: 'pending' });
      expect(pending.tasks.length).toBe(1);
      expect(pending.tasks[0].description).toBe('Will stay pending');

      const cancelled = await handleTaskList(ctx, { status: 'cancelled' });
      expect(cancelled.tasks.length).toBe(1);
      expect(cancelled.tasks[0].description).toBe('Will be cancelled');
    });

    it('should filter by project', async () => {
      await handleTaskAdd(ctx, { description: 'Project A task', project: 'project-a' });
      await handleTaskAdd(ctx, { description: 'Project B task', project: 'project-b' });

      const result = await handleTaskList(ctx, { project: 'project-a' });

      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].description).toBe('Project A task');
    });

    it('should return empty array when no tasks match', async () => {
      await handleTaskAdd(ctx, { description: 'A task', project: 'alpha' });

      const result = await handleTaskList(ctx, { project: 'nonexistent' });

      expect(result.tasks).toEqual([]);
    });
  });

  // ── task_results ─────────────────────────────────────────────────────────

  describe('task_results', () => {
    it('should return empty when no results exist', async () => {
      const result = await handleTaskResults(ctx, {});

      expect(result.results).toEqual([]);
    });

    it('should return results after task completion', async () => {
      const added = await handleTaskAdd(ctx, { description: 'Complete me' });

      // Simulate claiming and completing the task
      db.prepare(
        `UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?`,
      ).run(added.id);

      completeTask(db, added.id, {
        output: 'Task completed successfully',
        summary: 'All good',
        success: true,
        durationMs: 5000,
        tokensUsed: 250,
        costUsd: 0.002,
      });

      const result = await handleTaskResults(ctx, { taskId: added.id });

      expect(result.results.length).toBe(1);
      expect(result.results[0].taskId).toBe(added.id);
      expect(result.results[0].success).toBe(true);
      expect(result.results[0].summary).toBe('All good');
      expect(result.results[0].durationMs).toBe(5000);
      expect(result.results[0].tokensUsed).toBe(250);
      expect(result.results[0].costUsd).toBe(0.002);
    });

    it('should include task description in results', async () => {
      const added = await handleTaskAdd(ctx, { description: 'Descriptive task' });

      // Claim and complete
      db.prepare(
        `UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?`,
      ).run(added.id);

      completeTask(db, added.id, {
        output: 'Done',
        success: true,
      });

      const result = await handleTaskResults(ctx, { taskId: added.id });

      expect(result.results.length).toBe(1);
      expect(result.results[0].description).toBe('Descriptive task');
    });
  });

  // ── task_cancel ──────────────────────────────────────────────────────────

  describe('task_cancel', () => {
    it('should cancel a pending task', async () => {
      const added = await handleTaskAdd(ctx, { description: 'Cancel me' });

      const result = await handleTaskCancel(ctx, { id: added.id });

      expect(result.cancelled).toBe(true);

      // Verify it actually changed status
      const listResult = await handleTaskList(ctx, { status: 'cancelled' });
      expect(listResult.tasks.length).toBe(1);
      expect(listResult.tasks[0].id).toBe(added.id);
    });

    it('should return false for non-existent task', async () => {
      const result = await handleTaskCancel(ctx, { id: 'non-existent-id' });

      expect(result.cancelled).toBe(false);
    });

    it('should not cancel a running task', async () => {
      const added = await handleTaskAdd(ctx, { description: 'Running task' });

      // Manually set task to running
      db.prepare(
        `UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?`,
      ).run(added.id);

      const result = await handleTaskCancel(ctx, { id: added.id });

      // cancelTask only cancels pending tasks, so this should return false
      expect(result.cancelled).toBe(false);
    });
  });
});
