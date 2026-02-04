import type { ServerContext } from '../server.js';
import type { TaskCancelInput, TaskCancelOutput } from '@claude-memory/shared';
import { cancelTask } from '../db/task-repo.js';

export async function handleTaskCancel(
  ctx: ServerContext,
  input: TaskCancelInput,
): Promise<TaskCancelOutput> {
  const result = cancelTask(ctx.globalDb, input.id);

  return {
    cancelled: result,
  };
}
