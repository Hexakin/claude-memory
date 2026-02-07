import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LOG_DIR = join(homedir(), '.claude-memory');
const LOG_FILE = join(LOG_DIR, 'hooks.log');
const LOG_OLD = join(LOG_DIR, 'hooks.log.old');
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface HookLogger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Cannot create directory — logging will be silently skipped
  }
}

function rotateIfNeeded(): void {
  try {
    const stats = statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      try {
        renameSync(LOG_FILE, LOG_OLD);
      } catch {
        // If rename fails, truncate instead
        writeFileSync(LOG_FILE, '');
      }
    }
  } catch {
    // File doesn't exist yet or can't stat — nothing to rotate
  }
}

function writeLine(level: LogLevel, component: string, message: string, context?: Record<string, unknown>): void {
  try {
    ensureLogDir();
    rotateIfNeeded();

    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}${contextStr}\n`;

    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // Never throw from logger — silently skip if filesystem fails
  }
}

/**
 * Create a logger for a specific hook component.
 * Logs are written to ~/.claude-memory/hooks.log.
 * Auto-creates directory, rotates at 1MB, never throws.
 */
export function createHookLogger(component: string): HookLogger {
  return {
    error: (message, context) => writeLine('error', component, message, context),
    warn: (message, context) => writeLine('warn', component, message, context),
    info: (message, context) => writeLine('info', component, message, context),
    debug: (message, context) => writeLine('debug', component, message, context),
  };
}
