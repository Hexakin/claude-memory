import { readFile } from 'node:fs/promises';
import type { TranscriptMessage, ToolUseBlock } from '../types.js';

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
        const toolUseBlocks: ToolUseBlock[] = [];

        if (typeof parsed.content === 'string') {
          textContent = parsed.content;
        } else if (Array.isArray(parsed.content)) {
          for (const block of parsed.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              textContent += (textContent ? '\n' : '') + block.text;
            } else if (block.type === 'tool_use' && block.name) {
              toolUseBlocks.push({
                name: block.name,
                input: block.input ?? {},
              });
            }
          }
        }

        if (textContent || toolUseBlocks.length > 0) {
          const msg: TranscriptMessage = { role, content: textContent };
          if (toolUseBlocks.length > 0) {
            msg.toolUse = toolUseBlocks;
          }
          messages.push(msg);
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
 * @deprecated Use extractKnowledge() and formatKnowledgeForStorage() instead.
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

// --- Structured knowledge extraction ---

/** Extracted knowledge from a session transcript */
export interface ExtractedKnowledge {
  topic: string;
  decisions: string[];
  learnings: string[];
  problemsSolved: string[];
  filesModified: string[];
  commands: string[];
}

// --- Extraction patterns ---

const decisionPatterns = [
  /(?:let's|let us|we'll|we should|going to|decided to|choosing|opted for|going with)\s+(.{10,150}?)(?:\.|$)/gi,
  /(?:use|switch to|migrate to|adopt)\s+([\w\s-]+?)(?:\s+(?:for|because|since|instead))/gi,
];

const learningPatterns = [
  /(?:turns out|it turns out|TIL|learned that|the (?:issue|problem|trick|key|fix) (?:is|was))\s+(.{10,200}?)(?:\.|$)/gi,
  /(?:important|note|gotcha|caveat|warning):\s*(.{10,200}?)(?:\.|$)/gi,
  /(?:this (?:happens|occurs|fails) because)\s+(.{10,200}?)(?:\.|$)/gi,
];

const problemPatterns = [
  /(?:fixed by|solution was|resolved by|the fix is|fixed it by)\s+(.{10,200}?)(?:\.|$)/gi,
  /(?:error|bug|issue)(?:\s+was)?:\s*(.{10,150}?)(?:\.\s|$)/gi,
];

const filePathPattern = /(?:[\w./\\-]+\/)?[\w.-]+\.(?:ts|js|tsx|jsx|py|go|rs|java|json|yaml|yml|toml|css|html|md|sql|sh)/g;

/**
 * Extract file paths from tool_use blocks (Edit, Write, Read tools).
 */
function extractFilesFromToolUse(messages: TranscriptMessage[]): string[] {
  const files = new Set<string>();
  for (const msg of messages) {
    if (!msg.toolUse) continue;
    for (const tool of msg.toolUse) {
      // Edit, Write, Read tools have file_path or filePath
      const filePath = tool.input['file_path'] ?? tool.input['filePath'];
      if (typeof filePath === 'string') {
        // Extract just the filename from full path
        const parts = filePath.replace(/\\/g, '/').split('/');
        const filename = parts[parts.length - 1];
        if (filename) files.add(filename);
      }
    }
  }
  return Array.from(files).slice(0, 10);
}

/**
 * Extract shell commands from tool_use blocks (Bash tool).
 */
function extractCommandsFromToolUse(messages: TranscriptMessage[]): string[] {
  const commands: string[] = [];
  for (const msg of messages) {
    if (!msg.toolUse) continue;
    for (const tool of msg.toolUse) {
      if (tool.name === 'Bash' || tool.name === 'bash') {
        const cmd = tool.input['command'];
        if (typeof cmd === 'string' && cmd.length > 5 && cmd.length < 200) {
          commands.push(cmd.trim());
        }
      }
    }
  }
  return commands.slice(0, 10);
}

function matchPatterns(text: string, patterns: RegExp[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const captured = match[1]?.trim();
      if (captured && captured.length >= 10) {
        results.push(captured);
      }
    }
  }
  return results;
}

function deriveTopic(messages: TranscriptMessage[]): string {
  // Get first 3 user messages to derive topic
  const userMessages = messages
    .filter(m => m.role === 'user' || m.role === 'human')
    .slice(0, 3);

  if (userMessages.length === 0) return 'General session';

  // Use first user message, truncated
  const first = userMessages[0].content.slice(0, 200).trim();
  // Remove markdown formatting
  const cleaned = first.replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || 'General session';
}

/**
 * Extract structured knowledge from transcript messages.
 * Returns null if the session is too short or has no meaningful content.
 */
export function extractKnowledge(messages: TranscriptMessage[]): ExtractedKnowledge | null {
  // Filter for meaningful content
  const meaningfulMessages = messages.filter(m => m.content.length > 10);

  // Count user messages to check if session is substantial
  const userMessages = meaningfulMessages.filter(m => m.role === 'user' || m.role === 'human');
  if (userMessages.length < 3) return null;

  // Combine all message text for pattern matching
  const allText = meaningfulMessages.map(m => m.content).join('\n');

  const decisions = matchPatterns(allText, decisionPatterns);
  const learnings = matchPatterns(allText, learningPatterns);
  const problemsSolved = matchPatterns(allText, problemPatterns);

  // Extract files from tool_use blocks, fall back to text regex
  let filesModified = extractFilesFromToolUse(messages);
  if (filesModified.length === 0) {
    const fileMatches = allText.match(filePathPattern) ?? [];
    filesModified = [...new Set(fileMatches)].slice(0, 10);
  }

  const commands = extractCommandsFromToolUse(messages);

  const topic = deriveTopic(messages);

  // Need at least 2 items total across categories
  const totalItems = decisions.length + learnings.length + problemsSolved.length;
  if (totalItems < 2) return null;

  return {
    topic,
    decisions: [...new Set(decisions)].slice(0, 5),
    learnings: [...new Set(learnings)].slice(0, 5),
    problemsSolved: [...new Set(problemsSolved)].slice(0, 5),
    filesModified,
    commands: commands.slice(0, 5),
  };
}

/**
 * Format extracted knowledge into structured markdown for storage.
 */
export function formatKnowledgeForStorage(knowledge: ExtractedKnowledge): string {
  const parts: string[] = [`## Session: ${knowledge.topic}`];

  if (knowledge.decisions.length > 0) {
    parts.push('', '### Decisions');
    for (const d of knowledge.decisions) {
      parts.push(`- ${d}`);
    }
  }

  if (knowledge.learnings.length > 0) {
    parts.push('', '### Learnings');
    for (const l of knowledge.learnings) {
      parts.push(`- ${l}`);
    }
  }

  if (knowledge.problemsSolved.length > 0) {
    parts.push('', '### Problems Solved');
    for (const p of knowledge.problemsSolved) {
      parts.push(`- ${p}`);
    }
  }

  if (knowledge.filesModified.length > 0) {
    parts.push('', `### Files Modified: ${knowledge.filesModified.join(', ')}`);
  }

  return parts.join('\n');
}
