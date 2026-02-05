# ARCHITECTURE.md -- claude-memory

> **Purpose of this document:** This is the PRIMARY reference for any Claude instance working
> on the claude-memory codebase. It is written so that a Claude with ZERO prior context can
> understand the entire system and make changes confidently.

---

## 1. System Overview

**claude-memory** is a persistent memory system for Claude Code. It gives Claude the ability
to store, search, and recall information across sessions -- architectural decisions, coding
conventions, debugging discoveries, and user preferences -- so that every new conversation
starts with relevant context instead of a blank slate.

It also provides an overnight task automation queue: users can enqueue code reviews,
refactoring suggestions, or custom tasks that run unattended via the Anthropic API or
the `claude` CLI.

### High-Level Architecture

```
 Claude Code Session
 ===================
      |                  |
 SessionStart hook   SessionEnd hook
      |                  |
      v                  v
  +---------+     +------------+
  | Search  |     | Summarize  |
  | memories|     | transcript |
  +---------+     +------+-----+
      |                  |
      |  MCP JSON-RPC    |  MCP JSON-RPC
      |  over HTTP       |  over HTTP
      v                  v
 +-----------------------------------+
 |         MCP Server (Express)      |
 |  StreamableHTTPServerTransport    |
 |-----------------------------------|
 |  10 MCP Tools                     |
 |    memory_store  memory_search    |
 |    memory_get    memory_list      |
 |    memory_delete  memory_cleanup  |
 |    task_add  task_list            |
 |    task_results  task_cancel      |
 |-----------------------------------|
 |  Embedding Pipeline               |
 |    nomic-embed-text-v1.5 (GGUF)  |
 |    node-llama-cpp  (lazy-loaded)  |
 |    L2 normalization               |
 |    embedding cache (SQLite)       |
 |-----------------------------------|
 |  Hybrid Search Engine             |
 |    sqlite-vec (vector)            |
 |    FTS5 (full-text)               |
 |    70/30 weighted merge           |
 |-----------------------------------|
 |  Cron Scheduler                   |
 |    node-cron -> TaskRunner        |
 |    AnthropicApiRunner | CliRunner |
 |-----------------------------------|
 |  SQLite (better-sqlite3 + WAL)   |
 |    global.db + per-project DBs   |
 +-----------------------------------+
```

### Key Design Decisions and Tradeoffs

| Decision | Rationale |
|----------|-----------|
| **SQLite over Postgres** | Single-binary deployment, zero ops overhead, WAL mode gives good read concurrency. Tradeoff: no multi-writer concurrency (acceptable for single-server). |
| **Local embedding model (GGUF)** | No external API calls for embeddings = zero latency, zero cost, works offline. Tradeoff: ~137 MB model file, ~800 MB RAM when loaded. |
| **Lazy model loading** | Model only loads on first embed call, so server starts fast and only allocates RAM when needed. |
| **Hybrid search (vector + FTS)** | Pure vector search misses exact keyword matches; pure FTS misses semantic similarity. The 70/30 blend provides best-of-both-worlds retrieval. |
| **3-second hook timeout** | Hooks MUST NOT block Claude Code startup. All hook operations fail silently within 3 seconds. |
| **Per-project databases** | Keeps project data isolated for easy cleanup/export. Global DB for cross-project memories. |
| **ESM-only** | The entire codebase uses ES modules (`"type": "module"`). `createRequire()` is used only for sqlite-vec which needs CommonJS loading. |
| **Monorepo with pnpm workspaces** | Shared types and constants across packages, single `pnpm -r build` builds everything. |

---

## 2. Monorepo Structure

```
claude-memory/
+-- package.json                 Root workspace config (pnpm, ESM, Node >= 22)
+-- pnpm-workspace.yaml          packages/*
+-- tsconfig.base.json           Shared TS config (ES2022, Node16 module resolution)
+-- vitest.workspace.ts          Test runner config
|
+-- packages/
|   +-- shared/                  @claude-memory/shared
|   |   +-- src/
|   |       +-- index.ts         Barrel export
|   |       +-- types.ts         Core interfaces: Memory, Chunk, SearchResult, Task, TaskResult, all MCP I/O types
|   |       +-- schemas.ts       Zod schemas for every MCP tool input
|   |       +-- constants.ts     All magic numbers: ports, dimensions, weights, timeouts
|   |       +-- project-id.ts    normalizeGitUrl(), deriveProjectId(), deriveProjectIdFromPath()
|   |
|   +-- server/                  @claude-memory/server
|   |   +-- src/
|   |       +-- index.ts         Entry point: wires DB, embedder, cache, Express, scheduler
|   |       +-- server.ts        Creates McpServer, registers all 10 tools
|   |       +-- db/
|   |       |   +-- connection.ts    SQLite connection pool, WAL, sqlite-vec loading
|   |       |   +-- migrations.ts    Schema versioning, V1 DDL for all tables
|   |       |   +-- memory-repo.ts   CRUD for memories table
|   |       |   +-- chunk-repo.ts    CRUD for chunks + chunks_vec + chunks_fts
|   |       |   +-- tag-repo.ts      Tag management (ensure, set, get, batch-get)
|   |       |   +-- task-repo.ts     Task queue CRUD: add, claim, complete, fail, requeue, cancel
|   |       +-- embedding/
|   |       |   +-- embedder.ts      Embedder interface, node-llama-cpp lazy loader, L2 normalize
|   |       |   +-- chunker.ts       Text chunking with markdown awareness
|   |       |   +-- cache.ts         SQLite-backed embedding cache (text_hash -> BLOB)
|   |       |   +-- fallback.ts      JS-based cosine similarity for when sqlite-vec is unavailable
|   |       |   +-- index.ts         Barrel export
|   |       +-- search/
|   |       |   +-- hybrid.ts        The core search algorithm: embed -> vec + FTS -> merge -> rank
|   |       |   +-- index.ts         Barrel export
|   |       +-- cron/
|   |       |   +-- scheduler.ts     CronScheduler class: node-cron, sequential processing, retry
|   |       |   +-- runner.ts        TaskRunner interface + TaskRunResult
|   |       |   +-- api-runner.ts    AnthropicApiRunner: direct API calls with cost tracking
|   |       |   +-- cli-runner.ts    CliRunner: claude --print --max-turns 10 fallback
|   |       |   +-- codebase-access.ts  Git clone/cleanup for task repo access
|   |       +-- tools/
|   |           +-- index.ts         Barrel export for all 10 tool handlers
|   |           +-- memory-store.ts  Store: chunk -> embed -> insert memory + chunks + vec + fts
|   |           +-- memory-search.ts Search: scope resolution -> hybridSearch -> merge results
|   |           +-- memory-get.ts    Get: global DB first, then scan project DBs
|   |           +-- memory-list.ts   List: filter by project/tag/source/since with pagination
|   |           +-- memory-delete.ts Delete: cascade through chunks_vec, chunks_fts, chunks, memory
|   |           +-- task-add.ts      Add task to queue
|   |           +-- task-list.ts     List tasks with status/project/date filters
|   |           +-- task-results.ts  Get completed task results with cost info
|   |           +-- task-cancel.ts   Cancel a pending task
|   |
|   +-- hooks/                   @claude-memory/hooks
|   |   +-- src/
|   |       +-- cli.ts           Entry point: read stdin, dispatch by hook_event_name, 3s timeout
|   |       +-- types.ts         HookInput, SessionStartOutput, TranscriptMessage, MemoryClientConfig
|   |       +-- handlers/
|   |       |   +-- session-start.ts  Detect project -> search memories -> return additionalContext
|   |       |   +-- session-end.ts    Parse transcript -> summarize -> store as memory
|   |       +-- lib/
|   |           +-- memory-client.ts  MCP JSON-RPC client over HTTP with timeout + auth
|   |           +-- project-detect.ts Walk up to .git, parse config, derive project ID
|   |           +-- transcript-parser.ts Parse JSONL transcript, extract topics/actions/files
|   |
|   +-- skills/                  Skill definitions (Markdown files for Claude Code)
|       +-- remember/SKILL.md    /remember -- store a memory with auto-tagging
|       +-- recall/SKILL.md      /recall -- search memories with formatted output
|       +-- tasks/SKILL.md       /tasks -- manage overnight automation queue
|       +-- morning-report/SKILL.md  /morning-report -- view overnight task results
|
+-- scripts/
|   +-- setup-local.ts           Interactive setup: configure MCP server + hooks + env vars
|   +-- download-model.sh        Download nomic-embed-text-v1.5 GGUF model
|   +-- deploy.sh                Deploy to server
|   +-- setup-server.sh          Server-side setup
|   +-- setup-cloudflare-tunnel.sh  Cloudflare tunnel for HTTPS
|   +-- backup-db.sh             SQLite backup with retention
|
+-- deploy/
    +-- claude-memory.service    systemd unit file
```

---

## 3. Data Flow

### 3.1 Memory Storage Flow

```
User calls memory_store(text, tags?, project?, source?)
  |
  v
handleMemoryStore (tools/memory-store.ts)
  |
  +-- 1. Resolve database: project-scoped DB or global DB
  +-- 2. createMemory(db, {content, source, projectId, metadata})
  |     -> INSERT INTO memories ... RETURNING *
  +-- 3. setMemoryTags(db, memoryId, tags)
  |     -> UPSERT into tags + memory_tags junction
  +-- 4. chunkText(text)
  |     -> Split on line boundaries, respect code blocks
  |     -> Default: 500 tokens/chunk, 100 token overlap
  |     -> ~4 chars/token approximation
  +-- 5. For each chunk:
  |     +-- Check embedding cache (text_hash lookup)
  |     +-- If miss: embedder.embed(chunk, 'document')
  |     |    -> Prefix with "search_document: "
  |     |    -> node-llama-cpp getEmbeddingFor()
  |     |    -> L2 normalize result
  |     |    -> Store in cache
  |     +-- Collect {content, chunkIndex, tokenCount, embedding}
  +-- 6. createChunks(db, memoryId, chunksWithEmbeddings)
        -> Transaction:
           INSERT INTO chunks (memory_id, content, chunk_index, token_count)
           INSERT INTO chunks_vec (chunk_id, embedding)  [if sqlite-vec available]
           INSERT INTO chunks_fts (chunk_id, memory_id, content)
```

### 3.2 Memory Search Flow

```
User calls memory_search(query, scope?, project?, tags?, maxResults?, minScore?)
  |
  v
handleMemorySearch (tools/memory-search.ts)
  |
  +-- 1. Resolve databases to search based on scope:
  |     - "global": global DB only
  |     - "project": project DB only (if project ID provided)
  |     - "all": both global + project DB
  |
  +-- 2. For each database, call hybridSearch():
  |     |
  |     +-- a. Embed the query:
  |     |     embedder.embed(query, 'query')
  |     |     -> Prefix with "search_query: "
  |     |     -> L2 normalize
  |     |
  |     +-- b. Run vector search + FTS search concurrently:
  |     |     +-- Vector: searchVector(db, queryEmbedding, limit*3)
  |     |     |   -> SELECT ... vec_distance_cosine(v.embedding, ?) ... ORDER BY distance ASC
  |     |     |   -> Score = 1 - distance
  |     |     |   (Fallback if no sqlite-vec: load all embeddings, brute-force JS cosine similarity)
  |     |     |
  |     |     +-- FTS: searchFTS(db, query, limit*3)
  |     |         -> AND-join quoted tokens
  |     |         -> SELECT ... FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank
  |     |         -> Score = 1 / (1 + |rank|)
  |     |
  |     +-- c. Merge by chunkId:
  |     |     finalScore = 0.7 * vectorScore + 0.3 * ftsScore
  |     |
  |     +-- d. Filter by minScore (default 0.3)
  |     |
  |     +-- e. Group by memoryId: keep highest-scoring chunk per memory
  |     |
  |     +-- f. Fetch memory metadata + tags in batch
  |     |
  |     +-- g. Apply projectId and tag filters post-fetch
  |
  +-- 3. If multiple DBs searched: deduplicate by memory ID (keep highest score)
        -> Sort by score descending -> return top maxResults
```

### 3.3 Session Start Hook

```
Claude Code starts a new session
  |
  v
Invokes hook command: node packages/hooks/dist/cli.js
  |
  +-- stdin receives JSON: { hook_event_name: "SessionStart", session_id, cwd, ... }
  +-- Global 3-second timeout (process.exit(0) if exceeded)
  |
  v
handleSessionStart(input)
  |
  +-- 1. detectProject(cwd):
  |     - Walk up from cwd looking for .git directory/file
  |     - Parse .git/config for [remote "origin"] URL
  |     - normalizeGitUrl(): SSH/HTTPS variants -> canonical HTTPS form
  |     - deriveProjectId(): SHA-256 of normalized URL, first 16 hex chars
  |     - Fallback: deriveProjectIdFromPath(cwd) if no git repo
  |
  +-- 2. createMemoryClient() using CLAUDE_MEMORY_URL + CLAUDE_MEMORY_TOKEN
  |
  +-- 3. Search project-specific memories (max 5):
  |     MCP JSON-RPC POST to /mcp -> tools/call memory_search
  |     query: "project context, conventions, architecture decisions, and preferences"
  |     scope: "project"
  |
  +-- 4. Search global memories (max 3):
  |     query: "general coding preferences, patterns, and conventions"
  |     scope: "global"
  |
  +-- 5. Format as "# Recalled Memories" block
        -> stdout: { additionalContext: "# Recalled Memories\n## Project: ...\n- ..." }
        -> Claude Code injects this into the conversation context
```

### 3.4 Session End Hook

```
Claude Code session ends
  |
  v
Invokes hook command: node packages/hooks/dist/cli.js
  |
  +-- stdin receives JSON: { hook_event_name: "SessionEnd", transcript_path, cwd, ... }
  +-- Global 3-second timeout
  |
  v
handleSessionEnd(input)
  |
  +-- 1. parseTranscript(transcript_path):
  |     - Read JSONL file, parse each line
  |     - Extract role + text content (handles string or array-of-blocks)
  |     - Skip malformed lines silently
  |
  +-- 2. summarizeTranscript(messages):
  |     - Filter messages with content > 10 chars
  |     - Require >= 3 user messages (skip trivial sessions)
  |     - Extract: file mentions, action keywords, topic keywords
  |     - Build summary paragraph (max 2000 chars)
  |     - Return empty string if session too short
  |
  +-- 3. detectProject(cwd) -> projectId
  |
  +-- 4. client.store(summary, {source: "session-summary", project, tags: ["session", "auto-summary"]})
```

### 3.5 Task Automation Flow

```
User calls task_add(description, type?, project?, repoUrl?, priority?, ...)
  |
  v
INSERT INTO tasks (description, type, priority, project_id, repo_url, ...)
  status = 'pending'
  |
  v
CronScheduler (default: 2 AM daily, configurable via CRON_SCHEDULE)
  |
  +-- processPendingTasks() -- sequential, re-entrancy guard
      |
      +-- while (getNextPending() != null):
          |
          +-- 1. getNextPending():
          |     SELECT * FROM tasks WHERE status='pending'
          |       AND (scheduled_for IS NULL OR scheduled_for <= now)
          |     ORDER BY priority DESC, created_at ASC LIMIT 1
          |
          +-- 2. claimTask(id):
          |     UPDATE tasks SET status='running', started_at=now WHERE id=? AND status='pending'
          |     (atomic: returns false if already claimed)
          |
          +-- 3. Clone repo if task.repoUrl set:
          |     git clone --depth 1 [--branch X] <url> <tmpdir>
          |     Inject clonePath into task.context
          |
          +-- 4. runner.run(task):
          |     +-- AnthropicApiRunner:
          |     |   - messages.create(model: "claude-sonnet-4-20250514", max_tokens: 4096)
          |     |   - Tracks input/output tokens and cost
          |     |   - AbortController with task.timeoutMs
          |     |
          |     +-- CliRunner:
          |         - Runs claude --print --max-turns 10 <prompt> as child process
          |         - 10 MB max buffer, task.timeoutMs
          |
          +-- 5a. On success:
          |     completeTask(id, {output, summary, success:true, durationMs, tokensUsed, costUsd})
          |     -> UPDATE tasks SET status='completed', completed_at=now
          |     -> INSERT INTO task_results (...)
          |
          +-- 5b. On failure:
          |     if retryCount < maxRetries:
          |       requeueTask(id) -> SET status='pending', retry_count++
          |     else:
          |       failTask(id, error) -> SET status='failed' + INSERT task_results
          |
          +-- 6. Cleanup: rm -rf clonePath
```

---

## 4. Database Schema

All tables live in SQLite databases managed by better-sqlite3 with WAL mode enabled.
There is one **global database** (`{DATA_DIR}/global.db`) and optional **per-project
databases** (`{DATA_DIR}/projects/{projectId}/project.db`).

### Migration System

Migrations are forward-only, controlled by a `schema_version` key in the `meta` table.
The function `runMigrations(db, vecAvailable)` checks the current version and applies
pending migrations. Currently at **version 1**.

```
File: packages/server/src/db/migrations.ts
Function: runMigrations(db, vecAvailable)

Version check: SELECT value FROM meta WHERE key = 'schema_version'
If version < 1: apply V1 schema
Future: if version < 2: apply V2 migration, etc.
```

### Table: `meta`

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT | PRIMARY KEY |
| `value` | TEXT | NOT NULL |

Stores schema version and other metadata.

### Table: `memories`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | `lower(hex(randomblob(16)))` | PRIMARY KEY, 32-char hex string |
| `content` | TEXT | | NOT NULL, the full memory text |
| `source` | TEXT | NULL | 'user', 'session-summary', 'automation', 'hook' |
| `project_id` | TEXT | NULL | 16-char hex project ID |
| `created_at` | TEXT | `datetime('now')` | ISO 8601 |
| `updated_at` | TEXT | `datetime('now')` | ISO 8601 |
| `last_accessed_at` | TEXT | `datetime('now')` | Updated on every get() |
| `access_count` | INTEGER | 0 | Incremented on every get() |
| `metadata` | TEXT | '{}' | JSON blob |

**Indexes:**
- `idx_memories_project` on `project_id`
- `idx_memories_source` on `source`
- `idx_memories_created` on `created_at`

### Table: `tags`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT |
| `name` | TEXT | NOT NULL UNIQUE |

### Table: `memory_tags` (junction)

| Column | Type | Notes |
|--------|------|-------|
| `memory_id` | TEXT | FK -> memories(id) ON DELETE CASCADE |
| `tag_id` | INTEGER | FK -> tags(id) ON DELETE CASCADE |

**Primary key:** `(memory_id, tag_id)`
**Index:** `idx_memory_tags_tag` on `tag_id`

### Table: `chunks`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT | PRIMARY KEY, 32-char hex |
| `memory_id` | TEXT | FK -> memories(id) ON DELETE CASCADE |
| `content` | TEXT | NOT NULL, chunk text |
| `chunk_index` | INTEGER | NOT NULL, position within memory |
| `token_count` | INTEGER | NOT NULL, estimated token count |
| `created_at` | TEXT | `datetime('now')` |

**Constraints:** `UNIQUE(memory_id, chunk_index)`
**Index:** `idx_chunks_memory` on `memory_id`

### Virtual Table: `chunks_vec` (sqlite-vec)

```sql
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[768]
);
```

Only created when sqlite-vec extension is available. Stores 768-dimensional float32
embeddings for vector similarity search via `vec_distance_cosine()`.

### Virtual Table: `chunks_fts` (FTS5)

```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  memory_id UNINDEXED,
  tokenize='porter unicode61'
);
```

Full-text search with Porter stemming and Unicode tokenization. The `chunk_id` and
`memory_id` columns are stored but not indexed (used for joining back to main tables).

### Table: `embedding_cache`

| Column | Type | Notes |
|--------|------|-------|
| `text_hash` | TEXT | PRIMARY KEY, SHA-256 of (prefix + text) |
| `embedding` | BLOB | Float32Array serialized as Buffer |
| `model_id` | TEXT | NOT NULL, e.g. 'nomic-embed-text-v1.5' |
| `created_at` | TEXT | `datetime('now')` |

### Table: `tasks`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | TEXT | `lower(hex(randomblob(16)))` | PRIMARY KEY |
| `description` | TEXT | | NOT NULL |
| `type` | TEXT | 'custom' | 'code-review', 'test-runner', 'doc-updater', 'refactor', 'custom' |
| `status` | TEXT | 'pending' | 'pending', 'running', 'completed', 'failed', 'cancelled' |
| `priority` | INTEGER | 0 | Higher = processed first |
| `project_id` | TEXT | NULL | |
| `repo_url` | TEXT | NULL | Git URL for repo access |
| `scheduled_for` | TEXT | NULL | ISO datetime, task waits until this time |
| `started_at` | TEXT | NULL | Set when claimed |
| `completed_at` | TEXT | NULL | Set when completed |
| `retry_count` | INTEGER | 0 | Incremented on failure |
| `max_retries` | INTEGER | 1 | Maximum retry attempts |
| `timeout_ms` | INTEGER | 1800000 | 30 minutes default |
| `context` | TEXT | '{}' | JSON blob with extra data |
| `created_at` | TEXT | `datetime('now')` | |
| `updated_at` | TEXT | `datetime('now')` | |

**Indexes:**
- `idx_tasks_status` on `status`
- `idx_tasks_project` on `project_id`
- `idx_tasks_scheduled` on `scheduled_for`

### Table: `task_results`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT | PRIMARY KEY |
| `task_id` | TEXT | FK -> tasks(id) ON DELETE CASCADE |
| `output` | TEXT | NOT NULL, full output text |
| `summary` | TEXT | NULL, truncated to 500 chars |
| `success` | INTEGER | 0 or 1 |
| `error` | TEXT | NULL, error message if failed |
| `duration_ms` | INTEGER | NULL |
| `tokens_used` | INTEGER | NULL, input + output tokens |
| `cost_usd` | REAL | NULL, computed from token counts |
| `memory_id` | TEXT | NULL, if result was stored as a memory |
| `created_at` | TEXT | `datetime('now')` |

**Index:** `idx_task_results_task` on `task_id`

### Entity Relationships

```
memories 1--* chunks          (memory_id FK, CASCADE delete)
memories *--* tags            (via memory_tags junction, CASCADE delete)
chunks   1--1 chunks_vec      (chunk_id, manual cleanup required)
chunks   1--1 chunks_fts      (chunk_id, manual cleanup required)
tasks    1--* task_results    (task_id FK, CASCADE delete)
```

**Important:** Virtual tables (chunks_vec, chunks_fts) do not support foreign key
cascades. When deleting a memory, the code in `deleteMemory()` manually deletes
from chunks_vec and chunks_fts BEFORE deleting from memories (which cascades
to chunks and memory_tags).

---

## 5. MCP Server

### Transport

The server uses **Streamable HTTP** transport (not stdio), served via Express:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/mcp` | Main MCP request handling (tool calls, initialization) |
| GET | `/mcp` | SSE stream for server-initiated messages (requires active session) |
| DELETE | `/mcp` | Explicit session cleanup |
| GET | `/health` | Health check with metrics |

### Session Management

Sessions are tracked via `Map<string, StreamableHTTPServerTransport>`:
- New POST without `mcp-session-id` header creates a new transport + UUID session
- Subsequent requests with `mcp-session-id` reuse the existing transport
- DELETE closes and removes the session
- `transport.onclose` callback auto-cleans the map

### Auth Middleware

If `AUTH_TOKEN` env var is set, all `/mcp` endpoints require:
```
Authorization: Bearer <token>
```
Returns 401 Unauthorized if token is missing or incorrect.

### Registered Tools (10 total)

| Tool | Description | Key Behavior |
|------|-------------|--------------|
| `memory_store` | Store a memory with automatic chunking and embedding | Chunks text, generates embeddings, inserts into 4 tables |
| `memory_search` | Search memories using hybrid vector + keyword search | Scope-aware (global/project/all), 70/30 weighted scoring |
| `memory_get` | Get a specific memory by ID | Scans global DB then project DBs, increments access_count |
| `memory_list` | List memories with filtering | Filter by project/tag/source/since, paginated |
| `memory_delete` | Delete a memory and all its chunks | Manual virtual table cleanup + CASCADE for regular tables |
| `memory_cleanup` | Clean up old memories not accessed since a given date | Dry-run by default, supports project scoping and maxCount limit |
| `task_add` | Add a task to the overnight queue | Supports priority, scheduling, timeout, repo URL |
| `task_list` | List tasks with status/project/date filters | Ordered by priority DESC, created_at DESC |
| `task_results` | Get completed task results with cost info | Joins task_results with tasks for description |
| `task_cancel` | Cancel a pending task | Only works if status is 'pending' |

### Health Endpoint

GET `/health` returns:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345.67,
  "memory": { "rss": 150.5, "heapUsed": 80.2, "heapTotal": 120.0 },
  "database": { "globalDb": 5.2 },
  "vecAvailable": true,
  "embeddingLoaded": true,
  "sessions": 2,
  "cacheStats": { "size": 1000, "hits": 500, "misses": 200 },
  "taskQueueDepth": 3,
  "scheduler": { "enabled": true, "running": false, "stats": {} }
}
```

---

## 6. Embedding Pipeline

### Model

- **Model:** nomic-embed-text-v1.5
- **Quantization:** Q8_0 GGUF format
- **File:** `nomic-embed-text-v1.5.Q8_0.gguf` (~137 MB)
- **Dimensions:** 768
- **Runtime:** node-llama-cpp (dynamically imported)

### Prefix Convention (Critical)

Nomic embed models use **task-specific prefixes** that produce different embedding spaces:

| Usage | Prefix | Constant |
|-------|--------|----------|
| Storing documents | `"search_document: "` | `EMBED_PREFIX_DOCUMENT` |
| Search queries | `"search_query: "` | `EMBED_PREFIX_QUERY` |

**WARNING:** Using the wrong prefix will produce poor search results. Documents
MUST be embedded with the document prefix; queries MUST use the query prefix.

### Lazy Loading

The embedder is created eagerly but the model is loaded lazily on first `embed()` call:

```typescript
const embedder = await createEmbedder(modelPath);
// Model NOT loaded yet -- server starts fast

// First call triggers loading:
const vec = await embedder.embed("hello", "document");
// node-llama-cpp getLlama() -> loadModel() -> createEmbeddingContext()
// Subsequent calls reuse the loaded model
```

### L2 Normalization

All embeddings are L2-normalized to unit vectors after generation. This ensures
cosine distance = 1 - dot product, simplifying similarity computations.

```typescript
function l2Normalize(vec: Float32Array): Float32Array {
  // Compute magnitude, divide each element, handle NaN/Inf
}
```

### Embedding Cache

The cache maps `SHA-256(prefix + text)` to the raw Float32Array (stored as BLOB
in `embedding_cache` table). The prefix is included in the hash because the same
text produces different embeddings with different prefixes.

```
Cache key = SHA-256("search_document: " + text)  // for documents
Cache key = SHA-256("search_query: " + text)      // for queries
```

The cache tracks hits/misses in memory and reports via `/health`.

### Chunking

Text is split into overlapping chunks for embedding:

| Parameter | Default | Constant |
|-----------|---------|----------|
| Max tokens per chunk | 500 | `DEFAULT_CHUNK_TOKENS` |
| Overlap tokens | 100 | `DEFAULT_CHUNK_OVERLAP` |
| Chars per token estimate | 4 | `APPROX_CHARS_PER_TOKEN` |

Chunking rules:
- Splits on line boundaries (never mid-line)
- Does NOT split inside fenced code blocks
- Overlap carries the last N lines from the previous chunk
- Short text (less than maxTokens) becomes a single chunk

---

## 7. Hybrid Search Algorithm

### Overview

The search combines two strategies and merges with weighted scoring:

```
                     query
                    /     \
                   /       \
          embed(query)    tokenize(query)
              |                |
              v                v
        searchVector()    searchFTS()
              |                |
              v                v
        vec results       fts results
        (score: cosine)   (score: 1/(1+|rank|))
              \               /
               \             /
                merge by chunkId
                      |
                      v
              finalScore = 0.7 * vecScore + 0.3 * ftsScore
                      |
                      v
              filter by minScore (default 0.3)
                      |
                      v
              group by memoryId (best chunk per memory)
                      |
                      v
              fetch metadata + tags
                      |
                      v
              apply project/tag filters
                      |
                      v
              return top maxResults
```

### Vector Search

When sqlite-vec is available:
```sql
SELECT v.chunk_id, c.memory_id, c.content,
       vec_distance_cosine(v.embedding, ?) as distance
FROM chunks_vec v
JOIN chunks c ON v.chunk_id = c.id
ORDER BY distance ASC
LIMIT ?
```
Score = `1 - distance` (cosine similarity from cosine distance).

When sqlite-vec is NOT available, falls back to brute-force JS:
- Load ALL chunk embeddings from chunks_vec into memory
- Compute cosine similarity for each
- Sort and take top N

### FTS5 Search

```sql
-- Query preprocessing: AND-join quoted tokens
-- "persistent memory system" becomes: "persistent" AND "memory" AND "system"

SELECT chunk_id, memory_id, content, rank
FROM chunks_fts
WHERE chunks_fts MATCH ?
ORDER BY rank
LIMIT ?
```

FTS5's `rank` is negative (more negative = better match). The score is
normalized to `1 / (1 + |rank|)` to produce a 0..1 range.

### Scoring Weights

| Component | Weight | Constant |
|-----------|--------|----------|
| Vector similarity | 0.7 (70%) | `DEFAULT_VECTOR_WEIGHT` |
| FTS5 relevance | 0.3 (30%) | `DEFAULT_FTS_WEIGHT` |

A chunk appearing in BOTH vector and FTS results gets both scores combined.
A chunk appearing in only one gets only that weighted score.

### Graceful Degradation

If sqlite-vec fails to load (e.g., platform incompatibility), the system
still works:
1. `vecAvailable` flag is set to `false`
2. Vector embeddings still stored in chunks_vec (for future use)
3. Search uses JS-based brute-force cosine similarity as fallback
4. FTS5 always works (built into SQLite)

---

## 8. Cron/Task System

### CronScheduler

**File:** `packages/server/src/cron/scheduler.ts`

```typescript
class CronScheduler {
  // node-cron based, default schedule "0 2 * * *" (2 AM daily)
  // Re-entrancy guard: if processing=true, skip this cron tick
  // Sequential: processes one task at a time in a while loop
  // On start(): also immediately checks for overdue pending tasks
  // On stop(): waits for in-flight task to complete (no abort)
}
```

Key behaviors:
- **Sequential processing:** Tasks run one at a time, never in parallel
- **Re-entrancy guard:** `this.processing` flag prevents overlapping runs
- **Immediate check on start:** Picks up any overdue tasks from previous crashes
- **Graceful stop:** Waits for current task to finish before exiting

### TaskRunner Interface

```typescript
interface TaskRunner {
  name: string;
  run(task: Task): Promise<TaskRunResult>;
  dispose?(): Promise<void>;
}

interface TaskRunResult {
  output: string;
  summary?: string;
  success: boolean;
  error?: string;
  tokensUsed?: number;
  costUsd?: number;
}
```

### AnthropicApiRunner

**File:** `packages/server/src/cron/api-runner.ts`

- Uses `@anthropic-ai/sdk` to call the Anthropic Messages API directly
- Default model: `claude-sonnet-4-20250514`
- Max tokens: 4096
- Builds system prompt from task type, description, repo URL, and context
- Tracks token usage and computes cost:
  - Input: $3 / 1M tokens
  - Output: $15 / 1M tokens
- AbortController with task.timeoutMs for timeout handling

### CliRunner

**File:** `packages/server/src/cron/cli-runner.ts`

- Runs `claude --print --max-turns 10 <prompt>` as a child process
- If task has `clonePath` in context, uses `--cwd <clonePath>`
- 10 MB max stdout buffer
- Timeout via both AbortController and child process timeout option
- Extracts partial stdout from error objects on failure

### Codebase Access

**File:** `packages/server/src/cron/codebase-access.ts`

- `cloneRepo(url, targetDir, {branch?, token?})`: shallow `git clone --depth 1`
- Auth token injected into HTTPS URL as username
- 2-minute timeout for clone operation
- `cleanupClone(dir)`: recursive remove after task completes
- `createTempDir(prefix)`: `mkdtemp` in system temp directory

### Retry Logic

```
Task fails:
  if task.retryCount < task.maxRetries (default: 1):
    requeueTask(id)  ->  status = 'pending', retry_count++
    Task will be picked up on next processPendingTasks() pass
  else:
    failTask(id, error)  ->  status = 'failed', INSERT failure result
```

---

## 9. Hooks System

### Overview

Hooks are invoked by Claude Code as external commands at session boundaries.
The hook binary is `packages/hooks/dist/cli.js` (built by tsup).

**Critical constraint:** Hooks MUST complete within 3 seconds (`HOOK_TIMEOUT_MS`).
They must NEVER block Claude Code from starting or shutting down.

### CLI Entry Point

**File:** `packages/hooks/src/cli.ts`

```
async function main() {
  // 1. Set 3-second hard timeout -> process.exit(0)
  // 2. Skip if CLAUDE_MEMORY_URL not configured -> exit(0)
  // 3. Read all of stdin -> parse JSON as HookInput
  // 4. Dispatch by event name:
  //    - "SessionStart" -> handleSessionStart() -> write JSON to stdout
  //    - "SessionEnd"   -> handleSessionEnd() -> no output
  // 5. Any error -> exit(0) silently (never fail)
}
```

### HookInput (stdin JSON from Claude Code)

```typescript
interface HookInput {
  hook_event_name: 'SessionStart' | 'SessionEnd';
  session_id: string;
  transcript_path?: string;   // SessionEnd only
  cwd: string;
  permission_mode?: string;
  source?: string;
  model?: string;
  reason?: string;            // SessionEnd: 'clear', 'logout', 'prompt_input_exit', etc.
}
```

### SessionStart Output (stdout JSON)

```typescript
interface SessionStartOutput {
  additionalContext?: string;  // Injected into Claude Code's conversation context
}
```

### Memory Client

**File:** `packages/hooks/src/lib/memory-client.ts`

Communicates with the MCP server via raw JSON-RPC over HTTP (not the full MCP
SDK, since hooks need to be minimal and fast):

```
POST {serverUrl}/mcp
Content-Type: application/json
Authorization: Bearer {authToken}

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "memory_search", "arguments": { ... } }
}

Timeout: HOOK_TIMEOUT_MS (3 seconds)
Any error -> return null silently
```

### Project Detection

**File:** `packages/hooks/src/lib/project-detect.ts`

1. Walk up from `cwd` looking for `.git` directory or file (worktrees)
2. Parse `.git/config` (or follow gitdir pointer for worktrees)
3. Extract `[remote "origin"]` URL
4. Normalize URL:
   - `git@github.com:user/repo.git` -> `https://github.com/user/repo`
   - `ssh://git@host/path.git` -> `https://host/path`
   - Lowercase hostname, strip trailing `.git` and `/`
5. `deriveProjectId()`: SHA-256 of normalized URL, first 16 hex chars
6. Fallback: `deriveProjectIdFromPath(cwd)` for non-git directories

---

## 10. Configuration

### Environment Variables

| Variable | Default | Used By | Description |
|----------|---------|---------|-------------|
| `PORT` | `3577` | server | HTTP server port |
| `DATA_DIR` | `~/.claude-memory/data` | server | SQLite database directory |
| `MODEL_PATH` | `~/.claude-memory/models/nomic-embed-text-v1.5.Q8_0.gguf` | server | Path to GGUF embedding model |
| `AUTH_TOKEN` | *(none)* | server | Bearer token for /mcp auth (disabled if unset) |
| `SCHEDULER_ENABLED` | `true` | server | Set to 'false' to disable cron scheduler |
| `ANTHROPIC_API_KEY` | *(none)* | server | Enables AnthropicApiRunner (falls back to CliRunner) |
| `CRON_SCHEDULE` | `0 2 * * *` | server | node-cron expression for task processing |
| `CLAUDE_MEMORY_URL` | *(none)* | hooks | Server URL (e.g., `https://memory.example.com`) |
| `CLAUDE_MEMORY_TOKEN` | *(none)* | hooks | Auth token for MCP requests from hooks |

### File Locations

| Path | Purpose |
|------|---------|
| `~/.claude.json` | MCP server configuration (URL, headers) |
| `~/.claude/settings.json` | Hook command configuration |
| `~/.claude-memory/data/global.db` | Global memory database |
| `~/.claude-memory/data/projects/{id}/project.db` | Per-project database |
| `~/.claude-memory/models/` | Embedding model files |

### TypeScript Configuration

- Target: ES2022
- Module: Node16 (with Node16 module resolution)
- Strict mode enabled
- ESM only (`"type": "module"` in all package.json files)
- Node >= 22 required

---

## 11. Deployment

### Target Environment

- **Server:** Hetzner CCX13 (8 GB RAM, 2 vCPU, 80 GB SSD)
- **OS:** Linux (systemd)
- **Runtime:** Node.js >= 22 via nvm

### systemd Service

**File:** `deploy/claude-memory.service`

```ini
[Service]
User=claude-memory
WorkingDirectory=/opt/claude-memory/app
ExecStart=/bin/bash -c 'source /opt/claude-memory/.nvm/nvm.sh && exec node packages/server/dist/index.js'
EnvironmentFile=/opt/claude-memory/.env
Restart=on-failure
RestartSec=5
StartLimitBurst=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/claude-memory/data /opt/claude-memory/logs /opt/claude-memory/models

# Resource limits
MemoryMax=4G
CPUQuota=150%
```

### Cloudflare Tunnel

The server runs behind a Cloudflare tunnel for HTTPS termination and DDoS
protection. Setup via `scripts/setup-cloudflare-tunnel.sh`.

### Backup

**File:** `scripts/backup-db.sh`

- Uses `sqlite3 .backup` for safe online backup of each `.db` file
- Creates `tar.gz` archive with timestamp
- Default retention: 30 days
- Configured via cron: `0 3 * * *` (3 AM, after task processing)
- Directories: `DATA_DIR=/opt/claude-memory/data`, `BACKUP_DIR=/opt/claude-memory/backups`

### Directory Layout on Server

```
/opt/claude-memory/
+-- app/                  Git checkout of claude-memory repo
+-- data/                 SQLite databases (global.db + projects/)
+-- models/               GGUF model files
+-- logs/                 Log files
+-- backups/              Database backups
+-- .env                  Environment variables
+-- .nvm/                 Node Version Manager
```

---

## 12. Key Patterns and Conventions

### ESM-Only

The entire codebase uses ES modules. All imports use `.js` extensions
(TypeScript convention for ESM):

```typescript
import { createMemory } from './db/memory-repo.js';
```

### sqlite-vec Loading via createRequire

sqlite-vec is a CommonJS native module. In ESM, it must be loaded via
`createRequire()`:

```typescript
// packages/server/src/db/connection.ts
import { createRequire } from 'node:module';
const esmRequire = createRequire(import.meta.url);

function loadVecExtension(db: Database.Database): void {
  const sqliteVec = esmRequire('sqlite-vec');
  sqliteVec.load(db);
}
```

### Zod for Input Validation

Every MCP tool input is validated by a Zod schema defined in
`packages/shared/src/schemas.ts`. The `.shape` property of the Zod object
is passed directly to `server.tool()` for automatic schema registration:

```typescript
server.tool('memory_store', 'description', memoryStoreSchema.shape, async (input) => { ... });
```

### better-sqlite3 with WAL Mode

WAL (Write-Ahead Logging) is enabled on every connection for better
concurrent read performance:

```typescript
db.pragma('journal_mode = WAL');
```

Foreign keys are enabled during migrations:

```typescript
db.pragma('foreign_keys = ON');
```

### Connection Caching

Database connections are cached in a `Map<string, Database.Database>` to avoid
opening the same file twice. `closeAll()` closes all cached connections during
shutdown.

### pino for Structured Logging

All log messages use pino with named loggers:

```typescript
const log = pino({ name: 'memory-store' });
log.info({ memoryId: memory.id, chunks: chunks.length }, 'Stored memory');
```

### Project ID Derivation

Project identity is deterministic: the same git remote URL always produces
the same 16-character hex ID, regardless of SSH vs HTTPS format:

```
git@github.com:user/repo.git  ->  normalize  ->  SHA-256  ->  first 16 hex chars
https://github.com/user/repo  ->  normalize  ->  SHA-256  ->  same 16 hex chars
```

### Error Handling Philosophy

- **Hooks:** Never fail. Catch everything, exit(0) silently. The 3-second timeout
  is a hard safety net.
- **MCP tools:** Return `{ isError: true }` with error message in content on
  failure. Never crash the server.
- **Database:** Use transactions for multi-table operations. Use RETURNING for
  atomic insert-and-read.

---

## 13. Common Maintenance Tasks

### How to Add a New MCP Tool

1. **Define the schema** in `packages/shared/src/schemas.ts`:
   ```typescript
   export const myNewToolSchema = z.object({
     input1: z.string().min(1),
     input2: z.number().optional(),
   });
   ```

2. **Define the types** in `packages/shared/src/types.ts`:
   ```typescript
   export interface MyNewToolInput { input1: string; input2?: number; }
   export interface MyNewToolOutput { result: string; }
   ```

3. **Export** from `packages/shared/src/index.ts`.

4. **Create the handler** in `packages/server/src/tools/my-new-tool.ts`:
   ```typescript
   import type { ServerContext } from '../server.js';
   import type { MyNewToolInput, MyNewToolOutput } from '@claude-memory/shared';

   export async function handleMyNewTool(
     ctx: ServerContext,
     input: MyNewToolInput,
   ): Promise<MyNewToolOutput> {
     // Implementation here
     return { result: 'done' };
   }
   ```

5. **Export** from `packages/server/src/tools/index.ts`.

6. **Register** in `packages/server/src/server.ts`:
   ```typescript
   server.tool(
     'my_new_tool',
     'Description of what this tool does.',
     myNewToolSchema.shape,
     async (input: MyNewToolInput) => {
       try {
         const result = await handleMyNewTool(ctx, input);
         return {
           content: [{ type: 'text' as const, text: JSON.stringify(result) }],
         };
       } catch (err) {
         const message = err instanceof Error ? err.message : String(err);
         return {
           content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
           isError: true,
         };
       }
     },
   );
   ```

7. **Update the tool count** in the log message at the bottom of `createServer()`.

### How to Add a New Database Migration

1. **Increment** `CURRENT_SCHEMA_VERSION` in `packages/server/src/db/migrations.ts`.

2. **Add the migration function:**
   ```typescript
   function applyV2(db: Database.Database): void {
     db.exec(`
       ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 0;
       CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
     `);
     db.prepare(
       "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')"
     ).run();
   }
   ```

3. **Add the version check** in `runMigrations()`:
   ```typescript
   if (version < 2) {
     applyV2(db);
   }
   ```

4. **Important:** Migrations run on EVERY database open (global + per-project).
   Make sure your DDL uses `IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN`
   (SQLite does not support `IF NOT EXISTS` for ALTER, so the migration system's
   version check prevents re-running).

### How to Modify the Search Algorithm

The search algorithm lives in `packages/server/src/search/hybrid.ts`.

- **Change weights:** Modify `DEFAULT_VECTOR_WEIGHT` and `DEFAULT_FTS_WEIGHT`
  in `packages/shared/src/constants.ts`.
- **Change scoring formula:** Edit the merge loop in `hybridSearch()`.
- **Add a new search signal:** Add a third search path alongside vector and FTS,
  then merge into the `chunkScores` map with a new weight.
- **Change FTS tokenization:** Edit `FTS_SCHEMA` in `migrations.ts` (requires
  a new migration to recreate the table, or rebuild the index).

### How to Add a New Task Type

1. **Add the type** to the enum in `packages/shared/src/schemas.ts`:
   ```typescript
   const taskTypeSchema = z.enum([
     'code-review', 'test-runner', 'doc-updater', 'refactor', 'custom', 'my-new-type'
   ]);
   ```

2. **Update the TypeScript type** in `packages/shared/src/types.ts`:
   ```typescript
   export type TaskType = 'code-review' | 'test-runner' | ... | 'my-new-type';
   ```

3. **Add task-type-specific prompting** in `AnthropicApiRunner.buildUserMessage()` and
   `AnthropicApiRunner.buildSystemPrompt()`:
   ```typescript
   case 'my-new-type':
     parts.push('Specific instructions for this task type.');
     break;
   ```

4. **Update the skills** in `packages/skills/tasks/SKILL.md` to document the
   auto-detection keywords.

### How to Update the Embedding Model

1. **Download the new model** GGUF file to the models directory.

2. **Update constants** in `packages/shared/src/constants.ts`:
   ```typescript
   export const EMBEDDING_MODEL = 'new-model-name';
   export const EMBEDDING_DIMENSIONS = 1024; // if changed
   export const EMBEDDING_MODEL_FILE = 'new-model-name.Q8_0.gguf';
   ```

3. **If dimensions changed:** Update the `VEC_SCHEMA` in `migrations.ts`:
   ```sql
   embedding float[1024]  -- was float[768]
   ```
   This requires a new migration that drops and recreates chunks_vec, then
   re-embeds all existing chunks.

4. **Clear the embedding cache:** The cache keys include model-specific prefixes,
   so old cache entries will produce wrong results. Either:
   - Delete all rows from `embedding_cache`, or
   - Change the cache key derivation to include model name

5. **Update `MODEL_PATH`** env var or default path.

### How to Debug Hooks

1. **Test manually** by piping JSON to the hook:
   ```bash
   echo '{"hook_event_name":"SessionStart","session_id":"test","cwd":"/path/to/project"}' | \
     CLAUDE_MEMORY_URL=http://localhost:3577 \
     CLAUDE_MEMORY_TOKEN=your-token \
     node packages/hooks/dist/cli.js
   ```

2. **Check if server is reachable:**
   ```bash
   curl -H "Authorization: Bearer your-token" http://localhost:3577/health
   ```

3. **Increase timeout for debugging** (temporarily):
   Change `HOOK_TIMEOUT_MS` in `packages/shared/src/constants.ts` to a
   larger value (e.g., 30000).

4. **Add console.error() calls** in the hook code. Stderr does not affect
   Claude Code (only stdout JSON matters for SessionStart).

5. **Check Claude Code hook configuration:**
   ```bash
   cat ~/.claude/settings.json | jq '.hooks'
   ```

6. **Common issues:**
   - `CLAUDE_MEMORY_URL` not set: hook silently exits
   - Server not running: hook times out and exits cleanly
   - Auth token mismatch: hook gets 401, returns null, exits cleanly
   - Hook binary not built: run `pnpm -r build` first
