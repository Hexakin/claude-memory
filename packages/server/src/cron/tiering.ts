import type Database from 'better-sqlite3';
import pino from 'pino';

const log = pino({ name: 'tiering' });

export interface TieringResult {
  promoted: number;
  demoted: number;
  archived: number;
}

/**
 * Reassign storage tiers based on access patterns and importance.
 *
 * Tier rules:
 * - active: accessed in last 7 days OR importance > 0.7 OR is_rule = 1
 * - working: accessed in last 30 days
 * - archive: not accessed in 30+ days AND importance < 0.3
 */
export function updateStorageTiers(db: Database.Database): TieringResult {
  // Promote to active: recently accessed or high importance or rules
  const promoted = db.prepare(`
    UPDATE memories SET storage_tier = 'active'
    WHERE storage_tier != 'active'
      AND (
        last_accessed_at > datetime('now', '-7 days')
        OR importance_score > 0.7
        OR is_rule = 1
      )
  `).run().changes;

  // Demote to working: not recently accessed but within 30 days
  const demoted = db.prepare(`
    UPDATE memories SET storage_tier = 'working'
    WHERE storage_tier = 'active'
      AND last_accessed_at <= datetime('now', '-7 days')
      AND importance_score <= 0.7
      AND is_rule = 0
  `).run().changes;

  // Archive: old and low importance
  const archived = db.prepare(`
    UPDATE memories SET storage_tier = 'archive'
    WHERE storage_tier != 'archive'
      AND last_accessed_at <= datetime('now', '-30 days')
      AND importance_score < 0.3
      AND is_rule = 0
  `).run().changes;

  log.info({ promoted, demoted, archived }, 'Storage tier update complete');
  return { promoted, demoted, archived };
}
