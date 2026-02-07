import type {
  MemoryBulkDeleteInput, MemoryBulkDeleteOutput,
  MemoryExportInput, MemoryExportOutput,
  MemoryImportInput, MemoryImportOutput,
} from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { createMemory } from '../db/memory-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import { deleteByMemoryId, createChunks } from '../db/chunk-repo.js';
import { chunkText } from '../embedding/chunker.js';
import pino from 'pino';

const log = pino({ name: 'memory-bulk' });

/**
 * Bulk delete memories matching filters.
 * Requires confirm: true as a safety check.
 */
export async function handleMemoryBulkDelete(
  ctx: ServerContext,
  input: MemoryBulkDeleteInput,
): Promise<MemoryBulkDeleteOutput> {
  if (!input.confirm) {
    log.warn('Bulk delete rejected: confirm not set');
    return { deleted: 0 };
  }

  const db = ctx.globalDb;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.tag) {
    conditions.push(`m.id IN (SELECT mt.memory_id FROM memory_tags mt JOIN tags t ON mt.tag_id = t.id WHERE t.name = ?)`);
    params.push(input.tag);
  }

  if (input.project) {
    conditions.push('m.project_id = ?');
    params.push(input.project);
  }

  if (input.older_than) {
    conditions.push('m.created_at < ?');
    params.push(input.older_than);
  }

  if (conditions.length === 0) {
    log.warn('Bulk delete rejected: no filters specified');
    return { deleted: 0 };
  }

  const whereClause = conditions.join(' AND ');

  // Get IDs to delete
  const rows = db.prepare(
    `SELECT m.id FROM memories m WHERE ${whereClause}`
  ).all(...params) as Array<{ id: string }>;

  // Delete each memory (handles cascading cleanup)
  let deleted = 0;
  for (const row of rows) {
    deleteByMemoryId(db, row.id, ctx.vecAvailable);
    db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
    deleted++;
  }

  log.info({ deleted, filters: { tag: input.tag, project: input.project, olderThan: input.older_than } }, 'Bulk delete complete');
  return { deleted };
}

/**
 * Export memories as JSON or markdown.
 */
export async function handleMemoryExport(
  ctx: ServerContext,
  input: MemoryExportInput,
): Promise<MemoryExportOutput> {
  const db = ctx.globalDb;
  const format = input.format ?? 'json';

  let query = 'SELECT id, content, source, project_id, created_at, memory_type, importance_score, is_rule FROM memories';
  const params: unknown[] = [];

  if (input.project) {
    query += ' WHERE project_id = ?';
    params.push(input.project);
  }

  query += ' ORDER BY created_at DESC';

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    content: string;
    source: string | null;
    project_id: string | null;
    created_at: string;
    memory_type: string;
    importance_score: number;
    is_rule: number;
  }>;

  // Fetch tags for all memories
  const memoryIds = rows.map(r => r.id);
  const tagsMap = new Map<string, string[]>();

  if (memoryIds.length > 0) {
    const placeholders = memoryIds.map(() => '?').join(',');
    const tagRows = db.prepare(
      `SELECT mt.memory_id, t.name FROM memory_tags mt JOIN tags t ON mt.tag_id = t.id WHERE mt.memory_id IN (${placeholders})`
    ).all(...memoryIds) as Array<{ memory_id: string; name: string }>;

    for (const row of tagRows) {
      const existing = tagsMap.get(row.memory_id);
      if (existing) existing.push(row.name);
      else tagsMap.set(row.memory_id, [row.name]);
    }
  }

  if (format === 'markdown') {
    const lines = ['# Exported Memories', ''];
    for (const row of rows) {
      const tags = tagsMap.get(row.id) ?? [];
      lines.push(`## ${row.memory_type} (${row.created_at})`);
      if (tags.length > 0) lines.push(`Tags: ${tags.join(', ')}`);
      lines.push('', row.content, '');
      lines.push('---', '');
    }
    const data = lines.join('\n');
    log.info({ count: rows.length, format }, 'Export complete');
    return { data, count: rows.length, format };
  }

  // JSON format
  const memories = rows.map(row => ({
    id: row.id,
    content: row.content,
    source: row.source,
    projectId: row.project_id,
    createdAt: row.created_at,
    memoryType: row.memory_type,
    importanceScore: row.importance_score,
    isRule: row.is_rule === 1,
    tags: tagsMap.get(row.id) ?? [],
  }));

  const data = JSON.stringify(memories, null, 2);
  log.info({ count: rows.length, format }, 'Export complete');
  return { data, count: rows.length, format };
}

/**
 * Import memories from JSON.
 */
export async function handleMemoryImport(
  ctx: ServerContext,
  input: MemoryImportInput,
): Promise<MemoryImportOutput> {
  const db = ctx.globalDb;
  let imported = 0;
  let errors = 0;

  let memories: Array<{
    content: string;
    source?: string;
    projectId?: string;
    memoryType?: string;
    importanceScore?: number;
    isRule?: boolean;
    tags?: string[];
  }>;

  try {
    memories = JSON.parse(input.data);
    if (!Array.isArray(memories)) {
      return { imported: 0, errors: 1 };
    }
  } catch {
    log.error('Failed to parse import data');
    return { imported: 0, errors: 1 };
  }

  for (const mem of memories) {
    try {
      if (!mem.content || typeof mem.content !== 'string') {
        errors++;
        continue;
      }

      const memory = createMemory(db, {
        content: mem.content,
        source: mem.source,
        projectId: input.project ?? mem.projectId,
        memoryType: mem.memoryType,
        importanceScore: mem.importanceScore,
        isRule: mem.isRule,
      });

      if (mem.tags && mem.tags.length > 0) {
        setMemoryTags(db, memory.id, mem.tags);
      }

      // Create chunks and embeddings
      const chunks = chunkText(mem.content);
      const chunksWithEmbeddings = [];
      for (const chunk of chunks) {
        const embedding = await ctx.embedder.embed(chunk.content, 'document');
        chunksWithEmbeddings.push({
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          tokenCount: chunk.tokenCount,
          embedding,
        });
      }
      createChunks(db, memory.id, chunksWithEmbeddings, ctx.vecAvailable);

      imported++;
    } catch (err) {
      log.error({ err, content: mem.content?.slice(0, 50) }, 'Failed to import memory');
      errors++;
    }
  }

  log.info({ imported, errors }, 'Import complete');
  return { imported, errors };
}
