import { readFile } from 'node:fs/promises';
import type { TranscriptMessage } from '../types.js';

/**
 * Parse Claude Code JSONL transcript file.
 * Each line is a JSON object with role and content.
 */
export async function parseTranscript(filePath: string): Promise<TranscriptMessage[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const messages: TranscriptMessage[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const role = parsed.role ?? 'unknown';

        // Handle content as string or array of blocks
        let textContent = '';
        if (typeof parsed.content === 'string') {
          textContent = parsed.content;
        } else if (Array.isArray(parsed.content)) {
          textContent = parsed.content
            .filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n');
        }

        if (textContent) {
          messages.push({ role, content: textContent });
        }
      } catch {
        // Skip malformed lines silently
      }
    }

    return messages;
  } catch {
    // File not found or unreadable - return empty array
    return [];
  }
}

/**
 * Summarize transcript messages into a concise session summary.
 * Takes the last N messages and generates a paragraph describing the session.
 */
export function summarizeTranscript(messages: TranscriptMessage[], maxMessages = 20): string {
  // Filter for meaningful content (skip very short messages)
  const meaningfulMessages = messages.filter(m => m.content.length > 10);

  // Count user messages to check if session is substantial
  const userMessages = meaningfulMessages.filter(m => m.role === 'user');
  if (userMessages.length < 3) {
    return ''; // Session too short to summarize
  }

  // Take last N messages
  const recentMessages = meaningfulMessages.slice(-maxMessages);

  // Extract key topics and actions
  const topics = new Set<string>();
  const actions = new Set<string>();
  const files = new Set<string>();

  for (const msg of recentMessages) {
    const content = msg.content.toLowerCase();

    // Detect file mentions
    const fileMatches = msg.content.match(/[a-z0-9_-]+\.(ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|md|json|yaml|yml|toml|css|html|vue|svelte)/gi);
    if (fileMatches) {
      fileMatches.slice(0, 5).forEach(f => files.add(f)); // Limit to 5 files
    }

    // Detect actions
    if (content.includes('fix') || content.includes('bug')) actions.add('fixing bugs');
    if (content.includes('implement') || content.includes('add')) actions.add('implementing features');
    if (content.includes('refactor')) actions.add('refactoring code');
    if (content.includes('test')) actions.add('writing tests');
    if (content.includes('debug')) actions.add('debugging');
    if (content.includes('document')) actions.add('writing documentation');
    if (content.includes('optimize') || content.includes('performance')) actions.add('optimizing performance');

    // Detect topics (limited set)
    if (content.includes('api') || content.includes('endpoint')) topics.add('API development');
    if (content.includes('ui') || content.includes('component')) topics.add('UI components');
    if (content.includes('database') || content.includes('sql')) topics.add('database operations');
    if (content.includes('auth') || content.includes('login')) topics.add('authentication');
    if (content.includes('deploy') || content.includes('ci/cd')) topics.add('deployment');
  }

  // Build summary paragraph
  const parts: string[] = [];

  if (actions.size > 0) {
    parts.push(`Session focused on ${Array.from(actions).join(', ')}`);
  }

  if (topics.size > 0) {
    parts.push(`involving ${Array.from(topics).join(', ')}`);
  }

  if (files.size > 0) {
    parts.push(`Modified files: ${Array.from(files).slice(0, 5).join(', ')}`);
  }

  const summary = parts.join('. ');

  // Ensure summary doesn't exceed 2000 chars
  return summary.length > 2000 ? summary.slice(0, 1997) + '...' : summary;
}
