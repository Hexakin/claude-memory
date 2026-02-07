import { z } from 'zod';

const memorySourceSchema = z.enum(['user', 'session-summary', 'automation', 'hook', 'extraction', 'consolidation']);
const memoryTypeSchema = z.enum(['general', 'preference', 'learning', 'objective', 'mistake', 'rule', 'episode']);
const taskTypeSchema = z.enum(['code-review', 'test-runner', 'doc-updater', 'refactor', 'custom']);
const taskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);

export const memoryStoreSchema = z.object({
  text: z.string().min(1, 'Text is required'),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  source: memorySourceSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
  memory_type: memoryTypeSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  is_rule: z.boolean().optional(),
});

export const memorySearchSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  scope: z.enum(['global', 'project', 'all']).default('all'),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
  minScore: z.number().min(0).max(1).default(0.3),
  include_archived: z.boolean().optional(),
});

export const memoryGetSchema = z.object({
  id: z.string().min(1, 'ID is required'),
});

export const memoryListSchema = z.object({
  project: z.string().optional(),
  tag: z.string().optional(),
  source: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const memoryUpdateSchema = z.object({
  id: z.string().min(1, 'ID is required'),
  text: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  memory_type: memoryTypeSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  is_rule: z.boolean().optional(),
});

export const memoryDeleteSchema = z.object({
  id: z.string().min(1, 'ID is required'),
});

export const memoryCleanupSchema = z.object({
  olderThan: z.string().optional(),
  maxCount: z.number().int().min(1).optional(),
  dryRun: z.boolean().default(true),
  project: z.string().optional(),
});

export const taskAddSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  type: taskTypeSchema.default('custom'),
  project: z.string().optional(),
  repoUrl: z.string().url().optional(),
  priority: z.number().int().min(1).max(10).default(5),
  scheduledFor: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).optional(),
});

export const taskListSchema = z.object({
  status: z.union([taskStatusSchema, z.literal('all')]).default('all'),
  project: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const taskResultsSchema = z.object({
  taskId: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

export const taskCancelSchema = z.object({
  id: z.string().min(1, 'ID is required'),
});

export const memoryFeedbackSchema = z.object({
  id: z.string().min(1, 'Memory ID is required'),
  rating: z.enum(['useful', 'outdated', 'wrong', 'duplicate']),
});

export const memoryBulkDeleteSchema = z.object({
  tag: z.string().optional(),
  project: z.string().optional(),
  older_than: z.string().optional(),
  confirm: z.boolean(),
});

export const memoryExportSchema = z.object({
  project: z.string().optional(),
  format: z.enum(['json', 'markdown']).default('json'),
});

export const memoryImportSchema = z.object({
  data: z.string().min(1, 'Import data is required'),
  format: z.enum(['json']).default('json'),
  project: z.string().optional(),
});
