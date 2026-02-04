import type { ServerContext } from '../server.js';
import type { TaskListInput, TaskListOutput } from '@claude-memory/shared';
import { listTasks } from '../db/task-repo.js';

export async function handleTaskList(
  ctx: ServerContext,
  input: TaskListInput,
): Promise<TaskListOutput> {
  const tasks = listTasks(ctx.globalDb, input);

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status,
      type: t.type,
      createdAt: t.createdAt,
      scheduledFor: t.scheduledFor,
    })),
  };
}
