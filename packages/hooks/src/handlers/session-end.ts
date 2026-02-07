import type { HookInput } from '../types.js';
import { detectProject } from '../lib/project-detect.js';
import { createMemoryClient } from '../lib/memory-client.js';
import type { MemoryClient } from '../lib/memory-client.js';
import { parseTranscript, extractKnowledge, formatKnowledgeForStorage } from '../lib/transcript-parser.js';
import { createHookLogger } from '../lib/logger.js';

const logger = createHookLogger('session-end');

/** Maximum individual items to store (on top of the 1 episode summary) */
const MAX_INDIVIDUAL_ITEMS = 4;

/**
 * Store with retry logic. Retries once with 500ms backoff.
 * If the server restarts mid-session, the cached MCP session becomes stale;
 * the retry creates a fresh session implicitly via ensureSession().
 */
async function storeWithRetry(
  client: MemoryClient,
  text: string,
  options: { source?: string; project?: string; tags?: string[]; memory_type?: string; importance?: number; is_rule?: boolean },
  maxRetries = 1,
): Promise<{ id: string; chunks: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await client.store(text, options);
      if (result.id) return result;
      throw new Error('Store returned empty ID');
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        logger.warn('Store failed, retrying', { attempt, error: String(err) });
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

export async function handleSessionEnd(input: HookInput): Promise<void> {
  logger.info('Starting session end hook', { cwd: input.cwd, hasTranscript: !!input.transcript_path });

  // 1. Need transcript_path to process
  if (!input.transcript_path) {
    logger.warn('No transcript path provided, skipping session end');
    return;
  }

  // 2. Parse transcript (includes tool_use blocks)
  const messages = await parseTranscript(input.transcript_path);
  logger.debug('Transcript parsed', { messageCount: messages.length });

  // 3. Extract structured knowledge
  const knowledge = extractKnowledge(messages);
  if (!knowledge) {
    logger.info('Session too short or no knowledge extracted, skipping');
    return;
  }
  logger.info('Knowledge extracted', {
    decisions: knowledge.decisions.length,
    learnings: knowledge.learnings.length,
    problemsSolved: knowledge.problemsSolved.length,
    filesModified: knowledge.filesModified.length,
  });

  // 4. Detect project
  const { projectId } = await detectProject(input.cwd);
  logger.debug('Project detected', { projectId });

  // 5. Create client and prepare stores
  const client = createMemoryClient();
  const storePromises: Promise<unknown>[] = [];

  // 5a. ALWAYS store the full session episode summary (1 store call)
  const formatted = formatKnowledgeForStorage(knowledge);
  storePromises.push(
    storeWithRetry(client, formatted, {
      source: 'session-summary',
      project: projectId,
      tags: ['session', 'auto-summary', 'episode'],
      memory_type: 'episode',
    }),
  );

  // 5b. Store up to MAX_INDIVIDUAL_ITEMS, prioritized: mistakes > learnings > decisions
  const prioritizedItems: Array<{ text: string; tags: string[]; memory_type: string }> = [];

  // Mistakes first (highest priority)
  for (const problem of knowledge.problemsSolved) {
    prioritizedItems.push({
      text: problem,
      tags: ['mistake', 'auto-extracted'],
      memory_type: 'mistake',
    });
  }

  // Then learnings
  for (const learning of knowledge.learnings) {
    prioritizedItems.push({
      text: learning,
      tags: ['learning', 'auto-extracted'],
      memory_type: 'learning',
    });
  }

  // Then decisions (lowest priority)
  for (const decision of knowledge.decisions) {
    prioritizedItems.push({
      text: decision,
      tags: ['decision', 'auto-extracted'],
      memory_type: 'preference',
    });
  }

  // Take only the top N items
  const itemsToStore = prioritizedItems.slice(0, MAX_INDIVIDUAL_ITEMS);

  for (const item of itemsToStore) {
    storePromises.push(
      client.store(item.text, {
        source: 'extraction',
        project: projectId,
        tags: item.tags,
        memory_type: item.memory_type,
      }),
    );
  }

  logger.info('Storing items', {
    total: storePromises.length,
    episode: 1,
    individual: itemsToStore.length,
    totalExtracted: prioritizedItems.length,
    capped: prioritizedItems.length > MAX_INDIVIDUAL_ITEMS,
  });

  // 6. Execute all stores concurrently (best-effort)
  try {
    const results = await Promise.allSettled(storePromises);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    logger.info('Store results', { succeeded, failed });
  } catch (err) {
    logger.error('Failed to store session summary', { error: String(err) });
  }
}
