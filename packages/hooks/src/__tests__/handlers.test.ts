import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryClient } from '../lib/memory-client.js';
import type { TranscriptMessage } from '../types.js';

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
  summarizeTranscript: vi.fn()
}));

// Import after mocks are set up
import { detectProject } from '../lib/project-detect.js';
import { createMemoryClient } from '../lib/memory-client.js';
import { parseTranscript, summarizeTranscript } from '../lib/transcript-parser.js';
import { handleSessionStart } from '../handlers/session-start.js';
import { handleSessionEnd } from '../handlers/session-end.js';

describe('handlers', () => {
  let mockMemoryClient: MemoryClient;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock memory client
    mockMemoryClient = {
      search: vi.fn().mockResolvedValue([]),
      store: vi.fn().mockResolvedValue({ id: 'mem_test', chunks: 1 })
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

      vi.mocked(mockMemoryClient.search).mockResolvedValue(projectMemories);

      const result = await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

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

      vi.mocked(mockMemoryClient.search)
        .mockResolvedValueOnce([]) // Project memories
        .mockResolvedValueOnce(globalMemories); // Global memories

      const result = await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

      expect(result.additionalContext).toBeDefined();
      expect(result.additionalContext).toContain('User prefers functional programming');
      expect(result.additionalContext).toContain('Always include error handling');
    });

    it('returns empty object when no memories found', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      const result = await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

      expect(result).toEqual({});
    });

    it('includes project name in context header', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([
        { id: '5', content: 'Memory 1', score: 0.9, tags: [], source: null, createdAt: '2024-01-01' }
      ]);

      const result = await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

      expect(result.additionalContext).toContain('test-project');
      expect(result.additionalContext).toMatch(/Project:\s*test-project/i);
    });

    it('handles missing project name gracefully', async () => {
      vi.mocked(detectProject).mockResolvedValue({
        projectId: 'abc123',
        projectName: null
      });

      vi.mocked(mockMemoryClient.search).mockResolvedValue([
        { id: '6', content: 'Memory 1', score: 0.9, tags: [], source: null, createdAt: '2024-01-01' }
      ]);

      const result = await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

      expect(result.additionalContext).toBeDefined();
      expect(result.additionalContext).not.toContain('null');
    });

    it('calls search with correct parameters for project memories', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

      expect(mockMemoryClient.search).toHaveBeenCalledWith(
        'project context, conventions, architecture decisions, and preferences',
        expect.objectContaining({
          scope: 'project',
          project: 'abc123',
          maxResults: 5
        })
      );
    });

    it('calls search with correct parameters for global memories', async () => {
      vi.mocked(mockMemoryClient.search).mockResolvedValue([]);

      await handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      });

      // Second call should be for global memories (no projectId)
      expect(mockMemoryClient.search).toHaveBeenCalledWith(
        'general coding preferences, patterns, and conventions',
        expect.objectContaining({
          scope: 'global',
          maxResults: 3
        })
      );
    });

    it('handles errors gracefully', async () => {
      vi.mocked(detectProject).mockRejectedValue(new Error('Detection failed'));

      // Should throw the error
      await expect(handleSessionStart({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
      })).rejects.toThrow('Detection failed');
    });
  });

  describe('handleSessionEnd', () => {
    const mockMessages: TranscriptMessage[] = [
      { role: 'user', content: 'Can you help me implement authentication?' },
      { role: 'assistant', content: 'Sure, I can help with that.' },
      { role: 'user', content: 'Use JWT tokens' },
      { role: 'assistant', content: 'I will implement JWT authentication.' }
    ];

    beforeEach(() => {
      vi.mocked(parseTranscript).mockResolvedValue(mockMessages);
      vi.mocked(summarizeTranscript).mockReturnValue('Implemented JWT authentication system');
    });

    it('returns early if no transcript_path', async () => {
      const result = await handleSessionEnd({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now()
        // No transcript_path
      });

      expect(result).toBeUndefined();
      expect(parseTranscript).not.toHaveBeenCalled();
    });

    it('returns early if session too short', async () => {
      vi.mocked(summarizeTranscript).mockReturnValue('');

      const result = await handleSessionEnd({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now(),
        transcript_path: '/path/to/transcript.jsonl'
      });

      expect(result).toBeUndefined();
      expect(mockMemoryClient.store).not.toHaveBeenCalled();
    });

    it('stores summary with correct tags and source', async () => {
      await handleSessionEnd({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now(),
        transcript_path: '/path/to/transcript.jsonl'
      });

      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        'Implemented JWT authentication system',
        {
          tags: ['session', 'auto-summary'],
          source: 'session-summary',
          project: 'abc123'
        }
      );
    });

    it('uses correct project ID', async () => {
      await handleSessionEnd({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now(),
        transcript_path: '/path/to/transcript.jsonl'
      });

      expect(detectProject).toHaveBeenCalledWith('/test/project');
      expect(mockMemoryClient.store).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          project: 'abc123'
        })
      );
    });

    it('parses transcript from correct path', async () => {
      const transcriptPath = '/custom/path/to/transcript.jsonl';

      await handleSessionEnd({
        cwd: '/test/project',
        conversationId: 'conv_123',
        timestamp: Date.now(),
        transcript_path: transcriptPath
      });

      expect(parseTranscript).toHaveBeenCalledWith(transcriptPath);
    });
  });
});
