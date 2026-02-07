import type { HookInput, SessionStartOutput } from '../types.js';
import { detectProject } from '../lib/project-detect.js';
import { createMemoryClient } from '../lib/memory-client.js';
import { createHookLogger } from '../lib/logger.js';
import { trimToTokenBudget, type Section } from '../lib/token-budget.js';

const logger = createHookLogger('session-start');

/** Deduplicate search results by memory ID, keeping highest score */
function deduplicateResults(results: Array<{ id: string; content: string; score: number; tags: string[]; source: string | null; createdAt: string }>): typeof results {
  const seen = new Map<string, typeof results[0]>();
  for (const result of results) {
    const existing = seen.get(result.id);
    if (!existing || result.score > existing.score) {
      seen.set(result.id, result);
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}

export async function handleSessionStart(input: HookInput): Promise<SessionStartOutput> {
  logger.info('Starting session hook', { cwd: input.cwd });

  // 1. Detect project from cwd
  const { projectId, projectName } = await detectProject(input.cwd);
  logger.debug('Project detected', { projectId, projectName });

  // 2. Create memory client (reads env vars)
  const client = createMemoryClient();

  // 3. Health check before any queries
  const healthy = await client.health();
  if (!healthy) {
    logger.warn('Memory server unreachable');
    return {
      additionalContext: '# Claude Memory\n\n> WARNING: Memory server is unreachable. Memories are unavailable this session.',
    };
  }

  // 4. Fetch rules (always injected, via memory_list with tag='rule')
  const rules = await client.list({ tag: 'rule' });
  logger.debug('Rules found', { count: rules.length });

  // 5. Multi-query retrieval: multiple focused queries per category
  const projectDir = input.cwd.split(/[/\\]/).pop() ?? '';
  const projectLabel = projectName ?? projectDir;

  // Run all searches in parallel for no latency increase
  const [projectResults, recentResults, globalResults] = await Promise.all([
    // Project context: 3 queries
    Promise.all([
      client.search(`${projectLabel} architecture patterns conventions`, { scope: 'project', project: projectId, maxResults: 3 }),
      client.search(`${projectLabel} setup configuration dependencies`, { scope: 'project', project: projectId, maxResults: 3 }),
      client.search(`${projectLabel} recent changes decisions`, { scope: 'project', project: projectId, maxResults: 3 }),
    ]).then(results => deduplicateResults(results.flat()).slice(0, 5)),

    // Recent learnings: 2 queries
    Promise.all([
      client.search('recent mistakes pitfalls gotchas bugs', { scope: 'project', project: projectId, maxResults: 3 }),
      client.search('recent learnings important notes warnings', { scope: 'project', project: projectId, maxResults: 3 }),
    ]).then(results => deduplicateResults(results.flat()).slice(0, 3)),

    // Global preferences: 2 queries
    Promise.all([
      client.search('coding preferences style conventions', { scope: 'global', maxResults: 3 }),
      client.search('user preferences workflow tools', { scope: 'global', maxResults: 3 }),
    ]).then(results => deduplicateResults(results.flat()).slice(0, 3)),
  ]);

  logger.debug('Multi-query results', {
    project: projectResults.length,
    recent: recentResults.length,
    global: globalResults.length,
  });

  // 6. If nothing found, return empty
  if (rules.length === 0 && projectResults.length === 0 && recentResults.length === 0 && globalResults.length === 0) {
    logger.info('No memories found, returning empty context');
    return {};
  }

  // 7. Build sections with token budget
  const budgetSections: Section[] = [];

  if (rules.length > 0) {
    budgetSections.push({
      title: 'Rules (Always Apply)',
      items: rules.map(r => r.content),
      priority: 1,
      maxTokens: 300,
    });
  }

  if (projectResults.length > 0) {
    budgetSections.push({
      title: `Project: ${projectLabel}`,
      items: projectResults.map(m => m.content),
      priority: 2,
      maxTokens: 300,
    });
  }

  if (recentResults.length > 0) {
    budgetSections.push({
      title: 'Recent Learnings and Pitfalls',
      items: recentResults.map(m => {
        const prefix = m.tags.includes('mistake') ? '[PITFALL] ' : '';
        return `${prefix}${m.content}`;
      }),
      priority: 3,
      maxTokens: 250,
    });
  }

  if (globalResults.length > 0) {
    budgetSections.push({
      title: 'Global Preferences',
      items: globalResults.map(m => m.content),
      priority: 4,
      maxTokens: 150,
    });
  }

  const additionalContext = trimToTokenBudget(budgetSections);

  logger.info('Session start complete', {
    rules: rules.length,
    projectMemories: projectResults.length,
    recentMemories: recentResults.length,
    globalMemories: globalResults.length,
    contextLength: additionalContext.length,
  });
  return { additionalContext };
}
