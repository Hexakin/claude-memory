import type { ServerContext } from '../server.js';
import type { TaskAddInput, TaskAddOutput } from '@claude-memory/shared';
import { addTask } from '../db/task-repo.js';

export async function handleTaskAdd(
  ctx: ServerContext,
  input: TaskAddInput,
): Promise<TaskAddOutput> {
  const task = addTask(ctx.globalDb, input);

  return {
    id: task.id,
    scheduledFor: task.scheduledFor ?? 'next cron window',
  };
}
