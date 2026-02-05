import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryClient } from '../lib/memory-client.js';

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

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ results: mockResults }) }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        authToken: 'test-token'
      });

      const results = await client.search('test query', { maxResults: 5 });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];

      expect(url).toBe('http://localhost:3577/mcp');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers['Authorization']).toBe('Bearer test-token');

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
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: 'mem_123',
                chunks: 3
              })
            }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        authToken: 'test-token'
      });

      const result = await client.store('Memory content', {
        tags: ['test', 'example'],
        source: 'test'
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];

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
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ results: [] }) }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577',
        authToken: 'my-secret-token'
      });

      await client.search('test');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers['Authorization']).toBe('Bearer my-secret-token');
    });

    it('uses provided config over env vars', async () => {
      // Set env vars that should be overridden
      process.env.CLAUDE_MEMORY_URL = 'http://env-server:9999';
      process.env.CLAUDE_MEMORY_TOKEN = 'env-token';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ results: [] }) }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://config-server:8888',
        authToken: 'config-token'
      });

      await client.search('test');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://config-server:8888/mcp');
      expect(options.headers['Authorization']).toBe('Bearer config-token');

      // Cleanup
      delete process.env.CLAUDE_MEMORY_URL;
      delete process.env.CLAUDE_MEMORY_TOKEN;
    });

    it('handles response with no results field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({}) }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      const results = await client.search('test');

      expect(results).toEqual([]);
    });

    it('handles malformed JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: 'not valid json' }]
          }
        })
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
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ results: [] }) }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      await client.search('test query', { scope: 'project', project: 'proj_123' });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.params.arguments.scope).toBe('project');
      expect(body.params.arguments.project).toBe('proj_123');
    });

    it('includes project in store request when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ id: 'mem_123', chunks: 1 }) }]
          }
        })
      });

      const client = createMemoryClient({
        serverUrl: 'http://localhost:3577'
      });

      await client.store('content', {
        project: 'proj_456',
        tags: []
      });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);

      expect(body.params.arguments.project).toBe('proj_456');
    });
  });
});
