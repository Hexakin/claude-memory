import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DEFAULT_PORT, EMBEDDING_MODEL_FILE } from '@claude-memory/shared';
import { getGlobalDb, isVecAvailable, closeAll } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { createEmbedder } from './embedding/embedder.js';
import { createEmbeddingCache } from './embedding/cache.js';
import { createServer } from './server.js';
import { CronScheduler } from './cron/scheduler.js';
import { AnthropicApiRunner } from './cron/api-runner.js';
import { CliRunner } from './cron/cli-runner.js';
import pino from 'pino';

const log = pino({ name: 'claude-memory' });

async function main(): Promise<void> {
  // Read configuration from environment
  const port = parseInt(process.env['PORT'] ?? String(DEFAULT_PORT), 10);
  const dataDir = process.env['DATA_DIR'] ?? join(homedir(), '.claude-memory', 'data');
  const modelPath =
    process.env['MODEL_PATH'] ?? join(homedir(), '.claude-memory', 'models', EMBEDDING_MODEL_FILE);
  const authToken = process.env['AUTH_TOKEN'] ?? undefined;

  // Ensure data directory exists
  mkdirSync(dataDir, { recursive: true });

  log.info({ dataDir, modelPath, port }, 'Starting Claude Memory Server');

  // Initialize global database
  const globalDb = getGlobalDb(dataDir);
  const vecAvailable = isVecAvailable();
  runMigrations(globalDb, vecAvailable);

  log.info({ vecAvailable }, 'Database initialized');

  // Create embedder
  const embedder = await createEmbedder(modelPath);
  log.info('Embedder created (lazy-loading model on first use)');

  // Create embedding cache
  const embeddingCache = createEmbeddingCache(globalDb);
  log.info('Embedding cache initialized');

  // Create MCP server
  const mcpServer = createServer({
    globalDb,
    embedder,
    embeddingCache,
    vecAvailable,
    dataDir,
  });

  // Initialize task scheduler (if enabled)
  let scheduler: CronScheduler | null = null;
  const schedulerEnabled = process.env['SCHEDULER_ENABLED'] !== 'false';
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];

  if (schedulerEnabled) {
    const runner = anthropicApiKey
      ? new AnthropicApiRunner({ apiKey: anthropicApiKey })
      : new CliRunner();

    scheduler = new CronScheduler({
      db: globalDb,
      runner,
      cronSchedule: process.env['CRON_SCHEDULE'] ?? undefined,
      enabled: true,
    });

    scheduler.start();
    log.info({ runner: runner.name, schedule: process.env['CRON_SCHEDULE'] ?? '0 2 * * * (default)' }, 'Task scheduler started');
  } else {
    log.info('Task scheduler disabled');
  }

  // Set up Express HTTP server
  const app = express();
  app.use(express.json());

  // Auth middleware (only if AUTH_TOKEN is set)
  if (authToken) {
    app.use('/mcp', (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token !== authToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
    log.info('Auth middleware enabled');
  }

  // Store transports by session ID for stateful sessions
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // MCP endpoint — POST (main request handling)
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // Reuse existing transport for the session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Create new session transport
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          log.debug({ sessionId: sid }, 'Session closed');
        }
      };

      await mcpServer.connect(transport);

      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
        log.debug({ sessionId: transport.sessionId }, 'New session created');
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error({ err }, 'Error handling MCP POST request');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // MCP endpoint — GET (SSE for server-initiated messages)
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'No active session. Send a POST request first.' });
      return;
    }

    try {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
    } catch (err) {
      log.error({ err }, 'Error handling MCP GET request');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // MCP endpoint — DELETE (session cleanup)
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      try {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
        log.info({ sessionId }, 'Session explicitly closed');
      } catch (err) {
        log.error({ err, sessionId }, 'Error closing session');
      }
    }
    res.status(200).json({ ok: true });
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      vecAvailable,
      embeddingLoaded: embedder.isLoaded(),
      sessions: transports.size,
      cacheStats: embeddingCache.stats(),
      scheduler: scheduler ? {
        enabled: true,
        running: scheduler.isRunning(),
        stats: scheduler.getStats(),
      } : { enabled: false },
    });
  });

  // Start server
  const server = app.listen(port, () => {
    log.info({ port }, 'Claude Memory Server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'Shutting down');

    // Stop scheduler
    if (scheduler) {
      scheduler.stop();
      log.info('Scheduler stopped');
    }

    // Close all session transports
    for (const [sid, transport] of transports) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors during shutdown
      }
      transports.delete(sid);
    }

    // Close HTTP server
    server.close();

    // Dispose embedder
    try {
      await embedder.dispose();
    } catch {
      // Ignore dispose errors during shutdown
    }

    // Close all database connections
    closeAll();

    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
