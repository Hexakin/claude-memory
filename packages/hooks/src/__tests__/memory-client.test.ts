import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryClient } from '../lib/memory-client.js';

/**
 * Helper: set up mock fetch for the 3-step MCP handshake.
 * Returns different responses for initialize, initialized, and tools/call.
 */
function setupHandshakeMock(
  mockFetch: ReturnType<typeof vi.fn>,
  toolResponse: Record<string, unknown>,
): void {
  mockFetch.mockImplementation((_url: string, options: { body: string }) => {
    const body = JSON.parse(options.body);

    if (body.method === 'initialize') {
      return Promise.resolve({
        ok: true,
        headers: new Map([['mcp-session-id', 'test-session-123']]),
        text: async () => 'event: message\ndata: ' + JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '0.1.0' } },
        }),
      });
    }

    if (body.method === 'notifications/initialized') {
      return Promise.resolve({ ok: true, status: 202, text: async () => '' });
    }

    // tools/call
    return Promise.resolve({
      ok: true,
      text: async () => 'event: message\ndata: ' + JSON.stringify(toolResponse),
    });
  });
}

describe('memory-client', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createMemoryClient', () => {
    it('search() sends correct MCP JSON-RPC request format', async () => {
      const mockResults = [
        { id: '1', content: 'Memory 1', score: 0.9, tags: ['test'], source: null, createdAt: '2024-01-01' },
        { id: '2', content: 'Memory 2', score: 0.8, tags: ['example'], source: null, createdAt: '2024-01-01' }
      ];

      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ results: mockResults }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        authToken: 'test-token'
      });

      const results = await client.search('test query', { maxResults: 5 });

      // 3 calls: initialize, initialized, tools/call
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // Verify the tools/call request (3rd call)
      const [url, options] = mockFetch.mock.calls[2];
      expect(url).toBe('http://localhost:3577/mcp');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['Authorization']).toBe('Bearer test-token');
      expect(options.headers['mcp-session-id']).toBe('test-session-123');

      const body = JSON.parse(options.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('tools/call');
      expect(body.params.name).toBe('memory_search');
      expect(body.params.arguments.query).toBe('test query');
      expect(body.params.arguments.max_results).toBe(5);

      expect(results).toEqual(mockResults);
    });

    it('search() returns empty array on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      const results = await client.search('test query');

      expect(results).toEqual([]);
    });

    it('search() returns empty array on timeout', async () => {
      mockFetch.mockImplementation(() =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 100)
        )
      );

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        timeout: 50
      });

      const results = await client.search('test query');

      expect(results).toEqual([]);
    });

    it('store() sends correct MCP JSON-RPC request format', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ id: 'mem_123', chunks: 3 }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        authToken: 'test-token'
      });

      const result = await client.store('Memory content', {
        tags: ['test', 'example'],
        source: 'test'
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);

      const [url, options] = mockFetch.mock.calls[2];
      expect(url).toBe('http://localhost:3577/mcp');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('tools/call');
      expect(body.params.name).toBe('memory_store');
      expect(body.params.arguments.text).toBe('Memory content');
      expect(body.params.arguments.tags).toEqual(['test', 'example']);
      expect(body.params.arguments.source).toBe('test');

      expect(result).toEqual({ id: 'mem_123', chunks: 3 });
    });

    it('store() returns fallback on error', async () => {
      mockFetch.mockRejectedValue(new Error('Storage error'));

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      const result = await client.store('Memory content');

      expect(result).toEqual({ id: '', chunks: 0 });
    });

    it('adds Authorization header with bearer token', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        authToken: 'my-secret-token'
      });

      await client.search('test');

      // All 3 calls should have the auth header
      for (const [, options] of mockFetch.mock.calls) {
        expect(options.headers['Authorization']).toBe('Bearer my-secret-token');
      }
    });

    it('uses provided config over env vars', async () => {
      process.env.CLAUDE_MEMORY_URL = 'http://env-server:9999';
      process.env.CLAUDE_MEMORY_TOKEN = 'env-token';

      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://config-server:8888',
        authToken: 'config-token'
      });

      await client.search('test');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://config-server:8888/mcp');
      expect(options.headers['Authorization']).toBe('Bearer config-token');

      delete process.env.CLAUDE_MEMORY_URL;
      delete process.env.CLAUDE_MEMORY_TOKEN;
    });

    it('handles response with no results field', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({}) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      const results = await client.search('test');

      expect(results).toEqual([]);
    });

    it('handles malformed JSON response', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: 'not valid json' }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      const results = await client.search('test');

      expect(results).toEqual([]);
    });

    it('handles HTTP error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      const results = await client.search('test');

      expect(results).toEqual([]);
    });

    it('includes scope and project in search request', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      await client.search('test query', { scope: 'project', project: 'proj_123' });

      const [, options] = mockFetch.mock.calls[2];
      const body = JSON.parse(options.body);

      expect(body.params.arguments.scope).toBe('project');
      expect(body.params.arguments.project).toBe('proj_123');
    });

    it('includes project in store request when provided', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ id: 'mem_123', chunks: 1 }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      await client.store('content', {
        project: 'proj_456',
        tags: []
      });

      const [, options] = mockFetch.mock.calls[2];
      const body = JSON.parse(options.body);

      expect(body.params.arguments.project).toBe('proj_456');
    });

    it('caches session ID across multiple calls', async () => {
      setupHandshakeMock(mockFetch, {
        jsonrpc: '2.0', id: 2,
        result: { content: [{ type: 'text', text: JSON.stringify({ results: [] }) }] },
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      await client.search('first');
      await client.search('second');

      // First search: 3 calls (initialize + initialized + tools/call)
      // Second search: 1 call (tools/call with cached session)
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });
});
