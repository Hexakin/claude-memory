import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from '@claude-memory/shared';
import type { TaskRunner, TaskRunResult } from './runner.js';

const execFileAsync = promisify(execFile);

export class CliRunner implements TaskRunner {
  readonly name = 'cli';

  async run(task: Task): Promise<TaskRunResult> {
    const prompt = this.buildPrompt(task);
    const args = ['--print', '--max-turns', '10'];

    // If the task has a clone path in context, use it as cwd
    const clonePath = task.context?.['clonePath'] as string | undefined;
    if (clonePath) {
      args.push('--cwd', clonePath);
    }

    // Pass the prompt as the final positional argument
    args.push(prompt);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);

    try {
      const { stdout, stderr } = await execFileAsync('claude', args, {
        signal: controller.signal,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: task.timeoutMs,
      });

      const output = stdout.trim();
      const hasError = stderr && stderr.trim().length > 0;

      return {
        output: output || stderr || '',
        summary: output.length > 500 ? output.slice(0, 500) + '...' : output,
        success: !hasError || output.length > 0,
        error: hasError ? stderr.trim() : undefined,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isTimeout =
        isAbort ||
        (err instanceof Error && 'killed' in err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT');

      // Try to extract partial output from the error
      const partialStdout =
        err !== null && typeof err === 'object' && 'stdout' in err
          ? String((err as { stdout: unknown }).stdout).trim()
          : '';

      return {
        output: partialStdout,
        success: false,
        error: isTimeout
          ? `Task timed out after ${task.timeoutMs}ms`
          : message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async dispose(): Promise<void> {
    // No cleanup needed
  }

  private buildPrompt(task: Task): string {
    const parts: string[] = [];

    parts.push(task.description);

    if (task.context && Object.keys(task.context).length > 0) {
      // Exclude clonePath from the context passed to the prompt
      const contextForPrompt = { ...task.context };
      delete contextForPrompt['clonePath'];

      if (Object.keys(contextForPrompt).length > 0) {
        parts.push('');
        parts.push(`Additional context: ${JSON.stringify(contextForPrompt)}`);
      }
    }

    if (task.repoUrl) {
      parts.push('');
      parts.push(`Repository: ${task.repoUrl}`);
    }

    return parts.join('\n');
  }
}
