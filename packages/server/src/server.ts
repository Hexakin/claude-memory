import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { Embedder } from './embedding/embedder.js';
import type { EmbeddingCache } from './embedding/cache.js';
import {
  memoryStoreSchema,
  memorySearchSchema,
  memoryGetSchema,
  memoryListSchema,
  memoryDeleteSchema,
} from '@claude-memory/shared';
import type {
  MemoryStoreInput,
  MemorySearchInput,
  MemoryGetInput,
  MemoryListInput,
  MemoryDeleteInput,
} from '@claude-memory/shared';
import {
  handleMemoryStore,
  handleMemorySearch,
  handleMemoryGet,
  handleMemoryList,
  handleMemoryDelete,
} from './tools/index.js';
import pino from 'pino';

const log = pino({ name: 'mcp-server' });

export interface ServerContext {
  globalDb: Database.Database;
  embedder: Embedder;
  embeddingCache: EmbeddingCache;
  vecAvailable: boolean;
  dataDir: string;
}

/**
 * Create an MCP server with all memory tool handlers registered.
 */
export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer({
    name: 'claude-memory',
    version: '0.1.0',
  });

  // memory_store
  server.tool(
    'memory_store',
    'Store a memory with automatic chunking and embedding. Supports tags and project scoping.',
    memoryStoreSchema.shape,
    async ({ text, tags, project, source, metadata }: MemoryStoreInput) => {
      try {
        const result = await handleMemoryStore(ctx, { text, tags, project, source, metadata });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_store' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_search
  server.tool(
    'memory_search',
    'Search memories using hybrid vector + keyword search. Returns ranked results.',
    memorySearchSchema.shape,
    async ({ query, scope, project, tags, maxResults, minScore }: MemorySearchInput) => {
      try {
        const result = await handleMemorySearch(ctx, { query, scope, project, tags, maxResults, minScore });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_search' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_get
  server.tool(
    'memory_get',
    'Get a specific memory by ID with full metadata.',
    memoryGetSchema.shape,
    async ({ id }: MemoryGetInput) => {
      try {
        const result = await handleMemoryGet(ctx, { id });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_get' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_list
  server.tool(
    'memory_list',
    'List memories with optional filtering by project, tag, source, and date.',
    memoryListSchema.shape,
    async ({ project, tag, source, since, limit, offset }: MemoryListInput) => {
      try {
        const result = await handleMemoryList(ctx, { project, tag, source, since, limit, offset });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_list' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_delete
  server.tool(
    'memory_delete',
    'Delete a specific memory and all its chunks.',
    memoryDeleteSchema.shape,
    async ({ id }: MemoryDeleteInput) => {
      try {
        const result = await handleMemoryDelete(ctx, { id });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_delete' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  log.info('MCP server created with 5 tools registered');
  return server;
}
