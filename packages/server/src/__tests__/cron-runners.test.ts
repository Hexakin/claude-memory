import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '@claude-memory/shared';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function(this: any) {
    this.messages = { create: mockCreate };
  } as any;
  return { default: MockAnthropic };
});

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => {
    // Return a function that calls mockExecFile as a promise
    return (...args: unknown[]) => {
      return mockExecFile(...args);
    };
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function createTestTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    description: 'Test task description',
    type: 'custom',
    status: 'running',
    priority: 0,
    projectId: null,
    repoUrl: null,
    scheduledFor: null,
    startedAt: '2025-01-01T00:00:00.000Z',
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

// ── AnthropicApiRunner Tests ───────────────────────────────────────────────────

describe('AnthropicApiRunner', () => {
  let AnthropicApiRunner: typeof import('../cron/api-runner.js').AnthropicApiRunner;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../cron/api-runner.js');
    AnthropicApiRunner = mod.AnthropicApiRunner;
  });

  it('should create runner with default model', () => {
    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });

    expect(runner.name).toBe('anthropic-api');
  });

  it('should call Anthropic API with correct parameters', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Review result' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask({ type: 'code-review' });

    await runner.run(task);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: expect.any(String),
        messages: [{ role: 'user', content: expect.any(String) }],
      }),
      expect.objectContaining({
        signal: expect.any(Object),
      }),
    );
  });

  it('should extract text from response', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask();

    const result = await runner.run(task);

    expect(result.success).toBe(true);
    expect(result.output).toBe('First block\n\nSecond block');
  });

  it('should calculate token usage and cost', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'output' }],
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    });

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask();

    const result = await runner.run(task);

    expect(result.tokensUsed).toBe(1_100_000);
    // Cost: (1M / 1M) * 3 + (100K / 1M) * 15 = 3 + 1.5 = 4.5
    expect(result.costUsd).toBe(4.5);
  });

  it('should handle API timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockCreate.mockRejectedValue(abortError);

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask({ timeoutMs: 5000 });

    const result = await runner.run(task);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Task timed out after 5000ms');
    expect(result.output).toBe('');
  });

  it('should handle API error gracefully', async () => {
    mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask();

    const result = await runner.run(task);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Rate limit exceeded');
    expect(result.output).toBe('');
  });

  it('should include repo URL in system prompt when present', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'output' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask({ repoUrl: 'https://github.com/user/repo' });

    await runner.run(task);

    const systemPrompt = mockCreate.mock.calls[0][0].system as string;
    expect(systemPrompt).toContain('https://github.com/user/repo');
  });

  it('should include context in system prompt when present', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'output' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const runner = new AnthropicApiRunner({ apiKey: 'test-key' });
    const task = createTestTask({
      context: { branch: 'main', scope: 'api' },
    });

    await runner.run(task);

    const systemPrompt = mockCreate.mock.calls[0][0].system as string;
    expect(systemPrompt).toContain('branch');
    expect(systemPrompt).toContain('main');
  });
});

// ── CliRunner Tests ────────────────────────────────────────────────────────────

describe('CliRunner', () => {
  let CliRunner: typeof import('../cron/cli-runner.js').CliRunner;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../cron/cli-runner.js');
    CliRunner = mod.CliRunner;
  });

  it('should execute claude with --print flag', async () => {
    mockExecFile.mockResolvedValue({
      stdout: 'CLI output result',
      stderr: '',
    });

    const runner = new CliRunner();
    const task = createTestTask();

    const result = await runner.run(task);

    expect(result.success).toBe(true);
    expect(result.output).toBe('CLI output result');

    // Verify the command was called with --print
    const callArgs = mockExecFile.mock.calls[0];
    // execFileAsync is promisified, so args are (cmd, args, options)
    // But since we mock promisify, the args go through directly
    expect(callArgs[0]).toBe('claude');
    const cmdArgs = callArgs[1] as string[];
    expect(cmdArgs).toContain('--print');
  });

  it('should pass --cwd when clonePath is in context', async () => {
    mockExecFile.mockResolvedValue({
      stdout: 'output',
      stderr: '',
    });

    const runner = new CliRunner();
    const task = createTestTask({
      context: { clonePath: '/tmp/clone-dir' },
    });

    await runner.run(task);

    const cmdArgs = mockExecFile.mock.calls[0][1] as string[];
    expect(cmdArgs).toContain('--cwd');
    expect(cmdArgs).toContain('/tmp/clone-dir');
  });

  it('should handle command timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockExecFile.mockRejectedValue(abortError);

    const runner = new CliRunner();
    const task = createTestTask({ timeoutMs: 10000 });

    const result = await runner.run(task);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Task timed out after 10000ms');
  });

  it('should handle command failure', async () => {
    mockExecFile.mockRejectedValue(new Error('Command not found: claude'));

    const runner = new CliRunner();
    const task = createTestTask();

    const result = await runner.run(task);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Command not found: claude');
  });

  it('should strip clonePath from prompt context', async () => {
    mockExecFile.mockResolvedValue({
      stdout: 'output',
      stderr: '',
    });

    const runner = new CliRunner();
    const task = createTestTask({
      context: { clonePath: '/tmp/clone', branch: 'main' },
    });

    await runner.run(task);

    // The last argument is the prompt text
    const cmdArgs = mockExecFile.mock.calls[0][1] as string[];
    const prompt = cmdArgs[cmdArgs.length - 1];
    expect(prompt).not.toContain('clonePath');
    expect(prompt).toContain('branch');
    expect(prompt).toContain('main');
  });
});
