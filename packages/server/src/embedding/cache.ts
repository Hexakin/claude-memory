import type Database from 'better-sqlite3';
import { EMBEDDING_MODEL } from '@claude-memory/shared';
import { hashForCache, type EmbedType } from './embedder.js';

export interface EmbeddingCache {
  /** Get cached embedding, or null if not found */
  get(text: string, type: EmbedType): Float32Array | null;
  /** Store embedding in cache */
  set(text: string, type: EmbedType, embedding: Float32Array): void;
  /** Get cache stats */
  stats(): { size: number; hits: number; misses: number };
}

export function createEmbeddingCache(db: Database.Database): EmbeddingCache {
  let hits = 0;
  let misses = 0;

  const getStmt = db.prepare(
    'SELECT embedding FROM embedding_cache WHERE text_hash = ?',
  );

  const setStmt = db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (text_hash, embedding, model_id, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  );

  const countStmt = db.prepare('SELECT COUNT(*) as count FROM embedding_cache');

  return {
    get(text: string, type: EmbedType): Float32Array | null {
      const hash = hashForCache(text, type);
      const row = getStmt.get(hash) as { embedding: Buffer } | undefined;
      if (!row) {
        misses++;
        return null;
      }
      hits++;
      // Convert BLOB to Float32Array
      return new Float32Array(new Uint8Array(row.embedding).buffer);
    },

    set(text: string, type: EmbedType, embedding: Float32Array): void {
      const hash = hashForCache(text, type);
      // Convert Float32Array to Buffer for BLOB storage
      const blob = Buffer.from(embedding.buffer);
      setStmt.run(hash, blob, EMBEDDING_MODEL);
    },

    stats(): { size: number; hits: number; misses: number } {
      const row = countStmt.get() as { count: number };
      return { size: row.count, hits, misses };
    },
  };
}
