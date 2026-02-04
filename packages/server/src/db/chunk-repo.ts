import type Database from 'better-sqlite3';

interface ChunkInput {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  embedding: Float32Array;
}

interface ChunkSearchResult {
  chunkId: string;
  memoryId: string;
  content: string;
  score: number;
}

interface ChunkEmbedding {
  chunkId: string;
  memoryId: string;
  embedding: Float32Array;
}

/**
 * Batch-insert chunks with their embeddings into chunks, chunks_vec, and chunks_fts.
 * Wraps everything in a transaction for atomicity.
 */
export function createChunks(
  db: Database.Database,
  memoryId: string,
  chunks: ChunkInput[],
  vecAvailable: boolean,
): void {
  const insertChunk = db.prepare(`
    INSERT INTO chunks (memory_id, content, chunk_index, token_count)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `);

  const insertVec = vecAvailable
    ? db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)')
    : null;

  const insertFts = db.prepare(
    'INSERT INTO chunks_fts (chunk_id, memory_id, content) VALUES (?, ?, ?)',
  );

  const batchInsert = db.transaction(() => {
    for (const chunk of chunks) {
      const row = insertChunk.get(
        memoryId,
        chunk.content,
        chunk.chunkIndex,
        chunk.tokenCount,
      ) as { id: string };

      const chunkId = row.id;

      // Insert vector embedding if sqlite-vec is available
      if (insertVec) {
        const embeddingBuffer = Buffer.from(chunk.embedding.buffer);
        insertVec.run(chunkId, embeddingBuffer);
      }

      // Insert into FTS index
      insertFts.run(chunkId, memoryId, chunk.content);
    }
  });

  batchInsert();
}

/**
 * Search chunks by vector similarity using sqlite-vec.
 * Uses cosine distance and converts to a similarity score (1 - distance).
 */
export function searchVector(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number,
): ChunkSearchResult[] {
  const embeddingBuffer = Buffer.from(queryEmbedding.buffer);

  const rows = db
    .prepare(
      `SELECT
         v.chunk_id as chunkId,
         c.memory_id as memoryId,
         c.content,
         vec_distance_cosine(v.embedding, ?) as distance
       FROM chunks_vec v
       JOIN chunks c ON v.chunk_id = c.id
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(embeddingBuffer, limit) as Array<{
    chunkId: string;
    memoryId: string;
    content: string;
    distance: number;
  }>;

  return rows.map((row) => ({
    chunkId: row.chunkId,
    memoryId: row.memoryId,
    content: row.content,
    score: 1 - row.distance,
  }));
}

/**
 * Search chunks using FTS5 full-text search.
 * Converts raw query text to an AND-joined FTS5 query of quoted tokens.
 * Uses BM25 ranking via the rank column.
 */
export function searchFTS(
  db: Database.Database,
  query: string,
  limit: number,
): ChunkSearchResult[] {
  // Build FTS5 query: AND-join quoted tokens
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' AND ');

  if (tokens.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT
         chunk_id as chunkId,
         memory_id as memoryId,
         content,
         rank
       FROM chunks_fts
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(tokens, limit) as Array<{
    chunkId: string;
    memoryId: string;
    content: string;
    rank: number;
  }>;

  return rows.map((row) => ({
    chunkId: row.chunkId,
    memoryId: row.memoryId,
    content: row.content,
    score: 1 / (1 + Math.abs(row.rank)),
  }));
}

/**
 * Delete all chunks for a memory from chunks, chunks_vec, and chunks_fts.
 */
export function deleteByMemoryId(
  db: Database.Database,
  memoryId: string,
  vecAvailable: boolean,
): void {
  const chunkIds = db
    .prepare('SELECT id FROM chunks WHERE memory_id = ?')
    .all(memoryId) as Array<{ id: string }>;

  if (chunkIds.length === 0) return;

  const deleteAll = db.transaction(() => {
    for (const chunk of chunkIds) {
      if (vecAvailable) {
        db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(chunk.id);
      }
      db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?').run(chunk.id);
    }
    db.prepare('DELETE FROM chunks WHERE memory_id = ?').run(memoryId);
  });

  deleteAll();
}

/**
 * Load all chunk embeddings from the chunks_vec table.
 * Used for JS-based vector fallback when sqlite-vec is not available.
 */
export function getAllChunkEmbeddings(
  db: Database.Database,
): ChunkEmbedding[] {
  const rows = db
    .prepare(
      `SELECT v.chunk_id as chunkId, c.memory_id as memoryId, v.embedding
       FROM chunks_vec v
       JOIN chunks c ON v.chunk_id = c.id`,
    )
    .all() as Array<{
    chunkId: string;
    memoryId: string;
    embedding: Buffer;
  }>;

  return rows.map((row) => ({
    chunkId: row.chunkId,
    memoryId: row.memoryId,
    embedding: new Float32Array(new Uint8Array(row.embedding).buffer),
  }));
}
