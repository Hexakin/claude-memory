import { HOOK_TIMEOUT_MS } from '@claude-memory/shared';
import type { MemoryClientConfig } from '../types.js';

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  tags: string[];
  source: string | null;
  createdAt: string;
}

export interface MemoryClient {
  search(query: string, options?: { scope?: string; project?: string; maxResults?: number }): Promise<SearchResult[]>;
  store(text: string, options?: { source?: string; project?: string; tags?: string[] }): Promise<{ id: string; chunks: number }>;
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

    if (!initRes.ok) return null;

    // Extract session ID from response header
    sessionId = initRes.headers.get('mcp-session-id');
    if (!sessionId) return null;

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

    return sessionId;
  }

  async function callMcpTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const sid = await ensureSession(controller.signal);
      if (!sid) return null;

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
        sessionId = null;
        return null;
      }

      // Response may be SSE format or plain JSON
      const raw = await response.text();
      const data = parseResponse(raw);
      if (!data || data['error']) return null;

      const result = data['result'] as Record<string, unknown> | undefined;
      const content = result?.['content'] as Array<Record<string, unknown>> | undefined;
      const text = content?.[0]?.['text'] as string | undefined;

      return text ? JSON.parse(text) : null;
    } catch {
      clearTimeout(timeoutId);
      sessionId = null;
      return null;
    }
  }

  return {
    async search(query: string, options?: { scope?: string; project?: string; maxResults?: number }): Promise<SearchResult[]> {
      const result = await callMcpTool<{ results: SearchResult[] }>('memory_search', {
        query,
        scope: options?.scope,
        project: options?.project,
        max_results: options?.maxResults,
      });

      return result?.results ?? [];
    },

    async store(text: string, options?: { source?: string; project?: string; tags?: string[] }): Promise<{ id: string; chunks: number }> {
      const result = await callMcpTool<{ id: string; chunks: number }>('memory_store', {
        text,
        source: options?.source,
        project: options?.project,
        tags: options?.tags,
      });

      return result ?? { id: '', chunks: 0 };
    },
  };
}
