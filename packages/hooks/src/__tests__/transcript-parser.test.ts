import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTranscript, summarizeTranscript, extractKnowledge, formatKnowledgeForStorage } from '../lib/transcript-parser.js';
import type { ExtractedKnowledge } from '../lib/transcript-parser.js';
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

    it('captures tool_use blocks', async () => {
      const jsonl = [
        { role: 'assistant', content: [
          { type: 'text', text: 'I will edit the file.' },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/index.ts' } },
        ]},
      ].map(msg => JSON.stringify(msg)).join('\n');

      await writeFile(testFilePath, jsonl);

      const messages = await parseTranscript(testFilePath);

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('I will edit the file.');
      expect(messages[0].toolUse).toBeDefined();
      expect(messages[0].toolUse).toHaveLength(1);
      expect(messages[0].toolUse![0].name).toBe('Edit');
      expect(messages[0].toolUse![0].input['file_path']).toBe('/src/index.ts');
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

  describe('extractKnowledge', () => {
    it('returns null for fewer than 3 user messages', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Hello there' },
        { role: 'assistant', content: 'Hi!' },
        { role: 'user', content: 'Goodbye' },
      ];

      expect(extractKnowledge(messages)).toBeNull();
    });

    it('returns null for trivial sessions with no extractable knowledge', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Can you help me?' },
        { role: 'assistant', content: 'Sure, what do you need?' },
        { role: 'user', content: 'Never mind, I figured it out' },
        { role: 'assistant', content: 'Great!' },
        { role: 'user', content: 'Thanks anyway' },
      ];

      expect(extractKnowledge(messages)).toBeNull();
    });

    it('extracts decisions from transcript', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'What auth library should we use?' },
        { role: 'assistant', content: 'I recommend passport.js. Let us go with passport.js for authentication because it has great middleware support.' },
        { role: 'user', content: 'Sounds good. What about the database?' },
        { role: 'assistant', content: 'We decided to use PostgreSQL with Prisma ORM for the database layer.' },
        { role: 'user', content: 'And for testing?' },
        { role: 'assistant', content: 'Going with vitest for testing since it has great TypeScript support. The trick is to configure it with the pool option.' },
      ];

      const knowledge = extractKnowledge(messages);

      expect(knowledge).not.toBeNull();
      expect(knowledge!.decisions.length).toBeGreaterThan(0);
    });

    it('extracts learnings from transcript', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Why is the build failing?' },
        { role: 'assistant', content: 'It turns out the issue was with the tsconfig paths not being resolved correctly.' },
        { role: 'user', content: 'How did you fix it?' },
        { role: 'assistant', content: 'Important: you need to add the baseUrl setting. The trick is to use composite: true in the root tsconfig.' },
        { role: 'user', content: 'Any other gotchas?' },
        { role: 'assistant', content: 'Note: ESM modules require .js extensions in import paths even for .ts files.' },
      ];

      const knowledge = extractKnowledge(messages);

      expect(knowledge).not.toBeNull();
      expect(knowledge!.learnings.length).toBeGreaterThan(0);
    });

    it('extracts problems solved from transcript', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'The server keeps crashing' },
        { role: 'assistant', content: 'The error was: connection pool exhausted. Fixed by increasing max connections to 20.' },
        { role: 'user', content: 'What about the memory leak?' },
        { role: 'assistant', content: 'The solution was to properly close database connections in the finally block. Turns out the connection was never being released.' },
        { role: 'user', content: 'Great, anything else?' },
        { role: 'assistant', content: 'Also resolved by adding proper error handling to the middleware chain.' },
      ];

      const knowledge = extractKnowledge(messages);

      expect(knowledge).not.toBeNull();
      expect(knowledge!.problemsSolved.length).toBeGreaterThan(0);
    });

    it('extracts files from tool_use blocks', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Please update the auth module' },
        { role: 'assistant', content: 'I will update the files now.', toolUse: [
          { name: 'Edit', input: { file_path: '/project/src/auth.ts' } },
          { name: 'Write', input: { file_path: '/project/src/middleware.ts' } },
        ]},
        { role: 'user', content: 'Looks good, also the tests' },
        { role: 'assistant', content: 'Updating tests. Turns out the mock setup was wrong, needed to reset between tests.', toolUse: [
          { name: 'Edit', input: { file_path: '/project/src/__tests__/auth.test.ts' } },
        ]},
        { role: 'user', content: 'Perfect. Let us go with this approach for all the auth modules.' },
      ];

      const knowledge = extractKnowledge(messages);

      expect(knowledge).not.toBeNull();
      expect(knowledge!.filesModified).toContain('auth.ts');
      expect(knowledge!.filesModified).toContain('middleware.ts');
      expect(knowledge!.filesModified).toContain('auth.test.ts');
    });

    it('extracts commands from Bash tool_use blocks', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Run the tests please' },
        { role: 'assistant', content: 'Running tests now. Turns out the test runner needs the --passWithNoTests flag.', toolUse: [
          { name: 'Bash', input: { command: 'npm test -- --passWithNoTests' } },
        ]},
        { role: 'user', content: 'Now deploy it' },
        { role: 'assistant', content: 'Deploying. The fix is to use the production flag.', toolUse: [
          { name: 'Bash', input: { command: 'npm run deploy --production' } },
        ]},
        { role: 'user', content: 'Check the logs too' },
      ];

      const knowledge = extractKnowledge(messages);

      expect(knowledge).not.toBeNull();
      expect(knowledge!.commands.length).toBeGreaterThan(0);
      expect(knowledge!.commands).toContain('npm test -- --passWithNoTests');
    });

    it('derives topic from first user messages', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: 'Help me refactor the payment processing module' },
        { role: 'assistant', content: 'Sure. Going with the strategy pattern for payment processors since it allows easy extension.' },
        { role: 'user', content: 'Use Stripe as the default' },
        { role: 'assistant', content: 'Decided to use Stripe SDK v12 for the integration.' },
        { role: 'user', content: 'Add error handling too' },
      ];

      const knowledge = extractKnowledge(messages);

      expect(knowledge).not.toBeNull();
      expect(knowledge!.topic).toContain('refactor');
      expect(knowledge!.topic).toContain('payment');
    });

    it('caps items at 5 per category', () => {
      const messages: TranscriptMessage[] = [];
      // Generate many decisions
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `What about feature ${i}?` });
        messages.push({ role: 'assistant', content: `Going with approach-${i} for feature ${i} because it is better.` });
      }

      const knowledge = extractKnowledge(messages);

      if (knowledge) {
        expect(knowledge.decisions.length).toBeLessThanOrEqual(5);
        expect(knowledge.learnings.length).toBeLessThanOrEqual(5);
        expect(knowledge.problemsSolved.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('formatKnowledgeForStorage', () => {
    it('formats knowledge as structured markdown', () => {
      const knowledge: ExtractedKnowledge = {
        topic: 'Building auth system',
        decisions: ['Use JWT tokens'],
        learnings: ['Token expiry should be 15 minutes'],
        problemsSolved: ['Fixed by adding issuer validation'],
        filesModified: ['auth.ts', 'middleware.ts'],
        commands: ['npm test'],
      };

      const formatted = formatKnowledgeForStorage(knowledge);

      expect(formatted).toContain('## Session: Building auth system');
      expect(formatted).toContain('### Decisions');
      expect(formatted).toContain('- Use JWT tokens');
      expect(formatted).toContain('### Learnings');
      expect(formatted).toContain('- Token expiry should be 15 minutes');
      expect(formatted).toContain('### Problems Solved');
      expect(formatted).toContain('- Fixed by adding issuer validation');
      expect(formatted).toContain('### Files Modified');
      expect(formatted).toContain('auth.ts');
    });

    it('omits empty sections', () => {
      const knowledge: ExtractedKnowledge = {
        topic: 'Quick fix',
        decisions: [],
        learnings: ['The trick is to restart the service'],
        problemsSolved: [],
        filesModified: [],
        commands: [],
      };

      const formatted = formatKnowledgeForStorage(knowledge);

      expect(formatted).toContain('### Learnings');
      expect(formatted).not.toContain('### Decisions');
      expect(formatted).not.toContain('### Problems Solved');
      expect(formatted).not.toContain('### Files Modified');
    });
  });
});
