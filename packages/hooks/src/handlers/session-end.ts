import type { HookInput } from '../types.js';
import { detectProject } from '../lib/project-detect.js';
import { createMemoryClient } from '../lib/memory-client.js';
import { parseTranscript, summarizeTranscript } from '../lib/transcript-parser.js';

export async function handleSessionEnd(input: HookInput): Promise<void> {
  // 1. Need transcript_path to summarize
  if (!input.transcript_path) return;

  // 2. Parse transcript
  const messages = await parseTranscript(input.transcript_path);

  // 3. Generate summary (returns empty if session too short)
  const summary = summarizeTranscript(messages);
  if (!summary) return;

  // 4. Detect project
  const { projectId } = await detectProject(input.cwd);

  // 5. Store summary to memory
  const client = createMemoryClient();
  await client.store(summary, {
    source: 'session-summary',
    project: projectId,
    tags: ['session', 'auto-summary'],
  });
}
