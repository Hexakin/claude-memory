import type Database from 'better-sqlite3';
import type {
  Task,
  TaskType,
  TaskStatus,
  TaskResult,
  TaskAddInput,
  TaskListInput,
  TaskResultsInput,
} from '@claude-memory/shared';
import {
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from '@claude-memory/shared';

interface TaskRow {
  id: string;
  description: string;
  type: string;
  status: string;
  priority: number;
  project_id: string | null;
  repo_url: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  retry_count: number;
  max_retries: number;
  timeout_ms: number;
  context: string;
  created_at: string;
  updated_at: string;
}

interface TaskResultRow {
  id: string;
  task_id: string;
  output: string;
  summary: string | null;
  success: number;
  error: string | null;
  duration_ms: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  memory_id: string | null;
  created_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    description: row.description,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    priority: row.priority,
    projectId: row.project_id,
    repoUrl: row.repo_url,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    timeoutMs: row.timeout_ms,
    context: JSON.parse(row.context || '{}') as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskResult(row: TaskResultRow): TaskResult {
  return {
    id: row.id,
    taskId: row.task_id,
    output: row.output,
    summary: row.summary,
    success: row.success === 1,
    error: row.error,
    durationMs: row.duration_ms,
    tokensUsed: row.tokens_used,
    costUsd: row.cost_usd,
    memoryId: row.memory_id,
    createdAt: row.created_at,
  };
}

/**
 * Add a new task to the queue.
 */
export function addTask(db: Database.Database, input: TaskAddInput): Task {
  const row = db
    .prepare(
      `INSERT INTO tasks (description, type, priority, project_id, repo_url, scheduled_for, context, timeout_ms, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.description,
      input.type ?? 'custom',
      input.priority ?? 0,
      input.project ?? null,
      input.repoUrl ?? null,
      input.scheduledFor ?? null,
      JSON.stringify(input.context ?? {}),
      input.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      DEFAULT_MAX_RETRIES,
    ) as TaskRow;

  return rowToTask(row);
}

/**
 * Get the next pending task, ordered by priority (descending) then creation time (ascending).
 */
export function getNextPending(db: Database.Database): Task | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'pending'
         AND (scheduled_for IS NULL OR scheduled_for <= datetime('now'))
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    )
    .get() as TaskRow | undefined;

  return row ? rowToTask(row) : null;
}

/**
 * Atomically claim a pending task by setting its status to running.
 * Returns true if the task was claimed (was pending and is now running).
 */
export function claimTask(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE tasks
       SET status = 'running',
           started_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(id);

  return result.changes > 0;
}

/**
 * Mark a task as completed with its result.
 */
export function completeTask(
  db: Database.Database,
  id: string,
  result: {
    output: string;
    summary?: string;
    success: boolean;
    error?: string;
    durationMs?: number;
    tokensUsed?: number;
    costUsd?: number;
    memoryId?: string;
  },
): void {
  const complete = db.transaction(() => {
    // Update task status
    db.prepare(
      `UPDATE tasks
       SET status = 'completed',
           completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`,
    ).run(id);

    // Insert result record
    db.prepare(
      `INSERT INTO task_results (task_id, output, summary, success, error, duration_ms, tokens_used, cost_usd, memory_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      result.output,
      result.summary ?? null,
      result.success ? 1 : 0,
      result.error ?? null,
      result.durationMs ?? null,
      result.tokensUsed ?? null,
      result.costUsd ?? null,
      result.memoryId ?? null,
    );
  });

  complete();
}

/**
 * Mark a task as failed and increment its retry count.
 */
export function failTask(
  db: Database.Database,
  id: string,
  error: string,
): void {
  db.prepare(
    `UPDATE tasks
     SET status = 'failed',
         retry_count = retry_count + 1,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(id);

  // Insert a failure result
  db.prepare(
    `INSERT INTO task_results (task_id, output, success, error)
     VALUES (?, '', 0, ?)`,
  ).run(id, error);
}

/**
 * List tasks with optional filters.
 */
export function listTasks(
  db: Database.Database,
  filters: TaskListInput,
): Task[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status && filters.status !== 'all') {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters.project) {
    conditions.push('project_id = ?');
    params.push(filters.project);
  }

  if (filters.since) {
    conditions.push('created_at >= ?');
    params.push(filters.since);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT * FROM tasks ${whereClause}
       ORDER BY priority DESC, created_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as TaskRow[];

  return rows.map(rowToTask);
}

/**
 * Cancel a pending task. Returns true if the task was cancelled.
 */
export function cancelTask(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE tasks
       SET status = 'cancelled',
           updated_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
    )
    .run(id);

  return result.changes > 0;
}

/**
 * Get task results with optional filters.
 */
export function getTaskResults(
  db: Database.Database,
  filters: TaskResultsInput,
): TaskResult[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.taskId) {
    conditions.push('tr.task_id = ?');
    params.push(filters.taskId);
  }

  if (filters.since) {
    conditions.push('tr.created_at >= ?');
    params.push(filters.since);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT tr.* FROM task_results tr ${whereClause}
       ORDER BY tr.created_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as TaskResultRow[];

  return rows.map(rowToTaskResult);
}
