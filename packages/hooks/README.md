# @claude-memory/hooks

Claude Code session hooks for automatic memory injection at session start and session summary storage at session end.

These hooks run as a CLI process invoked by Claude Code's hook system. They read JSON from stdin, communicate with the claude-memory MCP server over HTTP, and write JSON to stdout. A hard 3-second timeout ensures hooks never block the Claude Code experience.

## How It Works

```
Claude Code                              claude-memory-hook
    |                                          |
    |  SessionStart (stdin JSON)               |
    |  { hook_event_name, session_id, cwd }    |
    +----------------------------------------->|
    |                                          |-- detect project (git remote)
    |                                          |-- search project memories (max 5)
    |                                          |-- search global memories (max 3)
    |  { additionalContext: "# Recalled..." }  |
    |<-----------------------------------------+
    |                                          |
    |  SessionEnd (stdin JSON)                 |
    |  { hook_event_name, transcript_path }    |
    +----------------------------------------->|
    |                                          |-- parse JSONL transcript
    |                                          |-- summarize session
    |                                          |-- store summary as memory
    |  (no output)                             |
    |<-----------------------------------------+
```

### SessionStart Handler

When Claude Code starts a new session, the hook:

1. **Detects the project** by walking up from `cwd` to find `.git`, parsing the git config for `remote "origin"` URL, and deriving a deterministic project ID via SHA-256 hash of the normalized URL. Falls back to path-based derivation for non-git directories.

2. **Searches project memories** (up to 5) using the query `"project context, conventions, architecture decisions, and preferences"` scoped to the detected project.

3. **Searches global memories** (up to 3) using the query `"general coding preferences, patterns, and conventions"` with global scope.

4. **Formats and injects context** as a markdown block written to stdout:

```markdown
# Recalled Memories

## Project: my-project
- Always use kebab-case for file names [convention]
- The API uses JWT auth with RS256 [architecture]

## Global
- Prefer explicit error handling over try/catch [preference]
```

If no memories are found, the hook exits silently with no output.

### SessionEnd Handler

When a Claude Code session ends, the hook:

1. **Reads the transcript** from the JSONL file at `transcript_path` (provided by Claude Code). Each line is a JSON object with `role` and `content` fields.

2. **Summarizes the session** by extracting:
   - Actions performed (fixing bugs, implementing features, refactoring, writing tests, debugging, etc.)
   - Topics discussed (API development, UI components, database operations, authentication, deployment)
   - Files modified (detected via extension pattern matching)

3. **Skips short sessions** (fewer than 3 user messages) to avoid storing noise.

4. **Stores the summary** as a memory with source `'session-summary'`, the detected project ID, and tags `['session', 'auto-summary']`.

## Memory Client

The hooks communicate with the MCP server using a lightweight HTTP client that sends MCP JSON-RPC requests directly to the `/mcp` endpoint.

```typescript
// Internal protocol: MCP JSON-RPC over HTTP
POST http://localhost:3577/mcp
Content-Type: application/json
Authorization: Bearer <token>

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "memory_search",
    "arguments": { "query": "...", "scope": "project", "project": "abc123" }
  }
}
```

The client has these properties:
- All network errors are silently swallowed (hooks must never fail visibly)
- Timeout matches `HOOK_TIMEOUT_MS` (3 seconds) from `@claude-memory/shared`
- Returns `null` on any error, and callers handle the empty case gracefully

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_MEMORY_URL` | `http://localhost:3577` | Base URL of the claude-memory server |
| `CLAUDE_MEMORY_TOKEN` | *(none)* | Bearer token for authentication (must match server's `AUTH_TOKEN`) |

If `CLAUDE_MEMORY_URL` is not set, the hook exits immediately with code 0 (disabled mode).

## Installation

### 1. Build the package

```bash
cd packages/hooks
pnpm build    # tsup -> dist/cli.js (ESM)
```

The build produces a single `dist/cli.js` file via tsup.

### 2. Make the CLI available

The package declares a `bin` entry:

```json
{
  "bin": {
    "claude-memory-hook": "dist/cli.js"
  }
}
```

After `pnpm install` at the workspace root, `claude-memory-hook` is linked into `node_modules/.bin/`.

For global availability, you can link it:

```bash
cd packages/hooks
pnpm link --global
```

### 3. Configure Claude Code hooks

Add the hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "CLAUDE_MEMORY_URL=http://localhost:3577 CLAUDE_MEMORY_TOKEN=your-token claude-memory-hook"
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "CLAUDE_MEMORY_URL=http://localhost:3577 CLAUDE_MEMORY_TOKEN=your-token claude-memory-hook"
      }
    ]
  }
}
```

Alternatively, set the environment variables in your shell profile and use a simpler command:

```json
{
  "hooks": {
    "SessionStart": [
      { "type": "command", "command": "claude-memory-hook" }
    ],
    "SessionEnd": [
      { "type": "command", "command": "claude-memory-hook" }
    ]
  }
}
```

### Hook Input Format

Claude Code sends a JSON object on stdin with these fields:

| Field | Type | Presence | Description |
|-------|------|----------|-------------|
| `hook_event_name` | string | always | `'SessionStart'` or `'SessionEnd'` |
| `session_id` | string | always | Unique session identifier |
| `cwd` | string | always | Working directory of the session |
| `transcript_path` | string | SessionEnd only | Path to the JSONL transcript file |
| `permission_mode` | string | optional | Permission mode of the session |
| `source` | string | optional | How the session was started |
| `model` | string | optional | Model being used |
| `reason` | string | SessionEnd only | Why the session ended (`'clear'`, `'logout'`, etc.) |

### Hook Output Format

For SessionStart, the hook may write a JSON object to stdout:

```json
{
  "additionalContext": "# Recalled Memories\n\n## Project: my-project\n- ..."
}
```

The `additionalContext` string is injected into the session as system context. If omitted or empty, nothing is injected.

SessionEnd produces no output.

## Safety Guarantees

- **3-second hard timeout**: The process exits with code 0 after 3 seconds regardless of what is happening. Claude Code is never blocked.
- **Silent failure**: All errors are caught and swallowed. The hook always exits with code 0.
- **No-op without config**: If `CLAUDE_MEMORY_URL` is unset, the hook exits immediately.
- **Graceful degradation**: If the server is unreachable, the memory client returns null/empty results, and the hook exits cleanly.

## Development

```bash
pnpm build        # tsup -> dist/cli.js
pnpm dev          # tsup --watch
pnpm test         # vitest run
pnpm test:watch   # vitest
```
