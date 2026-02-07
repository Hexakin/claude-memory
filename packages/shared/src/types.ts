/** Core memory entry */
export interface Memory {
  id: string;
  content: string;
  source: MemorySource | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  metadata: Record<string, unknown>;
  tags: string[];
  memoryType: MemoryType;
  importanceScore: number;
  isRule: boolean;
  storageTier: StorageTier;
}

export type MemorySource = 'user' | 'session-summary' | 'automation' | 'hook' | 'extraction' | 'consolidation';

export type MemoryType = 'general' | 'preference' | 'learning' | 'objective' | 'mistake' | 'rule' | 'episode';

export type StorageTier = 'active' | 'working' | 'archive';

/** A chunk of text derived from a memory, with embedding */
export interface Chunk {
  id: string;
  memoryId: string;
  content: string;
  chunkIndex: number;
  tokenCount: number;
  createdAt: string;
}

/** Search result returned by hybrid search */
export interface SearchResult {
  id: string;
  memoryId: string;
  content: string;
  score: number;
  vectorScore: number;
  ftsScore: number;
  tags: string[];
  source: MemorySource | null;
  createdAt: string;
}

/** Memory search result (grouped by memory) */
export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  tags: string[];
  source: MemorySource | null;
  createdAt: string;
}

/** Task in the overnight queue */
export interface Task {
  id: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  projectId: string | null;
  repoUrl: string | null;
  scheduledFor: string | null;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type TaskType = 'code-review' | 'test-runner' | 'doc-updater' | 'refactor' | 'custom';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Result of a completed task */
export interface TaskResult {
  id: string;
  taskId: string;
  output: string;
  summary: string | null;
  success: boolean;
  error: string | null;
  durationMs: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  memoryId: string | null;
  createdAt: string;
}

/** MCP tool input/output types */
export interface MemoryStoreInput {
  text: string;
  tags?: string[];
  project?: string;
  source?: MemorySource;
  metadata?: Record<string, unknown>;
  memory_type?: MemoryType;
  importance?: number;
  is_rule?: boolean;
}

export interface MemoryStoreOutput {
  id: string;
  chunks: number;
  deduplicated?: boolean;
  merged?: boolean;
  similar_memories?: Array<{ id: string; content: string; score: number }>;
}

export interface MemorySearchInput {
  query: string;
  scope?: 'global' | 'project' | 'all';
  project?: string;
  tags?: string[];
  maxResults?: number;
  minScore?: number;
  include_archived?: boolean;
}

export interface MemorySearchOutput {
  results: MemorySearchResult[];
}

export interface MemoryGetInput {
  id: string;
}

export interface MemoryGetOutput {
  id: string;
  content: string;
  tags: string[];
  source: MemorySource | null;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  metadata: Record<string, unknown>;
  memoryType: MemoryType;
  importanceScore: number;
  isRule: boolean;
  storageTier: string;
}

export interface MemoryListInput {
  project?: string;
  tag?: string;
  source?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryListOutput {
  memories: Array<{
    id: string;
    content: string;
    tags: string[];
    source: MemorySource | null;
    createdAt: string;
    memoryType: MemoryType;
    importanceScore: number;
    isRule: boolean;
    storageTier: StorageTier;
  }>;
  total: number;
}

export interface MemoryUpdateInput {
  id: string;
  text?: string;
  tags?: string[];
  memory_type?: MemoryType;
  importance?: number;
  is_rule?: boolean;
}

export interface MemoryUpdateOutput {
  updated: boolean;
  chunks?: number;
}

export interface MemoryDeleteInput {
  id: string;
}

export interface MemoryDeleteOutput {
  deleted: boolean;
}

export interface MemoryCleanupInput {
  olderThan?: string;
  maxCount?: number;
  dryRun?: boolean;
  project?: string;
}

export interface MemoryCleanupOutput {
  wouldDelete: number;
  deleted: number;
  dryRun: boolean;
}

export interface TaskAddInput {
  description: string;
  type?: TaskType;
  project?: string;
  repoUrl?: string;
  priority?: number;
  scheduledFor?: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface TaskAddOutput {
  id: string;
  scheduledFor: string;
}

export interface TaskListInput {
  status?: TaskStatus | 'all';
  project?: string;
  since?: string;
  limit?: number;
}

export interface TaskListOutput {
  tasks: Array<{
    id: string;
    description: string;
    status: TaskStatus;
    type: TaskType;
    createdAt: string;
    scheduledFor: string | null;
  }>;
}

export interface TaskResultsInput {
  taskId?: string;
  since?: string;
  limit?: number;
}

export interface TaskResultsOutput {
  results: Array<{
    taskId: string;
    description: string;
    summary: string | null;
    success: boolean;
    error: string | null;
    completedAt: string;
    durationMs: number | null;
    tokensUsed: number | null;
    costUsd: number | null;
  }>;
}

export interface TaskCancelInput {
  id: string;
}

export interface TaskCancelOutput {
  cancelled: boolean;
}

export type FeedbackRating = 'useful' | 'outdated' | 'wrong' | 'duplicate';

export interface MemoryFeedbackInput {
  id: string;
  rating: FeedbackRating;
}

export interface MemoryFeedbackOutput {
  updated: boolean;
  newImportance?: number;
  action: string;
}

export interface MemoryBulkDeleteInput {
  tag?: string;
  project?: string;
  older_than?: string;
  confirm: boolean;
}

export interface MemoryBulkDeleteOutput {
  deleted: number;
}

export interface MemoryExportInput {
  project?: string;
  format?: 'json' | 'markdown';
}

export interface MemoryExportOutput {
  data: string;
  count: number;
  format: string;
}

export interface MemoryImportInput {
  data: string;
  format?: 'json';
  project?: string;
}

export interface MemoryImportOutput {
  imported: number;
  errors: number;
}
