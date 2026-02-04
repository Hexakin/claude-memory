import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { createMemory, getMemoryById, listMemories, deleteMemory } from '../db/memory-repo.js';
import { setMemoryTags, getTagsForMemory, getTagsForMemories, ensureTag } from '../db/tag-repo.js';
import { createChunks, searchFTS, deleteByMemoryId } from '../db/chunk-repo.js';
import { addTask, getNextPending, claimTask, completeTask, failTask, listTasks, cancelTask } from '../db/task-repo.js';

describe('memory-repo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
  });

  it('should create a memory and return it with ID', () => {
    const memory = createMemory(db, {
      content: 'Test memory content',
      source: 'test',
      projectId: 'test-project',
      metadata: { key: 'value' },
    });

    expect(memory.id).toBeTruthy();
    expect(memory.content).toBe('Test memory content');
    expect(memory.source).toBe('test');
    expect(memory.projectId).toBe('test-project');
    expect(memory.metadata).toEqual({ key: 'value' });
    expect(memory.accessCount).toBe(0);
  });

  it('should get memory by ID and increment access count', () => {
    const memory = createMemory(db, {
      content: 'Test content',
    });

    const retrieved1 = getMemoryById(db, memory.id);
    expect(retrieved1).not.toBeNull();
    expect(retrieved1!.id).toBe(memory.id);
    expect(retrieved1!.accessCount).toBe(1);

    const retrieved2 = getMemoryById(db, memory.id);
    expect(retrieved2!.accessCount).toBe(2);
  });

  it('should return null for non-existent ID', () => {
    const result = getMemoryById(db, 'fake-uuid-12345678');
    expect(result).toBeNull();
  });

  it('should list memories with pagination', () => {
    // Create 5 memories
    for (let i = 0; i < 5; i++) {
      createMemory(db, { content: `Memory ${i}` });
    }

    const result1 = listMemories(db, { limit: 2, offset: 0 });
    expect(result1.memories).toHaveLength(2);
    expect(result1.total).toBe(5);

    const result2 = listMemories(db, { limit: 2, offset: 2 });
    expect(result2.memories).toHaveLength(2);
    expect(result2.total).toBe(5);
  });

  it('should filter memories by project', () => {
    createMemory(db, { content: 'Project A memory', projectId: 'project-a' });
    createMemory(db, { content: 'Project B memory', projectId: 'project-b' });
    createMemory(db, { content: 'Project A memory 2', projectId: 'project-a' });

    const result = listMemories(db, {
      projectId: 'project-a',
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.memories.every((m) => m.projectId === 'project-a')).toBe(true);
  });

  it('should filter memories by source', () => {
    createMemory(db, { content: 'User memory', source: 'user' });
    createMemory(db, { content: 'Session memory', source: 'session-summary' });
    createMemory(db, { content: 'User memory 2', source: 'user' });

    const result = listMemories(db, {
      source: 'user',
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(2);
    expect(result.memories.every((m) => m.source === 'user')).toBe(true);
  });

  it('should delete memory and return true', () => {
    const memory = createMemory(db, { content: 'To be deleted' });

    const deleted = deleteMemory(db, memory.id, false);
    expect(deleted).toBe(true);

    const retrieved = getMemoryById(db, memory.id);
    expect(retrieved).toBeNull();
  });

  it('should return false when deleting non-existent memory', () => {
    const deleted = deleteMemory(db, 'fake-uuid-12345678', false);
    expect(deleted).toBe(false);
  });
});

describe('tag-repo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
  });

  it('should create and retrieve tags', () => {
    const tagId1 = ensureTag(db, 'typescript');
    expect(tagId1).toBeTypeOf('number');

    const tagId2 = ensureTag(db, 'typescript');
    expect(tagId2).toBe(tagId1); // Same tag should return same ID
  });

  it('should set and get tags for memory', () => {
    const memory = createMemory(db, { content: 'Tagged memory' });

    setMemoryTags(db, memory.id, ['typescript', 'architecture']);

    const tags = getTagsForMemory(db, memory.id);
    expect(tags).toHaveLength(2);
    expect(tags).toContain('typescript');
    expect(tags).toContain('architecture');
  });

  it('should replace tags when setting new ones', () => {
    const memory = createMemory(db, { content: 'Tagged memory' });

    setMemoryTags(db, memory.id, ['a', 'b']);
    let tags = getTagsForMemory(db, memory.id);
    expect(tags).toEqual(['a', 'b']);

    setMemoryTags(db, memory.id, ['c']);
    tags = getTagsForMemory(db, memory.id);
    expect(tags).toEqual(['c']);
  });

  it('should batch get tags for multiple memories', () => {
    const mem1 = createMemory(db, { content: 'Memory 1' });
    const mem2 = createMemory(db, { content: 'Memory 2' });
    const mem3 = createMemory(db, { content: 'Memory 3' });

    setMemoryTags(db, mem1.id, ['tag1', 'tag2']);
    setMemoryTags(db, mem2.id, ['tag3']);
    setMemoryTags(db, mem3.id, ['tag1', 'tag3']);

    const tagsMap = getTagsForMemories(db, [mem1.id, mem2.id, mem3.id]);

    expect(tagsMap.get(mem1.id)).toEqual(['tag1', 'tag2']);
    expect(tagsMap.get(mem2.id)).toEqual(['tag3']);
    expect(tagsMap.get(mem3.id)).toEqual(['tag1', 'tag3']);
  });
});

describe('chunk-repo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
  });

  it('should create chunks and search FTS', () => {
    const memory = createMemory(db, { content: 'Parent memory' });
    const dummyEmbedding = new Float32Array(768).fill(0.1);

    createChunks(
      db,
      memory.id,
      [
        {
          content: 'First chunk with typescript code',
          chunkIndex: 0,
          tokenCount: 10,
          embedding: dummyEmbedding,
        },
        {
          content: 'Second chunk with javascript code',
          chunkIndex: 1,
          tokenCount: 12,
          embedding: dummyEmbedding,
        },
      ],
      false,
    );

    const results = searchFTS(db, 'typescript', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('typescript');
    expect(results[0].memoryId).toBe(memory.id);
  });

  it('should delete chunks by memory ID', () => {
    const memory = createMemory(db, { content: 'Parent memory' });
    const dummyEmbedding = new Float32Array(768).fill(0.1);

    createChunks(
      db,
      memory.id,
      [
        {
          content: 'Chunk to delete',
          chunkIndex: 0,
          tokenCount: 10,
          embedding: dummyEmbedding,
        },
      ],
      false,
    );

    deleteByMemoryId(db, memory.id, false);

    const results = searchFTS(db, 'delete', 10);
    expect(results).toHaveLength(0);
  });
});

describe('task-repo', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, false);
  });

  it('should add and list tasks', () => {
    const task = addTask(db, {
      description: 'Test task',
      type: 'custom',
      priority: 1,
    });

    expect(task.id).toBeTruthy();
    expect(task.description).toBe('Test task');
    expect(task.status).toBe('pending');

    const tasks = listTasks(db, { limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
  });

  it('should get next pending task by priority', () => {
    addTask(db, { description: 'Low priority', type: 'custom', priority: 1 });
    addTask(db, { description: 'High priority', type: 'custom', priority: 10 });

    const nextTask = getNextPending(db);
    expect(nextTask).not.toBeNull();
    expect(nextTask!.description).toBe('High priority');
  });

  it('should claim and complete a task', () => {
    const task = addTask(db, { description: 'Task to complete', type: 'custom' });

    const claimed = claimTask(db, task.id);
    expect(claimed).toBe(true);

    const retrieved = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(retrieved.status).toBe('running');

    completeTask(db, task.id, {
      output: 'Task completed successfully',
      success: true,
    });

    const completed = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(completed.status).toBe('completed');
  });

  it('should fail a task with error', () => {
    const task = addTask(db, { description: 'Task to fail', type: 'custom' });

    claimTask(db, task.id);
    failTask(db, task.id, 'Something went wrong');

    const failed = db.prepare('SELECT status, retry_count FROM tasks WHERE id = ?').get(task.id) as {
      status: string;
      retry_count: number;
    };
    expect(failed.status).toBe('failed');
    expect(failed.retry_count).toBe(1);
  });

  it('should cancel a task', () => {
    const task = addTask(db, { description: 'Task to cancel', type: 'custom' });

    const cancelled = cancelTask(db, task.id);
    expect(cancelled).toBe(true);

    const retrieved = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(retrieved.status).toBe('cancelled');
  });
});
