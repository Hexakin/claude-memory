import type { MemorySearchInput, MemorySearchOutput, MemorySearchResult } from '@claude-memory/shared';
import { DEFAULT_MAX_RESULTS, DEFAULT_MIN_SCORE } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { getProjectDb, isVecAvailable } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { hybridSearch } from '../search/hybrid.js';
import pino from 'pino';

const log = pino({ name: 'memory-search' });

/**
 * Search memories using hybrid vector + keyword search.
 * Returns ranked results with optional project/tag filtering.
 */
export async function handleMemorySearch(
  ctx: ServerContext,
  input: MemorySearchInput,
): Promise<MemorySearchOutput> {
  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const scope = input.scope ?? 'all';

  const dbsToSearch: Array<{
    db: typeof ctx.globalDb;
    projectId?: string | null;
    vecAvailable: boolean;
  }> = [];

  if (scope === 'global' || (scope === 'all' && !input.project)) {
    dbsToSearch.push({
      db: ctx.globalDb,
      projectId: null,
      vecAvailable: ctx.vecAvailable,
    });
  }

  if (scope === 'project' || scope === 'all') {
    if (input.project) {
      const projectDb = getProjectDb(ctx.dataDir, input.project);
      const projectVec = isVecAvailable();
      runMigrations(projectDb, projectVec);
      dbsToSearch.push({
        db: projectDb,
        projectId: input.project,
        vecAvailable: projectVec,
      });
    }
  }

  // If scope is 'all' and no project specified, only search global
  // (we already added global above)

  // Search each database
  const allResults: MemorySearchResult[] = [];

  for (const { db, projectId, vecAvailable } of dbsToSearch) {
    const results = await hybridSearch({
      db,
      embedder: ctx.embedder,
      query: input.query,
      projectId,
      tags: input.tags,
      maxResults,
      minScore,
      vecAvailable,
      includeArchived: input.include_archived,
    });
    allResults.push(...results);
  }

  // If searching multiple databases, merge and deduplicate
  if (dbsToSearch.length > 1) {
    // Deduplicate by memory ID (keep highest score)
    const seen = new Map<string, MemorySearchResult>();
    for (const result of allResults) {
      const existing = seen.get(result.id);
      if (!existing || result.score > existing.score) {
        seen.set(result.id, result);
      }
    }

    const merged = Array.from(seen.values());
    merged.sort((a, b) => b.score - a.score);

    log.info({ query: input.query, results: merged.length }, 'Search completed (merged)');
    return { results: merged.slice(0, maxResults) };
  }

  log.info({ query: input.query, results: allResults.length }, 'Search completed');
  return { results: allResults };
}
