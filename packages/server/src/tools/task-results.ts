import type { ServerContext } from '../server.js';
import type { TaskResultsInput, TaskResultsOutput } from '@claude-memory/shared';
import { getTaskResults } from '../db/task-repo.js';

export async function handleTaskResults(
  ctx: ServerContext,
  input: TaskResultsInput,
): Promise<TaskResultsOutput> {
  const results = getTaskResults(ctx.globalDb, input);

  return {
    results: results.map((r) => ({
      taskId: r.taskId,
      description: r.description ?? 'Unknown task',
      summary: r.summary,
      success: r.success,
      error: r.error,
      completedAt: r.createdAt,
      durationMs: r.durationMs,
      tokensUsed: r.tokensUsed,
      costUsd: r.costUsd,
    })),
  };
}
