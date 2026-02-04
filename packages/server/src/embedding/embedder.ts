import { createHash } from 'node:crypto';
import { EMBED_PREFIX_DOCUMENT, EMBED_PREFIX_QUERY } from '@claude-memory/shared';

export type EmbedType = 'document' | 'query';

export interface Embedder {
  /** Embed a single text, with nomic prefix applied based on type */
  embed(text: string, type: EmbedType): Promise<Float32Array>;
  /** Embed a batch of texts */
  embedBatch(texts: string[], type: EmbedType): Promise<Float32Array[]>;
  /** Check if the model is loaded */
  isLoaded(): boolean;
  /** Unload the model */
  dispose(): Promise<void>;
}

/**
 * L2 normalize a vector to unit length.
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (!Number.isFinite(v)) vec[i] = 0;
    sumSq += vec[i] * vec[i];
  }
  const magnitude = Math.sqrt(sumSq);
  if (magnitude < 1e-10) return vec;
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] / magnitude;
  }
  return result;
}

/**
 * Get the appropriate prefix for nomic-embed-text-v1.5.
 * Documents use "search_document: " and queries use "search_query: "
 */
function getPrefix(type: EmbedType): string {
  return type === 'document' ? EMBED_PREFIX_DOCUMENT : EMBED_PREFIX_QUERY;
}

/**
 * Create a hash of (prefix + text) for cache keys.
 * Important: prefix affects the embedding, so it must be part of the key.
 */
export function hashForCache(text: string, type: EmbedType): string {
  const prefix = getPrefix(type);
  return createHash('sha256').update(prefix + text).digest('hex');
}

/**
 * Create an embedder backed by node-llama-cpp.
 * Lazy initialization: model is loaded on first embed call.
 */
export async function createEmbedder(modelPath: string): Promise<Embedder> {
  // Lazy-loaded state — typed as `any` because node-llama-cpp
  // may not be installed at compile time.
  let llamaInstance: any = null;
  let model: any = null;
  let context: any = null;
  let loaded = false;

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;

    // Dynamic import to allow graceful failure
    // @ts-ignore — node-llama-cpp types may not be available at build time
    const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');
    llamaInstance = await getLlama({ logLevel: LlamaLogLevel.error });
    model = await llamaInstance.loadModel({ modelPath });
    context = await model.createEmbeddingContext();
    loaded = true;
  };

  return {
    async embed(text: string, type: EmbedType): Promise<Float32Array> {
      await ensureLoaded();
      const prefixed = getPrefix(type) + text;
      const result = await context.getEmbeddingFor(prefixed);
      return l2Normalize(new Float32Array(result.vector));
    },

    async embedBatch(texts: string[], type: EmbedType): Promise<Float32Array[]> {
      await ensureLoaded();
      const prefix = getPrefix(type);
      const results: Float32Array[] = [];
      for (const text of texts) {
        const prefixed = prefix + text;
        const result = await context.getEmbeddingFor(prefixed);
        results.push(l2Normalize(new Float32Array(result.vector)));
      }
      return results;
    },

    isLoaded(): boolean {
      return loaded;
    },

    async dispose(): Promise<void> {
      if (context) {
        await context.dispose?.();
        context = null;
      }
      if (model) {
        await model.dispose?.();
        model = null;
      }
      loaded = false;
    },
  };
}
