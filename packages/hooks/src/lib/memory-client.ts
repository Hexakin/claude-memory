import { HOOK_TIMEOUT_MS } from '@claude-memory/shared';
import type { MemoryClientConfig } from '../types.js';
import { createHookLogger } from './logger.js';

const logger = createHookLogger('memory-client');

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  tags: string[];
  source: string | null;
  createdAt: string;
}

export interface ListResult {
  id: string;
  content: string;
  tags: string[];
  source: string | null;
  createdAt: string;
  memoryType: string;
  importanceScore: number;
  isRule: boolean;
}

export interface MemoryClient {
  search(query: string, options?: { scope?: string; project?: string; maxResults?: number }): Promise<SearchResult[]>;
  store(text: string, options?: { source?: string; project?: string; tags?: string[]; memory_type?: string; importance?: number; is_rule?: boolean }): Promise<{ id: string; chunks: number }>;
  list(options?: { tag?: string; project?: string; source?: string; limit?: number }): Promise<ListResult[]>;
  health(): Promise<boolean>;
}

const ACCEPT_HEADER = 'application/json, text/event-stream';

/**
 * Parse a JSON-RPC response that may come as SSE (text/event-stream) or plain JSON.
 * The MCP Streamable HTTP transport returns SSE format: "event: message\ndata: {...}\n\n"
 */
function parseResponse(text: string): Record<string, unknown> | null {
  // Try plain JSON first
  try {
    return JSON.parse(text);
  } catch {
    // Not plain JSON — try SSE format
  }

  // Parse SSE: extract the last "data:" line containing a JSON-RPC message
  for (const line of text.split('\n').reverse()) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // Malformed data line
      }
    }
  }

  return null;
}

/**
 * Create a memory client with the given configuration.
 * Reads from environment variables: CLAUDE_MEMORY_URL and CLAUDE_MEMORY_TOKEN.
 *
 * The client performs the full MCP handshake (initialize → initialized → tools/call)
 * because the Streamable HTTP transport requires it. Responses come as SSE.
 */
export function createMemoryClient(config?: Partial<MemoryClientConfig>): MemoryClient {
  const serverUrl = config?.serverUrl ?? process.env.CLAUDE_MEMORY_URL ?? 'http://localhost:3577';
  const authToken = config?.authToken ?? process.env.CLAUDE_MEMORY_TOKEN ?? '';
  const timeoutMs = config?.timeoutMs ?? HOOK_TIMEOUT_MS;

  // Cached session ID from initialize handshake
  let sessionId: string | null = null;

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': ACCEPT_HEADER,
    ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
  };

  async function postMcp(
    body: Record<string, unknown>,
    signal: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { ...baseHeaders, ...extraHeaders },
      body: JSON.stringify(body),
      signal,
    });
  }

  async function ensureSession(signal: AbortSignal): Promise<string | null> {
    if (sessionId) return sessionId;

    logger.debug('Starting MCP handshake', { serverUrl });

    // Step 1: initialize
    const initRes = await postMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'claude-memory-hooks', version: '0.1.0' },
      },
    }, signal);

    if (!initRes.ok) {
      logger.error('MCP initialize failed', { status: initRes.status, statusText: initRes.statusText });
      return null;
    }

    // Extract session ID from response header
    sessionId = initRes.headers.get('mcp-session-id');
    if (!sessionId) {
      logger.error('No session ID in initialize response');
      return null;
    }

    logger.debug('MCP session initialized', { sessionId });

    // Consume the response body (SSE format)
    await initRes.text();

    // Step 2: send initialized notification (no id = notification)
    const notifRes = await postMcp(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      signal,
      { 'mcp-session-id': sessionId },
    );
    // Consume notification response body (202, usually empty)
    await notifRes.text();

    logger.debug('MCP handshake complete');

    return sessionId;
  }

  async function callMcpTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.debug('Calling MCP tool', { toolName, args });

      const sid = await ensureSession(controller.signal);
      if (!sid) {
        logger.error('Failed to establish session for tool call', { toolName });
        return null;
      }

      const response = await postMcp(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        },
        controller.signal,
        { 'mcp-session-id': sid },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.error('MCP tool call failed', { toolName, status: response.status, statusText: response.statusText });
        sessionId = null;
        return null;
      }

      // Response may be SSE format or plain JSON
      const raw = await response.text();
      const data = parseResponse(raw);
      if (!data) {
        logger.error('Failed to parse MCP response', { toolName, rawLength: raw.length });
        return null;
      }

      if (data['error']) {
        logger.error('MCP tool returned error', { toolName, error: data['error'] });
        return null;
      }

      const result = data['result'] as Record<string, unknown> | undefined;
      const content = result?.['content'] as Array<Record<string, unknown>> | undefined;
      const text = content?.[0]?.['text'] as string | undefined;

      const parsed = text ? JSON.parse(text) : null;
      logger.debug('MCP tool call successful', { toolName });
      return parsed;
    } catch (error) {
      clearTimeout(timeoutId);
      sessionId = null;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('MCP tool call exception', { toolName, error: errorMessage });
      return null;
    }
  }

  return {
    async search(query: string, options?: { scope?: string; project?: string; maxResults?: number }): Promise<SearchResult[]> {
      logger.debug('Searching memories', { query: query.slice(0, 50), scope: options?.scope, project: options?.project });

      const result = await callMcpTool<{ results: SearchResult[] }>('memory_search', {
        query,
        scope: options?.scope,
        project: options?.project,
        max_results: options?.maxResults,
      });

      const results = result?.results ?? [];
      logger.info('Memory search complete', { resultCount: results.length });
      return results;
    },

    async store(text: string, options?: { source?: string; project?: string; tags?: string[]; memory_type?: string; importance?: number; is_rule?: boolean }): Promise<{ id: string; chunks: number }> {
      logger.debug('Storing memory', { textLength: text.length, source: options?.source, project: options?.project, tags: options?.tags });

      const result = await callMcpTool<{ id: string; chunks: number }>('memory_store', {
        text,
        source: options?.source,
        project: options?.project,
        tags: options?.tags,
        memory_type: options?.memory_type,
        importance: options?.importance,
        is_rule: options?.is_rule,
      });

      const stored = result ?? { id: '', chunks: 0 };
      logger.info('Memory store complete', { id: stored.id, chunks: stored.chunks });
      return stored;
    },

    async list(options?: { tag?: string; project?: string; source?: string; limit?: number }): Promise<ListResult[]> {
      logger.debug('Listing memories', { tag: options?.tag, project: options?.project, source: options?.source });

      const result = await callMcpTool<{ memories: ListResult[]; total: number }>('memory_list', {
        tag: options?.tag,
        project: options?.project,
        source: options?.source,
        limit: options?.limit ?? 50,
      });

      const memories = result?.memories ?? [];
      logger.info('Memory list complete', { count: memories.length });
      return memories;
    },

    async health(): Promise<boolean> {
      try {
        const controller = new AbortController();
        const healthTimeout = setTimeout(() => controller.abort(), 1000);
        const res = await fetch(`${serverUrl}/health`, {
          headers: baseHeaders,
          signal: controller.signal,
        });
        clearTimeout(healthTimeout);
        logger.debug('Health check result', { ok: res.ok, status: res.status });
        return res.ok;
      } catch (err) {
        logger.warn('Health check failed', { error: String(err) });
        return false;
      }
    },
  };
}
