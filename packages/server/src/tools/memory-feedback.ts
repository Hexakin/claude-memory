import type { MemoryFeedbackInput, MemoryFeedbackOutput } from '@claude-memory/shared';
import type { ServerContext } from '../server.js';
import { getMemoryById, updateMemory } from '../db/memory-repo.js';
import { setMemoryTags } from '../db/tag-repo.js';
import pino from 'pino';

const log = pino({ name: 'memory-feedback' });

/**
 * Process user feedback on a memory.
 * - useful: boost importance by 0.1 (capped at 1.0)
 * - outdated: halve importance
 * - wrong: set importance to 0, add 'disputed' tag
 * - duplicate: mark for consolidation review
 */
export async function handleMemoryFeedback(
  ctx: ServerContext,
  input: MemoryFeedbackInput,
): Promise<MemoryFeedbackOutput> {
  // Search global DB first
  let db = ctx.globalDb;
  let memory = getMemoryById(db, input.id);

  // If not found in global, check if it might be in a project DB
  // (We can't know the project without more context, so just search global)
  if (!memory) {
    log.warn({ id: input.id }, 'Memory not found');
    return { updated: false, action: 'not_found' };
  }

  let newImportance: number;
  let action: string;

  switch (input.rating) {
    case 'useful':
      newImportance = Math.min(1.0, memory.importanceScore + 0.1);
      updateMemory(db, input.id, { importanceScore: newImportance });
      action = 'importance_boosted';
      log.info({ id: input.id, oldImportance: memory.importanceScore, newImportance }, 'Memory marked as useful');
      break;

    case 'outdated':
      newImportance = memory.importanceScore * 0.5;
      updateMemory(db, input.id, { importanceScore: newImportance });
      action = 'importance_halved';
      log.info({ id: input.id, oldImportance: memory.importanceScore, newImportance }, 'Memory marked as outdated');
      break;

    case 'wrong':
      newImportance = 0;
      updateMemory(db, input.id, { importanceScore: 0 });
      // Add 'disputed' tag
      const currentTags = memory.tags;
      if (!currentTags.includes('disputed')) {
        setMemoryTags(db, input.id, [...currentTags, 'disputed']);
      }
      action = 'disputed';
      log.info({ id: input.id }, 'Memory marked as wrong, flagged as disputed');
      break;

    case 'duplicate':
      newImportance = memory.importanceScore;
      // Add 'consolidation-candidate' tag
      const tags = memory.tags;
      if (!tags.includes('consolidation-candidate')) {
        setMemoryTags(db, input.id, [...tags, 'consolidation-candidate']);
      }
      action = 'marked_for_consolidation';
      log.info({ id: input.id }, 'Memory marked as duplicate for consolidation');
      break;

    default:
      return { updated: false, action: 'unknown_rating' };
  }

  return { updated: true, newImportance, action };
}
