# claude-memory

Persistent memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). An MCP server with hybrid vector + keyword search, session hooks for automatic context injection, and overnight task automation.

Claude Code sessions are ephemeral by default. `claude-memory` gives Claude a long-term memory layer so it can recall project conventions, past decisions, and learned patterns across sessions without manual prompting.

## Features

- **10 MCP tools** exposed over Streamable HTTP transport (`memory_store`, `memory_search`, `memory_get`, `memory_list`, `memory_delete`, `memory_cleanup`, `task_add`, `task_list`, `task_results`, `task_cancel`)
- **Hybrid search** combining sqlite-vec vector similarity (768-dim, nomic-embed-text-v1.5) and FTS5 full-text search with configurable weighting
- **Session hooks** that automatically inject relevant memories at session start and store session summaries at session end
- **Overnight automation** via a cron scheduler that processes queued tasks using the Anthropic API or the Claude CLI
- **Per-project scoping** with automatic project ID derivation from git remote URLs
- **Embedding cache** backed by SQLite to avoid redundant model inference
- **Markdown-aware chunking** that respects code block boundaries
- **Skills** for Claude Code (remember, recall, tasks, morning-report)
- **Bearer token auth** for securing the HTTP endpoint

## Quick Start

### Prerequisites

- Node.js >= 22
- pnpm >= 9
- A local GGUF embedding model (downloaded automatically by the setup script)

### Installation

```bash
git clone https://github.com/user/claude-memory.git
cd claude-memory
pnpm install
pnpm -r build
```

### Download the embedding model

```bash
bash scripts/download-model.sh
```

This places `nomic-embed-text-v1.5.Q8_0.gguf` into `~/.claude-memory/models/`.

### Start the server

```bash
pnpm dev
# or
pnpm --filter @claude-memory/server start
```

The server listens on `http://localhost:3577` by default.

### Configure Claude Code

Add the MCP server to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "claude-memory": {
      "type": "url",
      "url": "http://localhost:3577/mcp"
    }
  }
}
```

Configure session hooks for automatic memory injection and storage:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "claude-memory-hook"
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "claude-memory-hook"
      }
    ]
  }
}
```

Set the hook environment variables:

```bash
export CLAUDE_MEMORY_URL=http://localhost:3577
export CLAUDE_MEMORY_TOKEN=your-secret-token  # optional, must match AUTH_TOKEN
```

## Architecture

```
                  Claude Code
                 /           \
          SessionStart     SessionEnd
          hook (inject)    hook (store)
                \           /
                 v         v
            +-----------------+
            |  MCP Server     |  Express + Streamable HTTP
            |  (port 3577)    |
            +--------+--------+
                     |
        +------------+------------+
        |            |            |
   SQLite DB    sqlite-vec    node-llama-cpp
   (FTS5)      (vec0 768d)   (nomic-embed)
        |            |            |
        +------------+------------+
                     |
              Cron Scheduler
              (2 AM daily)
                     |
            Anthropic API / CLI
```

The server stores memories in SQLite with two search indexes: a `vec0` virtual table for vector similarity search (via sqlite-vec) and an `fts5` virtual table for keyword search. Both are queried in parallel and their scores are merged with configurable weights (default: 70% vector, 30% FTS).

When sqlite-vec is not available (e.g., unsupported platform), the server falls back to a brute-force JavaScript cosine similarity search over cached embeddings.

See [packages/server/README.md](packages/server/README.md) for detailed architecture documentation.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3577` | HTTP server listen port |
| `DATA_DIR` | `~/.claude-memory/data` | Directory for SQLite databases |
| `MODEL_PATH` | `~/.claude-memory/models/nomic-embed-text-v1.5.Q8_0.gguf` | Path to the GGUF embedding model |
| `AUTH_TOKEN` | *(none)* | Bearer token for authenticating MCP requests |
| `SCHEDULER_ENABLED` | `true` | Enable/disable the cron task scheduler |
| `CRON_SCHEDULE` | `0 2 * * *` | Cron expression for the task runner (default: 2 AM daily) |
| `ANTHROPIC_API_KEY` | *(none)* | Anthropic API key for overnight tasks (falls back to CLI runner) |
| `CLAUDE_MEMORY_URL` | `http://localhost:3577` | Server URL used by session hooks |
| `CLAUDE_MEMORY_TOKEN` | *(none)* | Auth token used by session hooks |

## Project Structure

```
claude-memory/
  package.json              # Root workspace config
  pnpm-workspace.yaml       # pnpm workspace definition
  tsconfig.base.json        # Shared TypeScript config
  vitest.workspace.ts       # Vitest workspace config
  packages/
    shared/                 # @claude-memory/shared
      src/
        types.ts            # Core interfaces (Memory, Task, SearchResult, I/O types)
        schemas.ts          # Zod validation schemas for all 10 tools
        constants.ts        # Ports, model config, timeouts, search weights
        project-id.ts       # Git URL normalization and project ID derivation
    server/                 # @claude-memory/server
      src/
        index.ts            # Express server setup, transport management, health endpoint
        server.ts           # MCP server creation with 10 tool registrations
        db/                 # SQLite database layer
          connection.ts     # Connection pooling, WAL mode, sqlite-vec loading
          migrations.ts     # Forward-only schema migrations
          memory-repo.ts    # Memory CRUD operations
          chunk-repo.ts     # Chunk + vector storage and search
          tag-repo.ts       # Tag management
          task-repo.ts      # Task queue operations
        embedding/          # Embedding pipeline
          embedder.ts       # node-llama-cpp embedder with lazy loading
          cache.ts          # SQLite-backed embedding cache
          chunker.ts        # Markdown-aware text chunking
          fallback.ts       # JS cosine similarity fallback
        search/             # Search layer
          hybrid.ts         # Hybrid vector + FTS search with score merging
        tools/              # MCP tool handlers
          memory-store.ts   # Store with chunking + embedding
          memory-search.ts  # Hybrid search
          memory-get.ts     # Get by ID
          memory-list.ts    # List with filters
          memory-delete.ts  # Delete with cascade
          task-add.ts       # Add to overnight queue
          task-list.ts      # List tasks
          task-results.ts   # Get task results
          task-cancel.ts    # Cancel pending task
        cron/               # Overnight automation
          scheduler.ts      # node-cron scheduler with retry logic
          runner.ts         # TaskRunner interface
          api-runner.ts     # Anthropic API task runner
          cli-runner.ts     # Claude CLI task runner
          codebase-access.ts # Git clone for task context
    hooks/                  # @claude-memory/hooks
      src/
        cli.ts              # CLI entry point (reads stdin, dispatches to handlers)
        types.ts            # Hook I/O types
        handlers/
          session-start.ts  # Memory search + context injection
          session-end.ts    # Transcript parsing + summary storage
        lib/
          memory-client.ts  # MCP JSON-RPC client over HTTP
          project-detect.ts # Git remote detection + project ID
          transcript-parser.ts # JSONL transcript parsing + summarization
    skills/                 # Claude Code custom skills
      morning-report/       # Daily summary of overnight task results
      recall/               # Search and retrieve memories
      remember/             # Store new memories
      tasks/                # Manage overnight task queue
  scripts/
    download-model.sh       # Download the GGUF embedding model
    setup-local.ts          # Local development setup
    setup-server.sh         # Server provisioning
    deploy.sh               # Deployment script
    backup-db.sh            # Database backup
    setup-cloudflare-tunnel.sh # Cloudflare tunnel for remote access
  deploy/                   # Deployment configuration
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type-check without emitting
pnpm lint

# Start server in dev mode (with --watch)
pnpm dev
```

### Adding a new MCP tool

1. Define input/output types in `packages/shared/src/types.ts`
2. Add a Zod schema in `packages/shared/src/schemas.ts`
3. Create a handler in `packages/server/src/tools/`
4. Export from `packages/server/src/tools/index.ts`
5. Register the tool in `packages/server/src/server.ts`

## License

MIT
