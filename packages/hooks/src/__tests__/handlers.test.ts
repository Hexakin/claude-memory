import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryClient } from '../lib/memory-client.js';
import type { ExtractedKnowledge } from '../lib/transcript-parser.js';

// Mock modules
vi.mock('../lib/project-detect.js', () => ({
  detectProject: vi.fn().mockResolvedValue({
    projectId: 'abc123',
    projectName: 'test-project'
  })
}));

vi.mock('../lib/memory-client.js', () => ({
  createMemoryClient: vi.fn()
}));

vi.mock('../lib/transcript-parser.js', () => ({
  parseTranscript: vi.fn(),
  summarizeTranscript: vi.fn(),
  extractKnowledge: vi.fn(),
  formatKnowledgeForStorage: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  createHookLogger: vi.fn().mockReturnValue({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Import after mocks are set up
import { detectProject } from '../lib/project-detect.js';
import { createMemoryClient } from '../lib/memory-client.js';
import { parseTranscript, extractKnowledge, formatKnowledgeForStorage } from '../lib/transcript-parser.js';
import { handleSessionStart } from '../handlers/session-start.js';
import { handleSessionEnd } from '../handlers/session-end.js';

// Helper: create a valid HookInput for SessionStart
function makeSessionStartInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'SessionStart' as const,
    session_id: 'sess_test_123',
    cwd: '/test/project',
    ...overrides,
  };
}

// Helper: create a valid HookInput for SessionEnd
function makeSessionEndInput(overrides?: Record<string, unknown>) {
  return {
    hook_event_name: 'SessionEnd' as const,
    session_id: 'sess_test_123',
    cwd: '/test/project',
    transcript_path: '/path/to/transcript.jsonl',
    ...overrides,
  };
}

const mockKnowledge: ExtractedKnowledge = {
  topic: 'Implementing JWT authentication',
  decisions: ['Use JWT tokens with refresh tokens'],
  learnings: ['The trick is to set token expiry to 15 minutes'],
  problemsSolved: ['Fixed token validation by checking issuer field'],
  filesModified: ['auth.ts', 'middleware.ts'],
  commands: ['npm test'],
};

describe('handlers', () => {
  let mockMemoryClient: MemoryClient;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock memory client with health, list, search, store
    mockMemoryClient = {
      search: vi.fn().mockResolvedValue([]),
      store: vi.fn().mockResolvedValue({ id: 'mem_test', chunks: 1 }),
      list: vi.fn().mockResolvedValue([]),
      health: vi.fn().mockResolvedValue(true),
    };

    vi.mocked(createMemoryClient).mockReturnValue(mockMemoryClient);
    vi.mocked(detectProject).mockResolvedValue({
      projectId: 'abc123',
      projectName: 'test-project'
    });
  });

  describe('handleSessionStart', () => {
    it('returns additionalContext with project memories', async () => {
      const projectMemories = [
        { id: '1', content: 'Project uses TypeScript', score: 0.9, tags: ['language'], source: null, createdAt: '2024-01-01' },
        { id: '2', content: 'Uses React for frontend', score: 0.8, tags: ['framework'], source: null, createdAt: '2024-01-01' }
      ];

      // list returns empty (no rules), first search returns project memories
      vi.mocked(mockMemoryClient.search).mockResolvedValueOnce(projectMemories);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toBeDefined();
      expect(result.additionalContext).toContain('test-project');
      expect(result.additionalContext).toContain('Project uses TypeScript');
      expect(result.additionalContext).toContain('Uses React for frontend');
    });

    it('returns additionalContext with global memories', async () => {
      const globalMemories = [
        { id: '3', content: 'User prefers functional programming', score: 0.85, tags: ['preference'], source: null, createdAt: '2024-01-01' },
        { id: '4', content: 'Always include error handling', score: 0.75, tags: ['practice'], source: null, createdAt: '2024-01-01' }
      ];

      // 3 search calls: project (empty), recent (empty), global (has results)
      vi.mocked(mockMemoryClient.search)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(globalMemories);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toBeDefined();
      expect(result.additionalContext).toContain('User prefers functional programming');
      expect(result.additionalContext).toContain('Always include error handling');
    });

    it('returns empty object when no memories found', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);
      vi.mocked(mockMemoryClient.list).mockResolvedValue([]);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result).toEqual({});
    });

    it('includes project name in context header', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValueOnce([
        { id: '5', content: 'Memory 1', score: 0.9, tags: [], source: null, createdAt: '2024-01-01' }
      ]);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toContain('test-project');
      expect(result.additionalContext).toMatch(/Project:\s*test-project/i);
    });

    it('handles missing project name gracefully', async () => {
      vi.mocked(detectProject).mockResolvedValue({
        projectId: 'abc123',
        projectName: null
      });

      vi.mocked(mockMemoryClient.search).mockResolvedValueOnce([
        { id: '6', content: 'Memory 1', score: 0.9, tags: [], source: null, createdAt: '2024-01-01' }
      ]);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toBeDefined();
      expect(result.additionalContext).not.toContain('null');
    });

    it('calls search with correct parameters for project memories', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      await handleSessionStart(makeSessionStartInput());

      // Multi-query: 3 project queries with maxResults: 3 each
      expect(mockMemoryClient.search).toHaveBeenCalledWith(
        expect.stringContaining('test-project'),
        expect.objectContaining({
          scope: 'project',
          project: 'abc123',
          maxResults: 3
        })
      );
    });

    it('calls search with correct parameters for global memories', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      await handleSessionStart(makeSessionStartInput());

      // Third search call is for global memories
      expect(mockMemoryClient.search).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          scope: 'global',
          maxResults: 3
        })
      );
    });

    it('fetches rules via list with tag=rule', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      await handleSessionStart(makeSessionStartInput());

      expect(mockMemoryClient.list).toHaveBeenCalledWith({ tag: 'rule' });
    });

    it('includes rules section when rules exist', async () => {
      vi.mocked(mockMemoryClient.list).mockResolvedValue([
        { id: 'r1', content: 'Always use TypeScript strict mode', tags: ['rule'], source: null, createdAt: '2024-01-01', memoryType: 'rule', importanceScore: 0.9, isRule: true },
      ]);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toContain('Rules (Always Apply)');
      expect(result.additionalContext).toContain('Always use TypeScript strict mode');
    });

    it('injects warning when server is unhealthy', async () => {
      vi.mocked(mockMemoryClient.health).mockResolvedValue(false);

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toContain('WARNING');
      expect(result.additionalContext).toContain('unreachable');
      expect(mockMemoryClient.search).not.toHaveBeenCalled();
    });

    it('checks health before searching', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      await handleSessionStart(makeSessionStartInput());

      expect(mockMemoryClient.health).toHaveBeenCalledTimes(1);
    });

    it('marks mistakes with PITFALL prefix in recent learnings', async () => {
      // Multi-query: 3 project queries (empty), 2 recent queries (one with mistake), 2 global queries (empty)
      vi.mocked(mockMemoryClient.search)
        .mockResolvedValueOnce([]) // project query 1
        .mockResolvedValueOnce([]) // project query 2
        .mockResolvedValueOnce([]) // project query 3
        .mockResolvedValueOnce([
          { id: 'm1', content: 'Avoid shell injection', score: 0.9, tags: ['mistake'], source: null, createdAt: '2024-01-01' },
        ]) // recent query 1
        .mockResolvedValueOnce([]) // recent query 2
        .mockResolvedValueOnce([]) // global query 1
        .mockResolvedValueOnce([]); // global query 2

      const result = await handleSessionStart(makeSessionStartInput());

      expect(result.additionalContext).toContain('[PITFALL]');
      expect(result.additionalContext).toContain('Avoid shell injection');
    });
  });

  describe('handleSessionEnd', () => {
    beforeEach(() => {
      vi.mocked(parseTranscript).mockResolvedValue([
        { role: 'user', content: 'Help me implement authentication' },
        { role: 'assistant', content: 'Sure, I can help with that.' },
        { role: 'user', content: 'Use JWT tokens' },
        { role: 'assistant', content: 'I will implement JWT authentication.' },
      ]);
      vi.mocked(extractKnowledge).mockReturnValue(mockKnowledge);
      vi.mocked(formatKnowledgeForStorage).mockReturnValue('## Session: Implementing JWT authentication\n\n### Decisions\n- Use JWT tokens');
    });

    it('returns early if no transcript_path', async () => {
      await handleSessionEnd(makeSessionEndInput({ transcript_path: undefined }));

      expect(parseTranscript).not.toHaveBeenCalled();
    });

    it('returns early if extractKnowledge returns null', async () => {
      vi.mocked(extractKnowledge).mockReturnValue(null);

      await handleSessionEnd(makeSessionEndInput());

      expect(mockMemoryClient.store).not.toHaveBeenCalled();
    });

    it('stores episode summary with correct tags and source', async () => {
      await handleSessionEnd(makeSessionEndInput());

      // First store call is the episode summary
      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        expect.stringContaining('JWT'),
        expect.objectContaining({
          tags: ['session', 'auto-summary', 'episode'],
          source: 'session-summary',
          project: 'abc123',
          memory_type: 'episode',
        })
      );
    });

    it('stores individual items with correct types', async () => {
      await handleSessionEnd(makeSessionEndInput());

      // Should store: 1 episode + 1 mistake + 1 learning + 1 decision = 4 calls
      expect(mockMemoryClient.store).toHaveBeenCalledTimes(4);

      // Mistake (highest priority)
      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        'Fixed token validation by checking issuer field',
        expect.objectContaining({
          tags: ['mistake', 'auto-extracted'],
          memory_type: 'mistake',
          source: 'extraction',
        })
      );

      // Learning
      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        'The trick is to set token expiry to 15 minutes',
        expect.objectContaining({
          tags: ['learning', 'auto-extracted'],
          memory_type: 'learning',
          source: 'extraction',
        })
      );

      // Decision
      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        'Use JWT tokens with refresh tokens',
        expect.objectContaining({
          tags: ['decision', 'auto-extracted'],
          memory_type: 'preference',
          source: 'extraction',
        })
      );
    });

    it('caps individual stores at 4', async () => {
      const bigKnowledge: ExtractedKnowledge = {
        topic: 'Big session',
        decisions: ['d1', 'd2', 'd3'],
        learnings: ['l1', 'l2'],
        problemsSolved: ['p1', 'p2'],
        filesModified: [],
        commands: [],
      };
      vi.mocked(extractKnowledge).mockReturnValue(bigKnowledge);
      vi.mocked(formatKnowledgeForStorage).mockReturnValue('## Session: Big session');

      await handleSessionEnd(makeSessionEndInput());

      // 1 episode + 4 individual (capped) = 5 store calls
      expect(mockMemoryClient.store).toHaveBeenCalledTimes(5);
    });

    it('prioritizes mistakes over learnings over decisions', async () => {
      const bigKnowledge: ExtractedKnowledge = {
        topic: 'Priority test',
        decisions: ['d1', 'd2', 'd3'],
        learnings: ['l1'],
        problemsSolved: ['p1', 'p2'],
        filesModified: [],
        commands: [],
      };
      vi.mocked(extractKnowledge).mockReturnValue(bigKnowledge);
      vi.mocked(formatKnowledgeForStorage).mockReturnValue('## Session: Priority test');

      await handleSessionEnd(makeSessionEndInput());

      // 1 episode + 4 individual = 5 calls
      const storeCalls = vi.mocked(mockMemoryClient.store).mock.calls;
      // Skip first call (episode), check individual items
      const individualCalls = storeCalls.slice(1);

      // First two should be mistakes
      expect(individualCalls[0][1]).toEqual(expect.objectContaining({ memory_type: 'mistake' }));
      expect(individualCalls[1][1]).toEqual(expect.objectContaining({ memory_type: 'mistake' }));
      // Third should be learning
      expect(individualCalls[2][1]).toEqual(expect.objectContaining({ memory_type: 'learning' }));
      // Fourth should be decision
      expect(individualCalls[3][1]).toEqual(expect.objectContaining({ memory_type: 'preference' }));
    });

    it('uses correct project ID', async () => {
      await handleSessionEnd(makeSessionEndInput());

      expect(detectProject).toHaveBeenCalledWith('/test/project');
      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ project: 'abc123' })
      );
    });

    it('parses transcript from correct path', async () => {
      const transcriptPath = '/custom/path/to/transcript.jsonl';

      await handleSessionEnd(makeSessionEndInput({ transcript_path: transcriptPath }));

      expect(parseTranscript).toHaveBeenCalledWith(transcriptPath);
    });

    it('retries episode store on failure', async () => {
      vi.mocked(mockMemoryClient.store)
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ id: 'mem_retry', chunks: 1 });

      await handleSessionEnd(makeSessionEndInput());

      // Episode retries once (2 calls) + 3 individual items = 5 total
      expect(mockMemoryClient.store).toHaveBeenCalledTimes(5);
    });

    it('does not crash if all stores fail', async () => {
      vi.mocked(mockMemoryClient.store)
        .mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(handleSessionEnd(makeSessionEndInput())).resolves.not.toThrow();
    });
  });
});
