# Contributing to Claude Memory

Thank you for your interest in contributing to Claude Memory! This guide is designed for both human developers and future Claude instances working on this codebase.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Adding New Features](#adding-new-features)
- [Testing](#testing)
- [Code Style](#code-style)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

## Development Setup

### Prerequisites

- Node.js >= 22
- pnpm (package manager)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/yourusername/claude-memory.git
cd claude-memory

# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Run tests
pnpm test

# Run development server
pnpm dev
```

## Project Structure

Claude Memory is organized as a monorepo using pnpm workspaces:

```
packages/
├── shared/       # Shared types, schemas, and utilities
├── server/       # MCP server implementation with SQLite database
├── hooks/        # Claude Code lifecycle hooks
└── skills/       # Reusable Claude skills
```

### Key Technologies

- **TypeScript** with ESM-only modules and project references
- **pnpm workspaces** for monorepo management
- **Vitest** for testing
- **better-sqlite3** for database
- **Zod** for runtime validation
- **pino** for logging

## Adding New Features

### Adding a New MCP Tool

MCP tools are the primary interface for Claude to interact with the memory system.

1. **Define types** in `packages/shared/src/types.ts`:
   ```typescript
   export interface MyToolInput {
     someField: string;
   }

   export interface MyToolOutput {
     result: string;
   }
   ```

2. **Add Zod schema** in `packages/shared/src/schemas.ts`:
   ```typescript
   export const myToolInputSchema = z.object({
     someField: z.string(),
   });
   ```

3. **Export from shared package** in `packages/shared/src/index.ts`:
   ```typescript
   export { myToolInputSchema } from './schemas.js';
   export type { MyToolInput, MyToolOutput } from './types.js';
   ```

4. **Create handler** in `packages/server/src/tools/my-tool.ts`:
   ```typescript
   import type { MyToolInput, MyToolOutput } from '@claude-memory/shared';
   import type { Database } from 'better-sqlite3';

   export function handleMyTool(db: Database, input: MyToolInput): MyToolOutput {
     // Implementation
     return { result: 'success' };
   }
   ```

5. **Export handler** from `packages/server/src/tools/index.ts`:
   ```typescript
   export { handleMyTool } from './my-tool.js';
   ```

6. **Register in server** in `packages/server/src/server.ts`:
   ```typescript
   import { myToolInputSchema } from '@claude-memory/shared';
   import { handleMyTool } from './tools/index.js';

   server.tool(
     'my-tool',
     'Description of what this tool does',
     myToolInputSchema,
     async (input) => {
       const result = handleMyTool(db, input);
       return { content: [{ type: 'text', text: JSON.stringify(result) }] };
     }
   );
   ```

7. **Add tests** in `packages/server/src/__tests__/my-tool.test.ts`:
   ```typescript
   import { describe, it, expect, beforeEach } from 'vitest';
   import Database from 'better-sqlite3';
   import { handleMyTool } from '../tools/my-tool.js';

   describe('handleMyTool', () => {
     let db: Database.Database;

     beforeEach(() => {
       db = new Database(':memory:');
       // Setup test data
     });

     it('should do something', () => {
       const result = handleMyTool(db, { someField: 'test' });
       expect(result.result).toBe('success');
     });
   });
   ```

### Adding a Database Migration

The database schema is versioned and migrations are applied automatically on startup.

1. **Increment version** in `packages/server/src/db/migrations.ts`:
   ```typescript
   const CURRENT_SCHEMA_VERSION = 4; // Increment from 3 to 4
   ```

2. **Add migration block**:
   ```typescript
   export function runMigrations(db: Database): void {
     // ... existing migrations ...

     if (version < 4) {
       logger.info('Migrating to version 4: Add new column');
       db.exec(`
         ALTER TABLE memories
         ADD COLUMN new_field TEXT DEFAULT NULL;
       `);
       setVersion(db, 4);
     }
   }
   ```

3. **Test migration**:
   - Test on a fresh database (should run all migrations)
   - Test on an existing database (should only run new migration)
   - Verify no data loss

### Adding a New Hook Event

Hooks allow Claude Memory to respond to Claude Code lifecycle events.

1. **Add case** in `packages/hooks/src/cli.ts`:
   ```typescript
   switch (event) {
     case 'existing-event':
       // ... existing handlers ...
       break;
     case 'new-event':
       await handleNewEvent();
       break;
   }
   ```

2. **Create handler** in `packages/hooks/src/handlers/new-event.ts`:
   ```typescript
   import { sendMcpRequest } from '../mcp-client.js';

   export async function handleNewEvent(): Promise<void> {
     // Implementation
     await sendMcpRequest('some-tool', { data: 'value' });
   }
   ```

3. **Add tests** in `packages/hooks/src/__tests__/new-event.test.ts`:
   ```typescript
   import { describe, it, expect, vi } from 'vitest';
   import { handleNewEvent } from '../handlers/new-event.js';

   vi.mock('../mcp-client.js', () => ({
     sendMcpRequest: vi.fn(),
   }));

   describe('handleNewEvent', () => {
     it('should call the correct MCP tool', async () => {
       await handleNewEvent();
       // Assertions
     });
   });
   ```

### Adding a New Skill

Skills are reusable Claude capabilities that can be loaded on demand.

1. **Create skill directory**:
   ```bash
   mkdir -p packages/skills/my-skill
   ```

2. **Write SKILL.md** with frontmatter:
   ```markdown
   ---
   name: my-skill
   description: Brief description of what this skill does
   version: 1.0.0
   author: Your Name
   ---

   # My Skill

   ## Purpose
   This skill helps Claude to...

   ## Available MCP Tools
   - `tool-name`: Description of when to use it

   ## Instructions
   When activated, you should:
   1. First step
   2. Second step
   ```

3. **Add to package exports** if needed

### Adding a New Task Type

Task types determine how scheduled tasks execute.

1. **Add to type union** in `packages/shared/src/types.ts`:
   ```typescript
   export type TaskType =
     | 'check-todos'
     | 'check-reminders'
     | 'new-task-type';
   ```

2. **Add to schema** in `packages/shared/src/schemas.ts`:
   ```typescript
   export const taskTypeSchema = z.enum([
     'check-todos',
     'check-reminders',
     'new-task-type',
   ]);
   ```

3. **Add handler case** in `packages/server/src/cron/api-runner.ts`:
   ```typescript
   function buildUserMessage(task: Task): string {
     switch (task.type) {
       case 'new-task-type':
         return 'Prompt for Claude about this task';
       // ... other cases ...
     }
   }
   ```

## Testing

### Test Framework

Claude Memory uses **Vitest** with global test APIs enabled.

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @claude-memory/server test

# Run tests in watch mode
pnpm test --watch

# Run tests with coverage
pnpm test --coverage
```

### Test Organization

- Test files: `src/__tests__/*.test.ts`
- Configuration: `vitest.config.ts` in each package
- Total test count: 202 tests
  - shared: 21 tests
  - server: 134 tests
  - hooks: 47 tests

### Testing Patterns

**Mocking external dependencies:**
```typescript
vi.mock('better-sqlite3', () => ({
  default: vi.fn(() => ({
    exec: vi.fn(),
    prepare: vi.fn(),
  })),
}));
```

**Testing database operations:**
```typescript
import Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Run migrations
  runMigrations(db);
});

afterEach(() => {
  db.close();
});
```

**Testing API calls:**
```typescript
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'response' }],
      }),
    },
  })),
}));
```

## Code Style

### Import Conventions

- Use **ESM imports** with `.js` extensions (required for TypeScript ESM)
  ```typescript
  import { something } from './module.js'; // ✅
  import { something } from './module';     // ❌
  ```

- Use **type-only imports** when possible
  ```typescript
  import type { MyType } from './types.js';
  ```

### Validation

- Use **Zod** for all input validation
- Define schemas in `packages/shared/src/schemas.ts`
- Validate at API boundaries

### Logging

- Use **pino** for structured logging
- Include context in log messages
- Use appropriate log levels (debug, info, warn, error)

### Security

- Use **better-sqlite3** with parameterized queries (prevents SQL injection)
  ```typescript
  // ✅ Safe
  db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  // ❌ Unsafe
  db.exec(`SELECT * FROM users WHERE id = ${userId}`);
  ```

- Use **execFile/execFileSync** for subprocess calls (prevents shell injection)
  ```typescript
  import { execFileSync } from 'child_process';

  // ✅ Safe
  execFileSync('command', ['arg1', 'arg2']);

  // ❌ Unsafe - DO NOT USE
  execSync(`command ${arg1} ${arg2}`);
  ```

- This codebase provides `execFileNoThrow` utility in `src/utils/execFileNoThrow.ts` for safer subprocess execution with proper error handling and Windows compatibility.

### TypeScript

- Enable strict mode
- Use explicit return types for public functions
- Avoid `any` type (use `unknown` if necessary)

## Deployment

### Building for Production

```bash
# Build all packages
pnpm -r build

# Verify builds
ls packages/*/dist/
```

### Deployment Script

The project includes a deployment script at `scripts/deploy.sh`:

```bash
./scripts/deploy.sh
```

This script:
- Builds all packages
- Copies files to deployment location
- Downloads the embedding model if needed
- Restarts the systemd service

### Server Configuration

The server runs as a systemd service. Configuration:
- Service file: `/etc/systemd/system/claude-memory.service`
- Working directory: `/opt/claude-memory/`
- Environment variables in service file or `.env`

### Required Files

- **Embedding model**: `nomic-embed-text-v1.5.Q8_0.gguf`
  - Download with `scripts/download-model.sh`
  - Place in project root or specify path with `MODEL_PATH` env var

## Troubleshooting

### sqlite-vec Not Loading

**Symptom:** Warnings about sqlite-vec extension not loading

**Causes:**
- Native module compatibility issues with Node.js version
- Missing sqlite-vec binary for platform

**Solution:**
- System falls back to FTS-only search automatically
- For vector search, ensure sqlite-vec binary matches Node.js version
- Check logs for specific error messages

### Model Not Found

**Symptom:** Error about missing embedding model

**Solution:**
```bash
./scripts/download-model.sh
```

Or manually download and place `nomic-embed-text-v1.5.Q8_0.gguf` in project root.

### Hooks Not Firing

**Symptom:** Claude Memory not receiving lifecycle events

**Causes:**
- Hook command not configured in Claude Code settings
- Hook script not executable

**Solution:**
1. Check `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "command": "/path/to/claude-memory/packages/hooks/dist/cli.js"
     }
   }
   ```
2. Ensure hook script is executable:
   ```bash
   chmod +x packages/hooks/dist/cli.js
   ```

### Tests Running From dist/

**Symptom:** Tests import compiled code instead of source

**Solution:**
- Ensure `tsconfig.json` excludes `__tests__/`
- Ensure `vitest.config.ts` includes `src/**/*.test.ts` only
- Clean dist directory: `rm -rf dist/`

### Auth Failures

**Symptom:** 401 Unauthorized when calling MCP tools

**Solution:**
- Check `AUTH_TOKEN` environment variable is set
- Ensure Bearer token in requests matches `AUTH_TOKEN`
- Verify token is passed in Authorization header: `Bearer <token>`

### Port Already in Use

**Symptom:** Server fails to start with EADDRINUSE error

**Solution:**
```bash
# Find process using port 3577
lsof -i :3577

# Kill process
kill -9 <PID>

# Or use different port
PORT=3001 pnpm dev
```

## Questions?

If you encounter issues not covered here:
1. Check existing GitHub issues
2. Review the code documentation
3. Open a new issue with detailed information

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
