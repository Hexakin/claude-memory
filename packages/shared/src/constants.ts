/** Default server port */
export const DEFAULT_PORT = 3577;

/** Embedding model configuration */
export const EMBEDDING_MODEL = 'nomic-embed-text-v1.5';
export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL_FILE = 'nomic-embed-text-v1.5.Q8_0.gguf';

/** Nomic embedding prefixes (IMPORTANT: these produce different embeddings) */
export const EMBED_PREFIX_DOCUMENT = 'search_document: ';
export const EMBED_PREFIX_QUERY = 'search_query: ';

/** Chunking configuration */
export const DEFAULT_CHUNK_TOKENS = 500;
export const DEFAULT_CHUNK_OVERLAP = 100;
export const APPROX_CHARS_PER_TOKEN = 4;

/** Search configuration */
export const DEFAULT_VECTOR_WEIGHT = 0.7;
export const DEFAULT_FTS_WEIGHT = 0.3;
export const DEFAULT_MAX_RESULTS = 10;
export const DEFAULT_MIN_SCORE = 0.3;

/** Task configuration */
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_CRON_SCHEDULE = '0 2 * * *'; // 2 AM daily
export const DEFAULT_MAX_RETRIES = 1;

/** Hook timeout for SessionStart (keep fast, don't block Claude Code) */
export const HOOK_TIMEOUT_MS = 3000; // 3 seconds

/** Hook timeout for SessionEnd (needs more time for extraction + network) */
export const SESSION_END_TIMEOUT_MS = 10000; // 10 seconds
