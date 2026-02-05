# @claude-memory/server

MCP server providing persistent memory storage, hybrid vector + keyword search, and overnight task automation for Claude Code.

The server exposes 10 MCP tools over a Streamable HTTP transport, backed by SQLite with sqlite-vec for vector search and FTS5 for full-text search.

## Architecture

```
Express HTTP Server (port 3577)
  |
  +-- POST /mcp          Streamable HTTP MCP transport (stateful sessions)
  +-- GET  /mcp          SSE for server-initiated messages
  +-- DELETE /mcp        Session cleanup
  +-- GET  /health       Health check with diagnostics
  |
  +-- McpServer (10 tools registered)
  |     |
  |     +-- Tool handlers (packages/server/src/tools/)
  |           |
  |           +-- memory-store    -> chunker -> embedder -> DB
  |           +-- memory-search   -> hybrid search (vec + FTS)
  |           +-- memory-get      -> direct lookup
  |           +-- memory-list     -> filtered query
  |           +-- memory-delete   -> cascade delete (memory + chunks + tags)
  |           +-- task-add        -> insert into task queue
  |           +-- task-list       -> filtered task query
  |           +-- task-results    -> completed task results
  |           +-- task-cancel     -> cancel pending task
  |
  +-- CronScheduler (node-cron, default: 2 AM daily)
  |     |
  |     +-- AnthropicApiRunner   (if ANTHROPIC_API_KEY set)
  |     +-- CliRunner            (fallback: `claude --print`)
  |
  +-- SQLite Database (WAL mode)
        |
        +-- memories           Core memory table
        +-- chunks             Text chunks with token counts
        +-- chunks_vec         vec0 virtual table (768-dim float embeddings)
        +-- chunks_fts         FTS5 virtual table (porter + unicode61 tokenizer)
        +-- embedding_cache    SHA-256 keyed embedding cache
        +-- tags / memory_tags Tag many-to-many relationship
        +-- tasks              Overnight task queue
        +-- task_results       Completed task outputs
        +-- meta               Schema version tracking
```

## MCP Tools

### Memory Tools

#### `memory_store`

Store a memory with automatic chunking and embedding.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | yes | -- | Memory content (any length) |
| `tags` | string[] | no | `[]` | Tags for filtering |
| `project` | string | no | -- | Project ID for scoping |
| `source` | string | no | -- | One of: `user`, `session-summary`, `automation`, `hook` |
| `metadata` | object | no | `{}` | Arbitrary JSON metadata |

Returns `{ id, chunks }` where `chunks` is the number of text segments created.

The text is split into overlapping chunks (500 tokens, 100 token overlap) respecting markdown code block boundaries. Each chunk is embedded with nomic-embed-text-v1.5 (prefixed with `search_document: `) and stored in both the vec0 and FTS5 indexes.

#### `memory_search`

Search memories using hybrid vector + keyword search.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | -- | Search query |
| `scope` | string | no | `'all'` | `'global'`, `'project'`, or `'all'` |
| `project` | string | no | -- | Project ID to scope to |
| `tags` | string[] | no | -- | Only return memories with ALL specified tags |
| `maxResults` | number | no | `10` | Max results (1-50) |
| `minScore` | number | no | `0.3` | Minimum relevance score (0-1) |

Returns `{ results: MemorySearchResult[] }` sorted by descending score.

**Search algorithm:**
1. Embed the query with `search_query: ` prefix
2. Run vector search (sqlite-vec or JS fallback) and FTS5 search in parallel
3. Merge results: `finalScore = 0.7 * vectorScore + 0.3 * ftsScore`
4. Group by memory (keep highest-scoring chunk per memory)
5. Apply project/tag filters
6. Return top N results above minScore

#### `memory_get`

Get a specific memory by ID with full metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Memory ID |

Returns the full memory record including content, tags, source, project, access count, and metadata.

#### `memory_list`

List memories with optional filtering.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | string | no | -- | Filter by project ID |
| `tag` | string | no | -- | Filter by tag name |
| `source` | string | no | -- | Filter by source |
| `since` | string | no | -- | ISO date lower bound |
| `limit` | number | no | `20` | Results per page (1-100) |
| `offset` | number | no | `0` | Pagination offset |

Returns `{ memories, total }`.

#### `memory_delete`

Delete a memory and all its chunks, embeddings, and tag associations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Memory ID |

Returns `{ deleted: boolean }`.

### Task Tools

#### `task_add`

Add a task to the overnight automation queue.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `description` | string | yes | -- | What the task should do |
| `type` | string | no | `'custom'` | `code-review`, `test-runner`, `doc-updater`, `refactor`, `custom` |
| `project` | string | no | -- | Project ID |
| `repoUrl` | string | no | -- | Git repo URL (will be cloned for context) |
| `priority` | number | no | `5` | Priority 1 (lowest) to 10 (highest) |
| `scheduledFor` | string | no | -- | ISO date to defer until |
| `context` | object | no | `{}` | Arbitrary context passed to the runner |
| `timeoutMs` | number | no | `1800000` | Execution timeout (min 1000ms) |

Returns `{ id, scheduledFor }`.

#### `task_list`

List tasks in the queue.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `status` | string | no | `'all'` | `pending`, `running`, `completed`, `failed`, `cancelled`, `all` |
| `project` | string | no | -- | Filter by project |
| `since` | string | no | -- | ISO date lower bound |
| `limit` | number | no | `20` | Results per page (1-100) |

#### `task_results`

Get results of completed tasks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `taskId` | string | no | -- | Get result for specific task |
| `since` | string | no | -- | ISO date lower bound |
| `limit` | number | no | `10` | Results per page (1-100) |

Returns results with `summary`, `success`, `error`, `durationMs`, `tokensUsed`, and `costUsd`.

#### `task_cancel`

Cancel a pending task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Task ID |

Returns `{ cancelled: boolean }`. Only tasks with `status = 'pending'` can be cancelled.

## Database Schema

The server uses a single SQLite database per scope:

- **Global database** at `{DATA_DIR}/global.db` -- stores memories without a project scope and all tasks
- **Per-project databases** at `{DATA_DIR}/projects/{projectId}/project.db` -- stores project-scoped memories

All databases use WAL mode for concurrent read performance. Schema migrations are forward-only, tracked via the `meta` table.

### Key tables

| Table | Purpose |
|-------|---------|
| `memories` | Core memory records with content, source, project_id, access tracking |
| `chunks` | Text chunks derived from memories with chunk_index and token_count |
| `chunks_vec` | vec0 virtual table: 768-dimensional float32 embeddings (requires sqlite-vec) |
| `chunks_fts` | FTS5 virtual table: porter + unicode61 tokenized content |
| `embedding_cache` | SHA-256 keyed cache of computed embeddings |
| `tags` | Unique tag names |
| `memory_tags` | Many-to-many join between memories and tags |
| `tasks` | Overnight task queue with status, priority, retry tracking |
| `task_results` | Completed task outputs with cost/token tracking |
| `meta` | Schema version for migration tracking |

## Embedding Pipeline

1. **Chunking** (`embedding/chunker.ts`): Text is split into overlapping segments of ~500 tokens (2000 chars) with 100-token overlap. The chunker respects markdown code block boundaries and avoids splitting mid-block.

2. **Cache check** (`embedding/cache.ts`): Before embedding, the SHA-256 hash of `prefix + text` is checked against the `embedding_cache` table. Cache hits skip model inference entirely.

3. **Embedding** (`embedding/embedder.ts`): Uses node-llama-cpp to run `nomic-embed-text-v1.5.Q8_0.gguf` locally. The model is lazy-loaded on first use. Documents are prefixed with `search_document: ` and queries with `search_query: ` per the Nomic specification (these produce different embeddings).

4. **L2 normalization**: All embeddings are normalized to unit length so that dot product equals cosine similarity.

5. **Storage**: Embeddings are inserted into both `chunks_vec` (for vector search) and `chunks_fts` (for keyword search).

6. **Fallback** (`embedding/fallback.ts`): When sqlite-vec is unavailable, vector search falls back to brute-force JavaScript cosine similarity over all cached embeddings.

## Cron Scheduler

The `CronScheduler` processes the overnight task queue:

- **Schedule**: Runs on a configurable cron expression (default: `0 2 * * *` -- 2 AM daily)
- **Immediate check**: Also checks for overdue pending tasks on server startup
- **Sequential processing**: Tasks are processed one at a time in priority order
- **Retry logic**: Failed tasks are re-queued up to `maxRetries` times, then permanently marked as failed
- **Repo cloning**: Tasks with a `repoUrl` get a temporary clone for context
- **Cleanup**: Cloned repos are cleaned up after task completion

### Task Runners

| Runner | Trigger | Description |
|--------|---------|-------------|
| `AnthropicApiRunner` | `ANTHROPIC_API_KEY` is set | Calls the Anthropic Messages API (default model: `claude-sonnet-4-20250514`) with a structured system prompt. Tracks token usage and cost. |
| `CliRunner` | Fallback when no API key | Invokes `claude --print --max-turns 10` as a child process. Uses the task clone path as `--cwd` if available. |

Both runners respect the per-task `timeoutMs` and abort on timeout.

## Health Endpoint

`GET /health` returns server diagnostics:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 3600,
  "memory": { "rss": 120.5, "heapUsed": 45.2, "heapTotal": 60.0 },
  "database": { "globalDb": 2.5 },
  "vecAvailable": true,
  "embeddingLoaded": true,
  "sessions": 1,
  "cacheStats": { "size": 1024, "hits": 500, "misses": 100 },
  "taskQueueDepth": 3,
  "scheduler": { "enabled": true, "running": false, "stats": { "tasksCompleted": 10, "tasksFailed": 1, "lastRunAt": "..." } }
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3577` | HTTP listen port |
| `DATA_DIR` | `~/.claude-memory/data` | SQLite database directory |
| `MODEL_PATH` | `~/.claude-memory/models/nomic-embed-text-v1.5.Q8_0.gguf` | GGUF model path |
| `AUTH_TOKEN` | *(none)* | Bearer token for `/mcp` endpoint |
| `SCHEDULER_ENABLED` | `true` | Set to `'false'` to disable the cron scheduler |
| `CRON_SCHEDULE` | `0 2 * * *` | Cron expression for the task runner |
| `ANTHROPIC_API_KEY` | *(none)* | Enables the API runner (otherwise falls back to CLI) |

## Development

```bash
# Build
pnpm build          # tsc -> dist/

# Run in dev mode (auto-restart on changes)
pnpm dev            # node --watch dist/index.js

# Run tests
pnpm test           # vitest run
pnpm test:watch     # vitest

# Start in production
pnpm start          # node dist/index.js
```

### Adding a new MCP tool

1. **Types**: Define `YourToolInput` and `YourToolOutput` in `@claude-memory/shared/types.ts`
2. **Schema**: Add a Zod schema in `@claude-memory/shared/schemas.ts`
3. **Handler**: Create `packages/server/src/tools/your-tool.ts` implementing the handler function with signature `(ctx: ServerContext, input: YourToolInput) => Promise<YourToolOutput>`
4. **Export**: Add the handler to `packages/server/src/tools/index.ts`
5. **Register**: Add a `server.tool(...)` call in `packages/server/src/server.ts` with name, description, schema, and handler
6. **Test**: Add tests in `packages/server/src/__tests__/`
