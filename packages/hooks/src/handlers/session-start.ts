import type { HookInput, SessionStartOutput } from '../types.js';
import { detectProject } from '../lib/project-detect.js';
import { createMemoryClient } from '../lib/memory-client.js';

export async function handleSessionStart(input: HookInput): Promise<SessionStartOutput> {
  // 1. Detect project from cwd
  const { projectId, projectName } = await detectProject(input.cwd);

  // 2. Create memory client (reads env vars)
  const client = createMemoryClient();

  // 3. Search for project-specific memories (max 5)
  const projectMemories = await client.search(
    'project context, conventions, architecture decisions, and preferences',
    { scope: 'project', project: projectId, maxResults: 5 }
  );

  // 4. Search for global memories (max 3)
  const globalMemories = await client.search(
    'general coding preferences, patterns, and conventions',
    { scope: 'global', maxResults: 3 }
  );

  // 5. If no memories found, return empty (no context to inject)
  if (projectMemories.length === 0 && globalMemories.length === 0) {
    return {};
  }

  // 6. Format as context block
  const lines: string[] = ['# Recalled Memories'];

  if (projectMemories.length > 0) {
    lines.push('', `## Project: ${projectName ?? projectId}`);
    for (const mem of projectMemories) {
      const tags = mem.tags.length > 0 ? ` [${mem.tags.join(', ')}]` : '';
      lines.push(`- ${mem.content}${tags}`);
    }
  }

  if (globalMemories.length > 0) {
    lines.push('', '## Global');
    for (const mem of globalMemories) {
      const tags = mem.tags.length > 0 ? ` [${mem.tags.join(', ')}]` : '';
      lines.push(`- ${mem.content}${tags}`);
    }
  }

  return { additionalContext: lines.join('\n') };
}
