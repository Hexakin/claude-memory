# @claude-memory/shared

Shared types, Zod validation schemas, constants, and project-ID utilities used by both the server and hooks packages.

This package contains zero runtime dependencies beyond `zod`. It is the single source of truth for all interfaces and validation logic in the claude-memory system.

## Exports

### types.ts -- Core Interfaces

**Memory types:**

| Type | Description |
|------|-------------|
| `Memory` | Core memory entry with content, tags, project scoping, access tracking, and metadata |
| `MemorySource` | Union: `'user' \| 'session-summary' \| 'automation' \| 'hook'` |
| `Chunk` | A text fragment derived from a memory, with embedding metadata |
| `SearchResult` | Raw search result with separate vector and FTS scores |
| `MemorySearchResult` | Grouped search result (one per memory, highest chunk score) |

**Task types:**

| Type | Description |
|------|-------------|
| `Task` | Overnight task with description, type, status, priority, scheduling, and retry config |
| `TaskType` | Union: `'code-review' \| 'test-runner' \| 'doc-updater' \| 'refactor' \| 'custom'` |
| `TaskStatus` | Union: `'pending' \| 'running' \| 'completed' \| 'failed' \| 'cancelled'` |
| `TaskResult` | Completed task result with output, summary, cost tracking, and linked memory ID |

**MCP tool I/O types (one pair per tool):**

| Input | Output | Tool |
|-------|--------|------|
| `MemoryStoreInput` | `MemoryStoreOutput` | `memory_store` |
| `MemorySearchInput` | `MemorySearchOutput` | `memory_search` |
| `MemoryGetInput` | `MemoryGetOutput` | `memory_get` |
| `MemoryListInput` | `MemoryListOutput` | `memory_list` |
| `MemoryDeleteInput` | `MemoryDeleteOutput` | `memory_delete` |
| `MemoryCleanupInput` | `MemoryCleanupOutput` | `memory_cleanup` |
| `TaskAddInput` | `TaskAddOutput` | `task_add` |
| `TaskListInput` | `TaskListOutput` | `task_list` |
| `TaskResultsInput` | `TaskResultsOutput` | `task_results` |
| `TaskCancelInput` | `TaskCancelOutput` | `task_cancel` |

### schemas.ts -- Zod Validation

Every MCP tool input has a corresponding Zod schema with defaults and constraints:

| Schema | Key validations |
|--------|-----------------|
| `memoryStoreSchema` | `text` required (min 1 char), optional `tags`, `project`, `source`, `metadata` |
| `memorySearchSchema` | `query` required, `scope` defaults to `'all'`, `maxResults` 1-50 (default 10), `minScore` 0-1 (default 0.3) |
| `memoryGetSchema` | `id` required |
| `memoryListSchema` | `limit` 1-100 (default 20), `offset` >= 0 (default 0) |
| `memoryDeleteSchema` | `id` required |
| `memoryCleanupSchema` | `dryRun` defaults to `true`, optional `olderThan`, `maxCount`, `project` |
| `taskAddSchema` | `description` required, `type` defaults to `'custom'`, `priority` 1-10 (default 5) |
| `taskListSchema` | `status` defaults to `'all'`, `limit` 1-100 (default 20) |
| `taskResultsSchema` | Optional `taskId`, `since`, `limit` 1-100 (default 10) |
| `taskCancelSchema` | `id` required |

### constants.ts -- Configuration Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_PORT` | `3577` | Default HTTP server port |
| `EMBEDDING_MODEL` | `'nomic-embed-text-v1.5'` | Embedding model identifier |
| `EMBEDDING_DIMENSIONS` | `768` | Vector dimensionality |
| `EMBEDDING_MODEL_FILE` | `'nomic-embed-text-v1.5.Q8_0.gguf'` | GGUF model filename |
| `EMBED_PREFIX_DOCUMENT` | `'search_document: '` | Nomic prefix for documents |
| `EMBED_PREFIX_QUERY` | `'search_query: '` | Nomic prefix for queries |
| `DEFAULT_CHUNK_TOKENS` | `500` | Max tokens per chunk |
| `DEFAULT_CHUNK_OVERLAP` | `100` | Overlap tokens between chunks |
| `APPROX_CHARS_PER_TOKEN` | `4` | Character-to-token approximation |
| `DEFAULT_VECTOR_WEIGHT` | `0.7` | Vector score weight in hybrid search |
| `DEFAULT_FTS_WEIGHT` | `0.3` | FTS score weight in hybrid search |
| `DEFAULT_MAX_RESULTS` | `10` | Default search result limit |
| `DEFAULT_MIN_SCORE` | `0.3` | Minimum score threshold |
| `DEFAULT_TASK_TIMEOUT_MS` | `1800000` (30 min) | Default task execution timeout |
| `DEFAULT_CRON_SCHEDULE` | `'0 2 * * *'` | Default cron schedule (2 AM daily) |
| `DEFAULT_MAX_RETRIES` | `1` | Default max retry count |
| `HOOK_TIMEOUT_MS` | `3000` | Max time for hooks (never block Claude Code) |

### project-id.ts -- Project Identification

| Function | Description |
|----------|-------------|
| `normalizeGitUrl(url)` | Normalizes SSH and HTTPS git URLs to a canonical HTTPS form. `git@github.com:user/repo.git` and `https://github.com/user/repo` produce the same output. |
| `deriveProjectId(gitRemoteUrl)` | Returns the first 16 hex chars of the SHA-256 hash of the normalized URL. Deterministic across machines. |
| `deriveProjectIdFromPath(folderPath)` | Fallback for non-git directories. Normalizes path separators and hashes the lowercase path. |

## Usage Examples

```typescript
import {
  type Memory,
  type MemoryStoreInput,
  type SearchResult,
  memoryStoreSchema,
  memorySearchSchema,
  deriveProjectId,
  normalizeGitUrl,
  DEFAULT_PORT,
  EMBEDDING_DIMENSIONS,
} from '@claude-memory/shared';

// Validate tool input
const parsed = memoryStoreSchema.parse({
  text: 'Always use kebab-case for file names in this project',
  tags: ['convention'],
  project: 'abc123',
  source: 'user',
});

// Derive a stable project ID from a git URL
const projectId = deriveProjectId('git@github.com:user/my-project.git');
// => "a1b2c3d4e5f67890" (16 hex chars, deterministic)

// Normalize git URLs for comparison
normalizeGitUrl('git@github.com:user/repo.git');
// => "https://github.com/user/repo"
```

## Build

```bash
pnpm build   # tsc -> dist/
pnpm test    # vitest
```
