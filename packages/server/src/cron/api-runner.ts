import Anthropic from '@anthropic-ai/sdk';
import type { Task } from '@claude-memory/shared';
import type { TaskRunner, TaskRunResult } from './runner.js';

/** Cost per million tokens for Claude Sonnet (approximate) */
const SONNET_INPUT_COST_PER_MTOK = 3;
const SONNET_OUTPUT_COST_PER_MTOK = 15;

interface ApiRunnerOptions {
  apiKey: string;
  model?: string;
}

export class AnthropicApiRunner implements TaskRunner {
  readonly name = 'anthropic-api';

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: ApiRunnerOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-sonnet-4-20250514';
  }

  async run(task: Task): Promise<TaskRunResult> {
    const systemPrompt = this.buildSystemPrompt(task);
    const userMessage = this.buildUserMessage(task);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);

    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: controller.signal },
      );

      const outputBlocks = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text);
      const output = outputBlocks.join('\n\n');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const tokensUsed = inputTokens + outputTokens;
      const costUsd =
        (inputTokens / 1_000_000) * SONNET_INPUT_COST_PER_MTOK +
        (outputTokens / 1_000_000) * SONNET_OUTPUT_COST_PER_MTOK;

      return {
        output,
        summary: output.length > 500 ? output.slice(0, 500) + '...' : output,
        success: true,
        tokensUsed,
        costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // round to 6 decimal places
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';

      return {
        output: '',
        success: false,
        error: isAbort ? `Task timed out after ${task.timeoutMs}ms` : message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async dispose(): Promise<void> {
    // SDK client does not need cleanup
  }

  private buildSystemPrompt(task: Task): string {
    const parts: string[] = [
      'You are an automated assistant running an overnight task.',
      `Task type: ${task.type}`,
    ];

    if (task.description) {
      parts.push(`Task description: ${task.description}`);
    }

    if (task.repoUrl) {
      parts.push(`Repository: ${task.repoUrl}`);
    }

    if (task.context && Object.keys(task.context).length > 0) {
      parts.push(`Additional context: ${JSON.stringify(task.context)}`);
    }

    parts.push(
      '',
      'Provide a thorough, actionable response. If reviewing code, include specific file paths and line numbers where relevant.',
    );

    return parts.join('\n');
  }

  private buildUserMessage(task: Task): string {
    const parts: string[] = [];

    switch (task.type) {
      case 'code-review':
        parts.push('Please review the codebase and provide feedback on code quality, potential bugs, and improvements.');
        break;
      case 'test-runner':
        parts.push('Analyze the test suite and suggest missing test cases or improvements to existing tests.');
        break;
      case 'doc-updater':
        parts.push('Review and suggest improvements to the project documentation.');
        break;
      case 'refactor':
        parts.push('Identify refactoring opportunities and suggest specific improvements.');
        break;
      case 'custom':
      default:
        parts.push(task.description);
        break;
    }

    return parts.join('\n');
  }
}
