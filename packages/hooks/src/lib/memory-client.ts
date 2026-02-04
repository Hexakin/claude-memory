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

/**
 * Create a memory client with the given configuration.
 * Reads from environment variables: CLAUDE_MEMORY_URL and CLAUDE_MEMORY_TOKEN.
 */
export function createMemoryClient(config?: Partial<MemoryClientConfig>): MemoryClient {
  const serverUrl = config?.serverUrl ?? process.env.CLAUDE_MEMORY_URL ?? 'http://localhost:3000';
  const authToken = config?.authToken ?? process.env.CLAUDE_MEMORY_TOKEN ?? '';
  const timeoutMs = config?.timeoutMs ?? HOOK_TIMEOUT_MS;

  async function callMcpTool<T = unknown>(toolName: string, args: Record<string, unknown>): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${serverUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      if (data.error) {
        return null;
      }

      return data.result?.content?.[0]?.text ? JSON.parse(data.result.content[0].text) : null;
    } catch {
      // Network error, timeout, or auth failure - return null silently
      clearTimeout(timeoutId);
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
