import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// vi.hoisted runs in the hoisted scope so the variable is available to vi.mock
const { tempBase, mockLogDir, mockLogFile, mockLogOld } = vi.hoisted(() => {
  // Must use dynamic import-free path calculation here
  const os = require('node:os');
  const path = require('node:path');
  const base = path.join(os.tmpdir(), `logger-test-${Date.now()}`);
  return {
    tempBase: base,
    mockLogDir: path.join(base, '.claude-memory'),
    mockLogFile: path.join(base, '.claude-memory', 'hooks.log'),
    mockLogOld: path.join(base, '.claude-memory', 'hooks.log.old'),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    homedir: () => tempBase,
  };
});

// Import after mock
import { createHookLogger } from '../lib/logger.js';

describe('logger', () => {
  beforeEach(async () => {
    await mkdir(tempBase, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempBase, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('creates log directory if missing', async () => {
    const log = createHookLogger('test');
    log.info('test message');

    // Directory should exist now - verified by reading the log file
    const content = await readFile(mockLogFile, 'utf-8');
    expect(content).toContain('test message');
  });

  it('writes log entries with correct format', async () => {
    const log = createHookLogger('mycomponent');
    log.info('test message');

    const content = await readFile(mockLogFile, 'utf-8');
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
    expect(content).toContain('[INFO]');
    expect(content).toContain('[mycomponent]');
    expect(content).toContain('test message');
  });

  it('writes all log levels', async () => {
    const log = createHookLogger('test');
    log.error('error msg');
    log.warn('warn msg');
    log.info('info msg');
    log.debug('debug msg');

    const content = await readFile(mockLogFile, 'utf-8');
    expect(content).toContain('[ERROR]');
    expect(content).toContain('[WARN]');
    expect(content).toContain('[INFO]');
    expect(content).toContain('[DEBUG]');
  });

  it('includes context as JSON', async () => {
    const log = createHookLogger('test');
    log.info('with context', { key: 'value', num: 42 });

    const content = await readFile(mockLogFile, 'utf-8');
    expect(content).toContain('{"key":"value","num":42}');
  });

  it('never throws on any operation', () => {
    const log = createHookLogger('test');
    // These should not throw even in edge cases
    expect(() => log.error('msg')).not.toThrow();
    expect(() => log.warn('msg')).not.toThrow();
    expect(() => log.info('msg')).not.toThrow();
    expect(() => log.debug('msg')).not.toThrow();
    expect(() => log.info('msg', { complex: { nested: 'value' } })).not.toThrow();
  });

  it('rotates log file when over 1MB', async () => {
    // Create a log file just over 1MB
    await mkdir(mockLogDir, { recursive: true });
    const bigContent = 'x'.repeat(1024 * 1024 + 100);
    await writeFile(mockLogFile, bigContent);

    const log = createHookLogger('test');
    log.info('after rotation');

    // Old file should exist
    const oldStats = await stat(mockLogOld);
    expect(oldStats.size).toBeGreaterThan(1024 * 1024);

    // New log file should be small (just the new entry)
    const newContent = await readFile(mockLogFile, 'utf-8');
    expect(newContent).toContain('after rotation');
    expect(newContent.length).toBeLessThan(1000);
  });
});
