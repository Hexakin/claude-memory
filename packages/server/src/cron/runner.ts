import type { Task } from '@claude-memory/shared';

export interface TaskRunResult {
  output: string;
  summary?: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
  costUsd?: number;
}

export interface TaskRunner {
  name: string;
  run(task: Task): Promise<TaskRunResult>;
  dispose?(): Promise<void>;
}
