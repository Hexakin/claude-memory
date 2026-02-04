import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTranscript, summarizeTranscript } from '../lib/transcript-parser.js';
import type { TranscriptMessage } from '../types.js';

describe('transcript-parser', () => {
  let tempDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `transcript-parser-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    testFilePath = join(tempDir, 'transcript.jsonl');
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('parseTranscript', () => {
    it('parses valid JSONL with string content', async () => {
      const jsonl = [
        { role: 'user', content: 'Hello, how are you?' },
        { role: 'assistant', content: 'I am doing well, thank you!' },
        { role: 'user', content: 'Can you help me with a task?' }
      ].map(msg => JSON.stringify(msg)).join('\n');

      await writeFile(testFilePath, jsonl);

      const messages = await parseTranscript(testFilePath);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello, how are you?' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'I am doing well, thank you!' });
      expect(messages[2]).toEqual({ role: 'user', content: 'Can you help me with a task?' });
    });

    it('parses JSONL with array content blocks', async () => {
      const jsonl = [
        { role: 'user', content: [{ type: 'text', text: 'What is the weather?' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'It is sunny today.' }, { type: 'text', text: 'Temperature is 75°F.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Thank you!' }] }
      ].map(msg => JSON.stringify(msg)).join('\n');

      await writeFile(testFilePath, jsonl);

      const messages = await parseTranscript(testFilePath);

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: 'user', content: 'What is the weather?' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'It is sunny today.\nTemperature is 75°F.' });
      expect(messages[2]).toEqual({ role: 'user', content: 'Thank you!' });
    });

    it('returns empty array for non-existent file', async () => {
      const nonExistentPath = join(tempDir, 'does-not-exist.jsonl');
      const messages = await parseTranscript(nonExistentPath);

      expect(messages).toEqual([]);
    });

    it('skips malformed lines (invalid JSON)', async () => {
      const jsonl = [
        JSON.stringify({ role: 'user', content: 'Valid message 1' }),
        'This is not valid JSON',
        JSON.stringify({ role: 'assistant', content: 'Valid message 2' }),
        '{ incomplete json',
        JSON.stringify({ role: 'user', content: 'Valid message 3' })
      ].join('\n');

      await writeFile(testFilePath, jsonl);

      const messages = await parseTranscript(testFilePath);

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('Valid message 1');
      expect(messages[1].content).toBe('Valid message 2');
      expect(messages[2].content).toBe('Valid message 3');
    });

    it('returns empty array for empty file', async () => {
      await writeFile(testFilePath, '');

      const messages = await parseTranscript(testFilePath);

      expect(messages).toEqual([]);
    });

    it('handles mixed content types in same file', async () => {
      const jsonl = [
        { role: 'user', content: 'Plain string content' },
        { role: 'assistant', content: [{ type: 'text', text: 'Array content' }] },
        { role: 'user', content: [{ type: 'text', text: 'More array' }, { type: 'text', text: 'content' }] }
      ].map(msg => JSON.stringify(msg)).join('\n');

      await writeFile(testFilePath, jsonl);

      const messages = await parseTranscript(testFilePath);

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('Plain string content');
      expect(messages[1].content).toBe('Array content');
      expect(messages[2].content).toBe('More array\ncontent');
    });
  });

  describe('summarizeTranscript', () => {
    it('returns empty string if fewer than 3 user messages', async () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Bye' }
      ];

      const summary = summarizeTranscript(messages);

      expect(summary).toBe('');
    });

    it('returns non-empty summary for substantial conversations', async () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'I need help implementing a new authentication system' },
        { role: 'assistant', content: 'I can help with that. What authentication method?' },
        { role: 'user', content: 'JWT tokens with refresh tokens' },
        { role: 'assistant', content: 'Let me create the authentication service' },
        { role: 'user', content: 'Also add rate limiting' },
        { role: 'assistant', content: 'I will add rate limiting middleware' },
        { role: 'user', content: 'Can you write tests for this?' },
        { role: 'assistant', content: 'Yes, I will write comprehensive tests' }
      ];

      const summary = summarizeTranscript(messages);

      expect(summary).not.toBe('');
      expect(summary.length).toBeGreaterThan(0);
    });

    it('detects file mentions in messages', async () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Please update service.ts' },
        { role: 'assistant', content: 'I will update that file' },
        { role: 'user', content: 'Also modify auth.test.ts and database.json' },
        { role: 'assistant', content: 'Done' },
        { role: 'user', content: 'Check utils.js as well' },
        { role: 'assistant', content: 'Checked' }
      ];

      const summary = summarizeTranscript(messages);

      // Summary should mention files in the "Modified files:" section
      expect(summary).toContain('Modified files:');
      expect(summary).toMatch(/service\.ts|auth\.test\.ts|database\.json|utils\.js/);
    });

    it('detects action keywords', async () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Fix the broken authentication bug' },
        { role: 'assistant', content: 'I will fix that' },
        { role: 'user', content: 'Implement rate limiting feature' },
        { role: 'assistant', content: 'Implementing now' },
        { role: 'user', content: 'Test the new endpoints' },
        { role: 'assistant', content: 'Testing' },
        { role: 'user', content: 'Debug the connection issue' },
        { role: 'assistant', content: 'Debugging' }
      ];

      const summary = summarizeTranscript(messages);

      // Check that action keywords are detected
      expect(summary.toLowerCase()).toMatch(/fix|implement|test|debug/);
    });

    it('keeps summary under 2000 chars', async () => {
      const longMessages: TranscriptMessage[] = [];

      for (let i = 0; i < 50; i++) {
        longMessages.push({
          role: 'user',
          content: `This is a very long message number ${i} with lots of details about implementing features, fixing bugs, refactoring code, and testing various components in the system. Let me add more content to make this really long.`
        });
        longMessages.push({
          role: 'assistant',
          content: `I acknowledge message ${i} and will proceed with the implementation of the features you mentioned, including comprehensive testing and documentation.`
        });
      }

      const summary = summarizeTranscript(longMessages);

      expect(summary.length).toBeLessThanOrEqual(2000);
    });

    it('handles maxMessages parameter', async () => {
      const messages: TranscriptMessage[] = [];

      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `Please fix the bug in component-${i}.ts` });
        messages.push({ role: 'assistant', content: `I will implement the fix for component-${i}.ts` });
      }

      const summary = summarizeTranscript(messages, 10);

      // Should only consider last 10 messages
      expect(summary).not.toBe('');
      // Should contain file references from recent messages
      expect(summary).toContain('component-');
    });

    it('returns empty string for conversation with only assistant messages', async () => {
      const messages: TranscriptMessage[] = [
        { role: 'assistant', content: 'Message 1' },
        { role: 'assistant', content: 'Message 2' },
        { role: 'assistant', content: 'Message 3' }
      ];

      const summary = summarizeTranscript(messages);

      expect(summary).toBe('');
    });

    it('handles empty messages array', async () => {
      const summary = summarizeTranscript([]);

      expect(summary).toBe('');
    });
  });
});
