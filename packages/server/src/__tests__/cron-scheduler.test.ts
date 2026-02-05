import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task } from '@claude-memory/shared';
import type { TaskRunner, TaskRunResult } from '../cron/runner.js';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockCronStop = vi.fn();
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ stop: mockCronStop })),
  },
}));

const mockGetNextPending = vi.fn();
const mockClaimTask = vi.fn();
const mockCompleteTask = vi.fn();
const mockFailTask = vi.fn();
const mockRequeueTask = vi.fn();

vi.mock('../db/task-repo.js', () => ({
  getNextPending: (...args: unknown[]) => mockGetNextPending(...args),
  claimTask: (...args: unknown[]) => mockClaimTask(...args),
  completeTask: (...args: unknown[]) => mockCompleteTask(...args),
  failTask: (...args: unknown[]) => mockFailTask(...args),
  requeueTask: (...args: unknown[]) => mockRequeueTask(...args),
}));

vi.mock('./codebase-access.js', () => ({
  cloneRepo: vi.fn(),
  cleanupClone: vi.fn(),
  createTempDir: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Flush multiple levels of microtasks so the full async chain resolves. */
async function flushPromises(count = 10) {
  for (let i = 0; i < count; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Test task description',
    type: 'custom',
    status: 'pending',
    priority: 0,
    projectId: null,
    repoUrl: null,
    scheduledFor: null,
    startedAt: null,
    completedAt: null,
    retryCount: 0,
    maxRetries: 1,
    timeoutMs: 30000,
    context: {},
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockRunner(overrides: Partial<TaskRunner> = {}): TaskRunner {
  return {
    name: 'test',
    run: vi.fn().mockResolvedValue({
      output: 'test output',
      summary: 'test summary',
      success: true,
      tokensUsed: 100,
      costUsd: 0.001,
    } satisfies TaskRunResult),
    ...overrides,
  };
}

// Fake db — just needs to be passed through; never called directly by scheduler
const fakeDb = {} as any;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CronScheduler', () => {
  let CronScheduler: typeof import('../cron/scheduler.js').CronScheduler;
  let cron: typeof import('node-cron');

  beforeEach(async () => {
    vi.useFakeTimers();

    // clearAllMocks resets call counts for ALL mocks (including cron.schedule)
    vi.clearAllMocks();

    // mockReset additionally clears queued mockReturnValueOnce entries
    // (vi.clearAllMocks does NOT clear those)
    mockGetNextPending.mockReset();
    mockClaimTask.mockReset();
    mockCompleteTask.mockReset();
    mockFailTask.mockReset();
    mockRequeueTask.mockReset();

    // Re-set defaults after reset
    mockGetNextPending.mockReturnValue(null);
    mockClaimTask.mockReturnValue(true);
    mockCompleteTask.mockReturnValue(undefined);
    mockFailTask.mockReturnValue(undefined);
    mockRequeueTask.mockReturnValue(undefined);

    // Dynamic import so mocks are in place
    const schedulerModule = await import('../cron/scheduler.js');
    CronScheduler = schedulerModule.CronScheduler;
    const cronModule = await import('node-cron');
    cron = cronModule.default;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Scheduler creation ───────────────────────────────────────────────────

  describe('scheduler creation', () => {
    it('should create scheduler with default options', () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      expect(scheduler).toBeDefined();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should create scheduler with custom cron schedule', () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({
        db: fakeDb,
        runner,
        cronSchedule: '*/5 * * * *',
      });

      expect(scheduler).toBeDefined();
    });

    it('should not start if enabled is false', () => {
      const runner = createMockRunner();
      const _scheduler = new CronScheduler({
        db: fakeDb,
        runner,
        enabled: false,
      });

      // Scheduler was created but cron.schedule should not be called
      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });

  // ── Starting and stopping ────────────────────────────────────────────────

  describe('starting and stopping', () => {
    it('should schedule cron job on start', () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      scheduler.start();

      expect(cron.schedule).toHaveBeenCalledTimes(1);
      expect(cron.schedule).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
      );
    });

    it('should do immediate pending task check on start', async () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      scheduler.start();

      // Let the microtask queue flush (processPendingTasks is fire-and-forget)
      await vi.advanceTimersByTimeAsync(0);

      expect(mockGetNextPending).toHaveBeenCalledWith(fakeDb);
    });

    it('should stop cron job on stop', () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      scheduler.start();
      scheduler.stop();

      expect(mockCronStop).toHaveBeenCalledTimes(1);
    });

    it('should warn if started twice', () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      scheduler.start();
      scheduler.start(); // second call should be a no-op with warning

      // cron.schedule should only be called once
      expect(cron.schedule).toHaveBeenCalledTimes(1);
    });
  });

  // ── Task processing ──────────────────────────────────────────────────────

  describe('task processing', () => {
    it('should claim and process a pending task successfully', async () => {
      const task = createTestTask();
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      // Return one task, then null (no more pending)
      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);
      mockClaimTask.mockReturnValue(true);

      scheduler.start();
      await flushPromises();

      expect(mockClaimTask).toHaveBeenCalledWith(fakeDb, task.id);
      expect(runner.run).toHaveBeenCalledWith(task);
      expect(mockCompleteTask).toHaveBeenCalledWith(
        fakeDb,
        task.id,
        expect.objectContaining({
          output: 'test output',
          summary: 'test summary',
          success: true,
          tokensUsed: 100,
          costUsd: 0.001,
        }),
      );
    });

    it('should handle task runner failure with retry', async () => {
      const task = createTestTask({ retryCount: 0, maxRetries: 1 });
      const failResult: TaskRunResult = {
        output: '',
        success: false,
        error: 'Something went wrong',
      };
      const runner = createMockRunner({
        run: vi.fn().mockResolvedValue(failResult),
      });

      const scheduler = new CronScheduler({ db: fakeDb, runner });
      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      // retryCount (0) < maxRetries (1) → should re-queue, not permanently fail
      expect(mockRequeueTask).toHaveBeenCalledWith(fakeDb, task.id);
      expect(mockFailTask).not.toHaveBeenCalled();
    });

    it('should permanently fail task when max retries exceeded', async () => {
      const task = createTestTask({ retryCount: 1, maxRetries: 1 });
      const failResult: TaskRunResult = {
        output: '',
        success: false,
        error: 'Permanent failure',
      };
      const runner = createMockRunner({
        run: vi.fn().mockResolvedValue(failResult),
      });
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      // retryCount (1) >= maxRetries (1) → should permanently fail
      expect(mockFailTask).toHaveBeenCalledWith(fakeDb, task.id, 'Permanent failure');
    });

    it('should process multiple pending tasks sequentially', async () => {
      const task1 = createTestTask({ id: 'task-1' });
      const task2 = createTestTask({ id: 'task-2' });
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      // Return two tasks, then null
      mockGetNextPending
        .mockReturnValueOnce(task1)
        .mockReturnValueOnce(task2)
        .mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      expect(runner.run).toHaveBeenCalledTimes(2);
      expect(mockClaimTask).toHaveBeenCalledWith(fakeDb, 'task-1');
      expect(mockClaimTask).toHaveBeenCalledWith(fakeDb, 'task-2');
    });

    it('should skip if already processing (re-entrancy guard)', async () => {
      const task = createTestTask();
      // Make the runner slow so we can trigger re-entrancy
      let resolveRun: (value: TaskRunResult) => void;
      const slowRunPromise = new Promise<TaskRunResult>((resolve) => {
        resolveRun = resolve;
      });
      const runner = createMockRunner({
        run: vi.fn().mockReturnValue(slowRunPromise),
      });
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      mockGetNextPending
        .mockReturnValueOnce(task)
        .mockReturnValueOnce(null);

      scheduler.start();

      // scheduler should be running (task is in-flight, runner hasn't resolved)
      expect(scheduler.isRunning()).toBe(true);

      // Fire the cron callback — this should be rejected by the re-entrancy guard
      const cronCallback = vi.mocked(cron.schedule).mock.calls[0][1] as () => void;
      cronCallback();

      // runner.run should only have been called once (for the original task)
      expect(runner.run).toHaveBeenCalledTimes(1);

      // Resolve the runner to clean up
      resolveRun!({ output: 'done', success: true });
      await flushPromises();

      // Now processing is complete
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should handle runner throwing an error', async () => {
      const task = createTestTask({ retryCount: 1, maxRetries: 1 });
      const runner = createMockRunner({
        run: vi.fn().mockRejectedValue(new Error('Runner crashed')),
      });
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      // Should permanently fail since retryCount >= maxRetries
      expect(mockFailTask).toHaveBeenCalledWith(fakeDb, task.id, 'Runner crashed');
    });

    it('should call onTaskComplete callback after task completion', async () => {
      const task = createTestTask();
      const runner = createMockRunner();
      const onTaskComplete = vi.fn().mockResolvedValue(undefined);
      const scheduler = new CronScheduler({
        db: fakeDb,
        runner,
        onTaskComplete,
      });

      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      expect(onTaskComplete).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ success: true, output: 'test output' }),
      );
    });
  });

  // ── Stats ────────────────────────────────────────────────────────────────

  describe('stats', () => {
    it('should track tasksCompleted count', async () => {
      const task = createTestTask();
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      const stats = scheduler.getStats();
      expect(stats.tasksCompleted).toBe(1);
    });

    it('should track tasksFailed count', async () => {
      const task = createTestTask({ retryCount: 1, maxRetries: 1 });
      const runner = createMockRunner({
        run: vi.fn().mockResolvedValue({
          output: '',
          success: false,
          error: 'fail',
        }),
      });
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      mockGetNextPending.mockReturnValueOnce(task).mockReturnValueOnce(null);

      scheduler.start();
      await flushPromises();

      const stats = scheduler.getStats();
      expect(stats.tasksFailed).toBe(1);
    });

    it('should update lastRunAt timestamp', async () => {
      const runner = createMockRunner();
      const scheduler = new CronScheduler({ db: fakeDb, runner });

      const statsBefore = scheduler.getStats();
      expect(statsBefore.lastRunAt).toBeNull();

      scheduler.start();
      await flushPromises();

      const statsAfter = scheduler.getStats();
      expect(statsAfter.lastRunAt).not.toBeNull();
      expect(typeof statsAfter.lastRunAt).toBe('string');
    });
  });
});
