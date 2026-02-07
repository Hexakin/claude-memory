import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { Embedder } from './embedding/embedder.js';
import type { EmbeddingCache } from './embedding/cache.js';
import {
  memoryStoreSchema,
  memorySearchSchema,
  memoryGetSchema,
  memoryListSchema,
  memoryUpdateSchema,
  memoryDeleteSchema,
  memoryCleanupSchema,
  taskAddSchema,
  taskListSchema,
  taskResultsSchema,
  taskCancelSchema,
  memoryFeedbackSchema,
  memoryBulkDeleteSchema,
  memoryExportSchema,
  memoryImportSchema,
} from '@claude-memory/shared';
import type {
  MemoryStoreInput,
  MemorySearchInput,
  MemoryGetInput,
  MemoryListInput,
  MemoryUpdateInput,
  MemoryDeleteInput,
  MemoryCleanupInput,
  TaskAddInput,
  TaskListInput,
  TaskResultsInput,
  TaskCancelInput,
  MemoryFeedbackInput,
  MemoryBulkDeleteInput,
  MemoryExportInput,
  MemoryImportInput,
} from '@claude-memory/shared';
import {
  handleMemoryStore,
  handleMemorySearch,
  handleMemoryGet,
  handleMemoryList,
  handleMemoryUpdate,
  handleMemoryDelete,
  handleMemoryCleanup,
  handleTaskAdd,
  handleTaskList,
  handleTaskResults,
  handleTaskCancel,
  handleMemoryFeedback,
  handleMemoryBulkDelete,
  handleMemoryExport,
  handleMemoryImport,
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

  // memory_update
  server.tool(
    'memory_update',
    'Update a memory\'s text, tags, type, importance, or rule status. Re-chunks and re-embeds if text changes.',
    memoryUpdateSchema.shape,
    async ({ id, text, tags, memory_type, importance, is_rule }: MemoryUpdateInput) => {
      try {
        const result = await handleMemoryUpdate(ctx, { id, text, tags, memory_type, importance, is_rule });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_update' }, 'Tool error');
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

  // memory_cleanup
  server.tool(
    'memory_cleanup',
    'Clean up old memories by deleting those not accessed since a given date. Defaults to dry-run mode for safety.',
    memoryCleanupSchema.shape,
    async ({ olderThan, maxCount, dryRun, project }: MemoryCleanupInput) => {
      try {
        const result = await handleMemoryCleanup(ctx, { olderThan, maxCount, dryRun, project });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_cleanup' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // task_add
  server.tool(
    'task_add',
    'Add a task to the overnight automation queue. Supports scheduling, priority, and project scoping.',
    taskAddSchema.shape,
    async ({ description, type, project, repoUrl, priority, scheduledFor, context, timeoutMs }: TaskAddInput) => {
      try {
        const result = await handleTaskAdd(ctx, { description, type, project, repoUrl, priority, scheduledFor, context, timeoutMs });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'task_add' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // task_list
  server.tool(
    'task_list',
    'List tasks in the overnight queue with optional filtering by status, project, and date.',
    taskListSchema.shape,
    async ({ status, project, since, limit }: TaskListInput) => {
      try {
        const result = await handleTaskList(ctx, { status, project, since, limit });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'task_list' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // task_results
  server.tool(
    'task_results',
    'Get results of completed overnight tasks with summary, success status, and cost tracking.',
    taskResultsSchema.shape,
    async ({ taskId, since, limit }: TaskResultsInput) => {
      try {
        const result = await handleTaskResults(ctx, { taskId, since, limit });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'task_results' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // task_cancel
  server.tool(
    'task_cancel',
    'Cancel a pending task in the overnight queue.',
    taskCancelSchema.shape,
    async ({ id }: TaskCancelInput) => {
      try {
        const result = await handleTaskCancel(ctx, { id });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'task_cancel' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_feedback
  server.tool(
    'memory_feedback',
    'Provide feedback on a memory (useful/outdated/wrong/duplicate)',
    memoryFeedbackSchema.shape,
    async (params) => {
      try {
        const input = memoryFeedbackSchema.parse(params) as MemoryFeedbackInput;
        const result = await handleMemoryFeedback(ctx, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_feedback' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_bulk_delete
  server.tool(
    'memory_bulk_delete',
    'Bulk delete memories by tag, project, or age (requires confirm: true)',
    memoryBulkDeleteSchema.shape,
    async (params) => {
      try {
        const input = memoryBulkDeleteSchema.parse(params) as MemoryBulkDeleteInput;
        const result = await handleMemoryBulkDelete(ctx, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_bulk_delete' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_export
  server.tool(
    'memory_export',
    'Export memories as JSON or markdown',
    memoryExportSchema.shape,
    async (params) => {
      try {
        const input = memoryExportSchema.parse(params) as MemoryExportInput;
        const result = await handleMemoryExport(ctx, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_export' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // memory_import
  server.tool(
    'memory_import',
    'Import memories from JSON',
    memoryImportSchema.shape,
    async (params) => {
      try {
        const input = memoryImportSchema.parse(params) as MemoryImportInput;
        const result = await handleMemoryImport(ctx, input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, tool: 'memory_import' }, 'Tool error');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  log.debug('MCP server created with 15 tools registered');
  return server;
}
