import { DEFAULT_CHUNK_TOKENS, DEFAULT_CHUNK_OVERLAP, APPROX_CHARS_PER_TOKEN } from '@claude-memory/shared';

export interface ChunkResult {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

/**
 * Chunk text into overlapping segments, respecting markdown boundaries.
 * - Splits on line boundaries
 * - Avoids splitting mid-code-block (``` ... ```)
 * - Avoids splitting mid-heading
 * - Uses ~4 chars/token approximation for token counting
 */
export function chunkText(
  text: string,
  maxTokens: number = DEFAULT_CHUNK_TOKENS,
  overlapTokens: number = DEFAULT_CHUNK_OVERLAP,
): ChunkResult[] {
  const maxChars = maxTokens * APPROX_CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * APPROX_CHARS_PER_TOKEN;

  // Small text: single chunk
  const estimatedTokens = Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
  if (estimatedTokens <= maxTokens) {
    return [{
      content: text,
      chunkIndex: 0,
      tokenCount: estimatedTokens,
    }];
  }

  const lines = text.split('\n');
  const chunks: ChunkResult[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let inCodeBlock = false;

  const flush = (): void => {
    if (currentLines.length === 0) return;
    const content = currentLines.join('\n');
    const tokenCount = Math.ceil(content.length / APPROX_CHARS_PER_TOKEN);
    chunks.push({
      content,
      chunkIndex: chunks.length,
      tokenCount,
    });
  };

  const carryOverlap = (): void => {
    if (overlapChars <= 0 || currentLines.length === 0) {
      currentLines = [];
      currentChars = 0;
      return;
    }
    // Keep last N lines that fit within overlap
    const kept: string[] = [];
    let acc = 0;
    for (let i = currentLines.length - 1; i >= 0; i--) {
      const line = currentLines[i];
      acc += line.length + 1;
      if (acc > overlapChars && kept.length > 0) break;
      kept.unshift(line);
    }
    currentLines = kept;
    currentChars = kept.reduce((sum, line) => sum + line.length + 1, 0);
  };

  for (const line of lines) {
    // Track code block boundaries
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }

    // Check if adding this line would exceed max
    const wouldExceed = currentChars + line.length + 1 > maxChars && currentLines.length > 0;

    // Don't split inside code blocks
    if (wouldExceed && !inCodeBlock) {
      flush();
      carryOverlap();
    }

    currentLines.push(line);
    currentChars += line.length + 1;
  }

  // Flush remaining
  flush();

  return chunks;
}
