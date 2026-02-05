#!/usr/bin/env node
/**
 * Local setup script for claude-memory.
 * Configures MCP server, hooks, and verifies connection.
 *
 * Usage: npx tsx scripts/setup-local.ts
 *
 * Cross-platform: works on Windows, macOS, and Linux.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const CLAUDE_JSON_PATH = join(homedir(), '.claude.json');
const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

// ── Helpers ──────────────────────────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function log(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ⚠ ${msg}`);
}

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ── Step 1: Gather Configuration ─────────────────────────────────────────────

async function gatherConfig(): Promise<{ serverUrl: string; authToken: string }> {
  console.log('\n🔧 Claude Memory - Local Setup\n');
  console.log('This script configures your local machine to use the claude-memory server.');
  console.log('You need: (1) server URL, (2) auth token\n');

  const defaultUrl = process.env['CLAUDE_MEMORY_URL'] ?? '';
  const urlPrompt = defaultUrl
    ? `Server URL [${defaultUrl}]: `
    : 'Server URL (e.g., https://memory.yourdomain.com): ';
  let serverUrl = await prompt(urlPrompt);
  if (!serverUrl && defaultUrl) serverUrl = defaultUrl;
  if (!serverUrl) fail('Server URL is required');

  // Normalize: strip trailing slash
  serverUrl = serverUrl.replace(/\/+$/, '');

  const defaultToken = process.env['CLAUDE_MEMORY_TOKEN'] ?? '';
  const tokenPrompt = defaultToken
    ? `Auth token [****${defaultToken.slice(-4)}]: `
    : 'Auth token: ';
  let authToken = await prompt(tokenPrompt);
  if (!authToken && defaultToken) authToken = defaultToken;
  if (!authToken) fail('Auth token is required');

  return { serverUrl, authToken };
}

// ── Step 2: Configure MCP Server ─────────────────────────────────────────────

function configureMcp(serverUrl: string, authToken: string): void {
  console.log('\n📡 Configuring MCP server in ~/.claude.json...');

  const mcpUrl = `${serverUrl}/mcp`;

  // Try using `claude mcp add` CLI first (execFileSync avoids shell injection)
  try {
    execFileSync('claude', [
      'mcp', 'add', '--transport', 'http',
      'claude-memory', mcpUrl,
      '--header', `Authorization: Bearer ${authToken}`,
    ], { stdio: 'pipe' });
    log('MCP server configured via claude CLI');
    return;
  } catch {
    warn('claude CLI not found or failed, configuring manually');
  }

  // Manual fallback: edit ~/.claude.json directly
  const config = readJsonFile(CLAUDE_JSON_PATH) as Record<string, unknown>;
  const mcpServers = (config['mcpServers'] ?? {}) as Record<string, unknown>;

  mcpServers['claude-memory'] = {
    type: 'http',
    url: mcpUrl,
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  };

  config['mcpServers'] = mcpServers;
  writeJsonFile(CLAUDE_JSON_PATH, config);
  log('MCP server configured manually in ~/.claude.json');
}

// ── Step 3: Configure Hooks ──────────────────────────────────────────────────

function configureHooks(): void {
  console.log('\n🪝 Configuring hooks in ~/.claude/settings.json...');

  // Determine the hook CLI path
  const repoRoot = resolve(import.meta.dirname, '..');
  const hookCli = join(repoRoot, 'packages', 'hooks', 'dist', 'cli.js');

  if (!existsSync(hookCli)) {
    warn(`Hook CLI not found at ${hookCli}`);
    warn('Run "pnpm -r build" in the repo first, then re-run this script');
    return;
  }

  // Normalize path for the command (use forward slashes even on Windows for node)
  const normalizedHookCli = hookCli.replace(/\\/g, '/');
  const hookCommand = `node "${normalizedHookCli}"`;

  const settings = readJsonFile(CLAUDE_SETTINGS_PATH) as Record<string, unknown>;
  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>;

  // Configure SessionStart hook
  const sessionStartHooks = (hooks['SessionStart'] ?? []) as Array<Record<string, unknown>>;
  const hasSessionStart = sessionStartHooks.some((entry) => {
    const innerHooks = (entry['hooks'] ?? []) as Array<Record<string, unknown>>;
    return innerHooks.some((h) => String(h['command'] ?? '').includes('claude-memory'));
  });

  if (!hasSessionStart) {
    sessionStartHooks.push({
      hooks: [{ type: 'command', command: hookCommand }],
    });
    hooks['SessionStart'] = sessionStartHooks;
    log('SessionStart hook added');
  } else {
    log('SessionStart hook already configured');
  }

  // Configure SessionEnd hook
  const sessionEndHooks = (hooks['SessionEnd'] ?? []) as Array<Record<string, unknown>>;
  const hasSessionEnd = sessionEndHooks.some((entry) => {
    const innerHooks = (entry['hooks'] ?? []) as Array<Record<string, unknown>>;
    return innerHooks.some((h) => String(h['command'] ?? '').includes('claude-memory'));
  });

  if (!hasSessionEnd) {
    sessionEndHooks.push({
      hooks: [{ type: 'command', command: hookCommand }],
    });
    hooks['SessionEnd'] = sessionEndHooks;
    log('SessionEnd hook added');
  } else {
    log('SessionEnd hook already configured');
  }

  settings['hooks'] = hooks;
  writeJsonFile(CLAUDE_SETTINGS_PATH, settings);
  log('Hooks configured in ~/.claude/settings.json');
}

// ── Step 4: Set Environment Variables ────────────────────────────────────────

function showEnvVars(serverUrl: string, authToken: string): void {
  console.log('\n🔑 Environment variables (add to your shell profile):');
  console.log(`  export CLAUDE_MEMORY_URL="${serverUrl}"`);
  console.log(`  export CLAUDE_MEMORY_TOKEN="${authToken}"`);
}

// ── Step 5: Verify Connection ────────────────────────────────────────────────

async function verifyConnection(serverUrl: string, authToken: string): Promise<void> {
  console.log('\n🔍 Verifying connection to server...');

  try {
    const response = await fetch(`${serverUrl}/health`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      warn(`Health check returned HTTP ${response.status}`);
      return;
    }

    const data = await response.json() as Record<string, unknown>;
    if (data['status'] === 'ok') {
      log(`Server is healthy (vec: ${data['vecAvailable']}, embedding: ${data['embeddingLoaded']})`);
    } else {
      warn('Server responded but status is not ok');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Could not reach server: ${msg}`);
    warn('Setup is complete — the server may not be running yet');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { serverUrl, authToken } = await gatherConfig();

  configureMcp(serverUrl, authToken);
  configureHooks();
  showEnvVars(serverUrl, authToken);
  await verifyConnection(serverUrl, authToken);

  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');
  console.log('  1. Add the environment variables to your shell profile');
  console.log('  2. Start a new Claude Code session to test');
  console.log('  3. Try: /remember this is a test memory');
  console.log('  4. Try: /recall test memory\n');
}

main().catch((err) => {
  console.error('\nSetup failed:', err);
  process.exit(1);
});
