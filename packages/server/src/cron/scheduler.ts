import cron from 'node-cron';
import pino from 'pino';
import type Database from 'better-sqlite3';
import type { Task } from '@claude-memory/shared';
import { DEFAULT_CRON_SCHEDULE } from '@claude-memory/shared';
import {
  getNextPending,
  claimTask,
  completeTask,
  failTask,
} from '../db/task-repo.js';
import type { TaskRunner, TaskRunResult } from './runner.js';
import { cloneRepo, cleanupClone, createTempDir } from './codebase-access.js';

const log = pino({ name: 'scheduler' });

export interface SchedulerOptions {
  db: Database.Database;
  runner: TaskRunner;
  cronSchedule?: string;
  enabled?: boolean;
  onTaskComplete?: (task: Task, result: TaskRunResult) => Promise<void>;
}

interface SchedulerStats {
  tasksCompleted: number;
  tasksFailed: number;
  lastRunAt: string | null;
}

export class CronScheduler {
  private readonly db: Database.Database;
  private readonly runner: TaskRunner;
  private readonly cronSchedule: string;
  private readonly onTaskComplete?: (task: Task, result: TaskRunResult) => Promise<void>;

  private cronTask: cron.ScheduledTask | null = null;
  private processing = false;
  private stats: SchedulerStats = {
    tasksCompleted: 0,
    tasksFailed: 0,
    lastRunAt: null,
  };

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.runner = options.runner;
    this.cronSchedule = options.cronSchedule ?? DEFAULT_CRON_SCHEDULE;
    this.onTaskComplete = options.onTaskComplete;

    if (options.enabled === false) {
      log.info('Scheduler created in disabled mode');
    }
  }

  /**
   * Start the cron job. Also immediately checks for overdue pending tasks.
   */
  start(): void {
    if (this.cronTask) {
      log.warn('Scheduler already started');
      return;
    }

    log.info({ schedule: this.cronSchedule, runner: this.runner.name }, 'Starting cron scheduler');

    this.cronTask = cron.schedule(this.cronSchedule, () => {
      this.processPendingTasks().catch((err) => {
        log.error({ err }, 'Unhandled error in cron task processing');
      });
    });

    // Immediately check for overdue pending tasks
    this.processPendingTasks().catch((err) => {
      log.error({ err }, 'Unhandled error in initial task processing');
    });
  }

  /**
   * Stop the cron job. Waits for the current task to finish (does not abort it).
   */
  stop(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
      log.info('Cron scheduler stopped');
    }
  }

  /**
   * Whether a task is currently being processed.
   */
  isRunning(): boolean {
    return this.processing;
  }

  /**
   * Get scheduler statistics.
   */
  getStats(): SchedulerStats {
    return { ...this.stats };
  }

  /**
   * Process all pending tasks sequentially, one at a time.
   */
  private async processPendingTasks(): Promise<void> {
    if (this.processing) {
      log.debug('Already processing tasks, skipping this run');
      return;
    }

    this.processing = true;
    this.stats.lastRunAt = new Date().toISOString();
    log.info('Starting task processing run');

    try {
      let task = getNextPending(this.db);

      while (task !== null) {
        await this.processTask(task);
        // Get the next pending task
        task = getNextPending(this.db);
      }

      log.info('Task processing run complete — no more pending tasks');
    } catch (err) {
      log.error({ err }, 'Fatal error during task processing run');
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single task: claim, run, and record the result.
   */
  private async processTask(task: Task): Promise<void> {
    const taskLog = log.child({ taskId: task.id, type: task.type });

    // Atomically claim the task
    const claimed = claimTask(this.db, task.id);
    if (!claimed) {
      taskLog.warn('Failed to claim task (may have been claimed by another process)');
      return;
    }

    taskLog.info({ description: task.description }, 'Task claimed, starting execution');

    let clonePath: string | undefined;
    const startTime = Date.now();

    try {
      // Clone repo if needed
      if (task.repoUrl) {
        clonePath = await this.cloneForTask(task, taskLog);
        if (clonePath) {
          // Inject clone path into task context so the runner can use it
          task = {
            ...task,
            context: { ...task.context, clonePath },
          };
        }
      }

      // Execute the task via the runner
      const result = await this.runner.run(task);
      const durationMs = Date.now() - startTime;

      if (result.success) {
        // Task succeeded — record completion
        completeTask(this.db, task.id, {
          output: result.output,
          summary: result.summary,
          success: true,
          durationMs,
          tokensUsed: result.tokensUsed,
          costUsd: result.costUsd,
        });
        this.stats.tasksCompleted++;
        taskLog.info({ durationMs, tokensUsed: result.tokensUsed }, 'Task completed successfully');
      } else {
        // Task failed — check retry eligibility
        await this.handleTaskFailure(task, result.error ?? 'Unknown error', durationMs, taskLog);
      }

      // Invoke the onTaskComplete callback
      if (this.onTaskComplete) {
        try {
          await this.onTaskComplete(task, result);
        } catch (cbErr) {
          taskLog.error({ err: cbErr }, 'Error in onTaskComplete callback');
        }
      }
    } catch (err) {
      // Unexpected error during task processing
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      taskLog.error({ err, durationMs }, 'Unexpected error processing task');

      await this.handleTaskFailure(task, errorMessage, durationMs, taskLog);
    } finally {
      // Clean up cloned repo
      if (clonePath) {
        try {
          await cleanupClone(clonePath);
          taskLog.debug({ clonePath }, 'Cleaned up cloned repo');
        } catch (cleanupErr) {
          taskLog.warn({ err: cleanupErr, clonePath }, 'Failed to clean up cloned repo');
        }
      }
    }
  }

  /**
   * Handle a task failure with retry logic.
   */
  private async handleTaskFailure(
    task: Task,
    error: string,
    durationMs: number,
    taskLog: pino.Logger,
  ): Promise<void> {
    if (task.retryCount < task.maxRetries) {
      // Re-queue for retry: set status back to pending and increment retry count
      taskLog.info(
        { retryCount: task.retryCount + 1, maxRetries: task.maxRetries, error },
        'Task failed, re-queuing for retry',
      );

      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'pending',
               retry_count = retry_count + 1,
               started_at = NULL,
               updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(task.id);
    } else {
      // Permanently fail the task
      taskLog.error(
        { retryCount: task.retryCount, maxRetries: task.maxRetries, error, durationMs },
        'Task failed permanently (max retries exceeded)',
      );

      failTask(this.db, task.id, error);
      this.stats.tasksFailed++;
    }
  }

  /**
   * Clone a repository for the task. Returns the clone path or undefined on failure.
   */
  private async cloneForTask(
    task: Task,
    taskLog: pino.Logger,
  ): Promise<string | undefined> {
    if (!task.repoUrl) return undefined;

    try {
      const tempDir = await createTempDir(`claude-memory-task-${task.id}-`);
      const token = task.context?.['githubToken'] as string | undefined;
      const branch = task.context?.['branch'] as string | undefined;

      taskLog.info({ repoUrl: task.repoUrl, tempDir }, 'Cloning repository');

      await cloneRepo(task.repoUrl, tempDir, { branch, token });

      taskLog.info({ tempDir }, 'Repository cloned successfully');
      return tempDir;
    } catch (err) {
      taskLog.error({ err, repoUrl: task.repoUrl }, 'Failed to clone repository');
      return undefined;
    }
  }
}
