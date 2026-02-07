# Memory Schema Analysis & Architecture

**Generated:** 2026-02-07
**Stage:** RESEARCH_STAGE:4 - Memory structure and categorization analysis

---

## Executive Summary

The Claude Memory system uses a **hybrid vector + FTS search** architecture with a **flat, single-tier memory model**. Memories are stored as atomic records with basic metadata but lack semantic typing for cross-conversation intelligence.

**Current State:**
- ✅ Hybrid search (vector + full-text search)
- ✅ Chunking with 768-dim embeddings
- ✅ Tag-based categorization
- ✅ Source tracking (user, session-summary, automation, hook)
- ✅ Access tracking (count + lastAccessedAt)
- ✅ Project scoping
- ✅ Cleanup by age/access frequency
- ❌ **NO deduplication**
- ❌ **NO memory type classification** (preference, learning, objective, etc.)
- ❌ **NO relationship tracking** (related memories, chains)
- ❌ **NO semantic categories beyond tags**
- ❌ **NO memory expiration policies**
- ❌ **NO recency bias in search**

---

## 1. Memory Record Structure

### Database Schema (SQLite)

**Main Table: `memories`**
```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,                    -- UUID (randomblob(16))
  content TEXT NOT NULL,                  -- Full memory text
  source TEXT,                            -- 'user' | 'session-summary' | 'automation' | 'hook'
  project_id TEXT,                        -- Optional project scoping
  created_at TEXT DEFAULT now(),          -- Creation timestamp
  updated_at TEXT DEFAULT now(),          -- Last update
  last_accessed_at TEXT DEFAULT now(),    -- Last retrieval (for cleanup)
  access_count INTEGER DEFAULT 0,         -- Retrieval count (for hotness)
  metadata TEXT DEFAULT '{}'              -- JSON object (unstructured)
);
```

**Tag Table: `memory_tags` (N:M junction)**
```sql
CREATE TABLE memory_tags (
  memory_id TEXT REFERENCES memories(id),
  tag_id INTEGER REFERENCES tags(id),
  PRIMARY KEY (memory_id, tag_id)
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
```

**Chunk Table: `chunks` (text split for embedding)**
```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
  content TEXT NOT NULL,                  -- Chunk of text (≤512 tokens)
  chunk_index INTEGER NOT NULL,           -- Order in memory
  token_count INTEGER NOT NULL,           -- Chunk size
  created_at TEXT,
  UNIQUE(memory_id, chunk_index)
);
```

**Virtual Tables (Search)**
```sql
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[768]                    -- nomic-embed-text-v1.5
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  memory_id UNINDEXED,
  tokenize='porter unicode61'             -- Stemmed, Unicode-aware
);
```

### TypeScript Interfaces

**Memory Record:**
```typescript
interface Memory {
  id: string;                    // Unique ID
  content: string;               // Full text
  source: MemorySource | null;   // How it was created
  projectId: string | null;      // Project context
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  lastAccessedAt: string;        // For cleanup decisions
  accessCount: number;           // Hotness indicator
  metadata: Record<string, unknown>;  // Unstructured JSON
  tags: string[];                // User/system tags
}

type MemorySource = 'user' | 'session-summary' | 'automation' | 'hook';
```

---

## 2. Current Categorization System

### By Source (How memory was created)

| Source | Usage | Example |
|--------|-------|---------|
| `user` | Direct manual storage | `/note`, `/learner` commands |
| `session-summary` | Auto-generated from transcript | SessionEnd hook (≥3 user messages) |
| `automation` | Tool/workflow output | Task results, automated analysis |
| `hook` | Hook-injected context | SessionStart global/project memories |

**Schema:**
```typescript
export const memorySourceSchema = z.enum(['user', 'session-summary', 'automation', 'hook']);
```

### By Tags (User/System categorization)

Tags are **free-form strings**, stored in a separate table for normalization:
- User can assign any tags
- SessionEnd hook auto-adds: `['session', 'auto-summary']`
- No predefined tag vocabulary

**Current Tag Usage:**
- `session` - From SessionEnd hook
- `auto-summary` - SessionEnd-generated
- Project names (custom)
- Custom user tags

**Limitations:** Tags are just strings with no semantics—can't distinguish memory TYPE.

### By Project Scope

- **Global memories:** `project_id = null`
- **Project-scoped:** `project_id = <project-name>`
- Both searchable separately or together

---

## 3. Metadata System

Currently **unstructured JSON** stored as TEXT in `metadata` column.

**Current Usage:**
- Empty in most cases (defaults to `'{}'`)
- Available but not enforced

**Example from MCP Input:**
```typescript
interface MemoryStoreInput {
  text: string;                        // Required
  tags?: string[];                     // Optional
  project?: string;                    // Optional
  source?: MemorySource;               // Optional
  metadata?: Record<string, unknown>;  // Optional, any shape
}
```

**No Schema Validation** on metadata—users can store anything.

---

## 4. Search Architecture

### Hybrid Search Algorithm

**Flow (from `packages/server/src/search/hybrid.ts`):**

1. **Embed query** → nomic-embed-text-v1.5 (768-dim)
2. **Vector search** → SQLite vec0 extension (cosine similarity, top-K)
3. **FTS search** → SQLite FTS5 (Porter stemming, unicode61 tokenizer)
4. **Merge results** → Weighted score = `0.7 * vector_score + 0.3 * fts_score`
5. **Group by memory** → Keep highest-scoring chunk per memory
6. **Filter** → Apply project/tag constraints
7. **Limit & return** → Top N results (default: 10, max: 50)

**Constants:**
```typescript
DEFAULT_VECTOR_WEIGHT = 0.7;
DEFAULT_FTS_WEIGHT = 0.3;
DEFAULT_MAX_RESULTS = 10;
DEFAULT_MIN_SCORE = 0.3;  // Minimum combined score threshold
```

**Search Types:**

| Type | Scope | Code |
|------|-------|------|
| Global | All memories, all projects | `scope: 'global'` |
| Project-scoped | Only memories from one project | `scope: 'project'` + `project: <name>` |
| Combined | Both (useful for UI) | `scope: 'all'` |

**Tag Filtering:**
- `tags?: string[]` in search
- Memory must have **ALL** specified tags (AND logic)
- Applied AFTER scoring

**Vectorization Strategy:**
- Queries use `embed(text, 'query')` → query-specific embedding
- Chunks use `embed(text, 'document')` → document-specific embedding
- Cached via `embeddingCache` (SHA256 hash-based)

### Search Result Scoring

**SearchResult includes:**
```typescript
interface MemorySearchResult {
  id: string;           // Memory ID
  content: string;      // Full memory text
  score: number;        // Combined weighted score (0.3–1.0 typically)
  tags: string[];
  source: MemorySource | null;
  createdAt: string;
}
```

**No recency bias**—search doesn't factor `createdAt` into scoring.

---

## 5. Deduplication & Uniqueness

### Current State: **NO DEDUPLICATION**

**Issue:** Identical or near-identical memories can be stored multiple times.

**Example Problem:**
```
Memory 1: "Prefer using Sonnet for standard tasks"
Memory 2: "Standard tasks use Sonnet model"
Memory 3: "Sonnet is good for standard work"
```

All three would be stored separately, increasing:
- Storage size
- Search latency (more chunks to search)
- Retrieval confusion (redundant results)

### What's Missing:
- ❌ Duplicate detection on store
- ❌ Semantic similarity checking
- ❌ Merge/consolidation workflow
- ❌ Uniqueness constraints

### Potential Detection Methods:
1. **Hash-based** → SHA256 of normalized text (exact matches only)
2. **Vector similarity** → Embedding distance threshold (e.g., >0.95 similarity = duplicate)
3. **Fuzzy text match** → Levenshtein distance
4. **Semantic clustering** → Periodically group similar memories

---

## 6. Memory Expiration & Cleanup

### Current Cleanup Mechanism

**Manual via `memory_cleanup` tool:**
```typescript
interface MemoryCleanupInput {
  olderThan?: string;       // ISO date (e.g., "2026-01-01")
  maxCount?: number;        // Max memories to delete
  dryRun?: boolean;         // Default: true (safe default)
  project?: string;         // Optional scoping
}
```

**Logic:**
```sql
SELECT id FROM memories
WHERE last_accessed_at < ?
ORDER BY last_accessed_at ASC
LIMIT ?
```

**Deletes memories NOT ACCESSED since `olderThan` date.**

### What's Missing:
- ❌ Auto-expiration policies (time-based, importance-based)
- ❌ Archival (move old memories to separate storage)
- ❌ TTL per memory type (e.g., session summaries expire after 30 days)
- ❌ Smart retention (high-access memories kept longer)
- ❌ Age-based decay in search scoring

---

## 7. Memory_Store Tool Schema

### Input Schema (Zod validation)

```typescript
export const memoryStoreSchema = z.object({
  text: z.string().min(1, 'Text is required'),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  source: memorySourceSchema.optional(),     // 'user' | 'session-summary' | 'automation' | 'hook'
  metadata: z.record(z.unknown()).optional(), // Any JSON object
});
```

### Output Schema

```typescript
interface MemoryStoreOutput {
  id: string;     // Generated memory ID
  chunks: number; // How many chunks text was split into
}
```

### Processing Flow

1. **Validate input** (Zod)
2. **Create memory record** in DB (no dedup check)
3. **Set tags** (upsert into tags table)
4. **Chunk text** → max 512 tokens per chunk
5. **Embed each chunk** → nomic-embed-text-v1.5 (with cache)
6. **Insert chunks** into `chunks`, `chunks_vec`, `chunks_fts`

**No checks for:**
- Duplicate content
- Similarity to existing memories
- Metadata schema validation
- Memory type/purpose validation

---

## 8. Cross-Conversation Memory Gaps

### Missing Memory Types

Current system only has **source** (how created), NOT **type** (what it is).

**Needed Categories:**

| Type | Purpose | TTL | Scope | Example |
|------|---------|-----|-------|---------|
| `preference` | User's stated/inferred choices | ∞ | Global | "Prefers Opus for complex tasks" |
| `learning` | New skill/pattern learned | ∞ | Project | "Custom webpack config for Next.js" |
| `objective` | Current/ongoing goal | 30d | Project | "Complete API refactor by Friday" |
| `context` | Project/session context | 7d | Project | "Working on auth rewrite" |
| `history` | What happened | 60d | Project | "Fixed bug in auth.ts" |
| `constraint` | Limitation/requirement | ∞ | Project | "Node 18+ required" |
| `relationship` | Links between entities | ∞ | Global | "auth.ts calls password-utils.ts" |
| `decision` | Why something was done | ∞ | Project | "Used BCrypt because it's OWASP recommended" |

### Missing Relationship Tracking

No way to link related memories:
- "Is derived from memory X"
- "Contradicts memory Y"
- "Updates/supersedes memory Z"
- "Referenced by memory W"

### Missing Semantic Organization

Current: flat list with tags
Needed: hierarchical/graph structure
- Memories grouped by domain (auth, UI, API, etc.)
- Chains of reasoning
- Dependencies

### Missing Time-Based Intelligence

No time awareness in search:
- Most recent context first
- Trending topics (changing context)
- Seasonal patterns (what matters now vs. historically)
- Session continuity (remember what we discussed 5 minutes ago)

---

## 9. Data Flow Map

### SessionStart Hook
```
Hook triggered → Parse env (project, cwd) → Detect project
  ↓
Memory search (global: 3 memories, project: 5 memories)
  ↓
Return search results → Inject as context at conversation start
```

### SessionEnd Hook
```
Hook triggered → Read transcript (JSONL) → Parse messages
  ↓
Count user messages: if < 3 → skip
  ↓
Summarize (detect actions, topics, files) → ~1-2 sentences
  ↓
Store summary (source: 'session-summary', tags: ['session', 'auto-summary'])
  ↓
Chunks + embeddings + search indexing
```

### Manual Storage
```
User calls `/note` or MCP memory_store tool
  ↓
Validate input (Zod schema)
  ↓
Create memory record (no dedup)
  ↓
Chunk + embed + index
```

---

## 10. Performance Characteristics

### Database Size (Current)
- Schema: ~15 KB
- Typical memory: 500–5000 chars → 1–10 chunks
- Per chunk: 768 × 4 bytes = 3 KB (embedding) + content

### Search Latency
- Query embedding: ~50–100ms
- Vector search (vec0): ~10–50ms (k-NN)
- FTS search: ~5–20ms (inverted index)
- Merge + filter: ~5ms
- **Total:** ~100–200ms per search

### Scaling Limits
- Current: ~10K memories = ~100K chunks = manageable
- Projected: >100K memories = search slowdown (no partitioning)

---

## 11. Recommended Enhancements

### Priority 1: Deduplication
- **Add:** `content_hash` column (SHA256 of normalized text)
- **Check on store:** Is hash already present?
- **Action:** Update memory timestamp or merge
- **Cost:** ~50 lines, critical for memory health

### Priority 2: Memory Type Classification
- **Add:** `type` enum column ('preference' | 'learning' | 'objective' | 'context' | 'history' | 'constraint' | 'decision' | 'relationship')
- **Extend schemas:** memoryStoreSchema, Memory interface
- **Enable:** Type-specific retention policies
- **Cost:** ~100 lines, enables smart cleanup & filtering

### Priority 3: Metadata Schema Validation
- **Add:** Zod schema for metadata based on memory type
- **Validate on store:** Shape memory.metadata per type
- **Benefit:** Enables structured queries (e.g., "all preferences about models")
- **Cost:** ~200 lines

### Priority 4: Recency Bias in Search
- **Weight factor:** `recency_score = 1.0 - (days_old / 365)`
- **Adjust:** `final_score = base_score × (0.8 + 0.2 × recency_score)`
- **Tunable:** `recencyWeight` parameter
- **Cost:** ~20 lines

### Priority 5: Relationship Tracking
- **Add:** `memory_links` junction table
- **Fields:** `source_id`, `target_id`, `relationship_type` (enum)
- **Types:** "derives_from", "contradicts", "supersedes", "references", "chain"
- **Cost:** ~100 lines, high value for reasoning

### Priority 6: TTL & Retention Policies
- **Add:** `expires_at` column
- **Per-type:** Different default TTLs
- **Auto-cleanup:** Cron job to delete expired memories
- **Cost:** ~150 lines

---

## 12. Summary Table

| Aspect | Status | Notes |
|--------|--------|-------|
| **Basic storage** | ✅ Working | Memory creation, deletion, listing |
| **Hybrid search** | ✅ Working | Vector + FTS with weighting |
| **Chunking** | ✅ Working | 512-token chunks, embedded |
| **Embedding** | ✅ Working | nomic-embed-text-v1.5, cached |
| **Tagging** | ✅ Working | Free-form tags with normalization |
| **Project scoping** | ✅ Working | Global vs. project-scoped |
| **Access tracking** | ✅ Working | Count + lastAccessedAt |
| **Source tracking** | ✅ Working | user, session-summary, automation, hook |
| **Cleanup** | ✅ Working | Manual, age-based |
| **Deduplication** | ❌ Missing | No duplicate detection |
| **Memory typing** | ❌ Missing | No semantic types (preference, learning, etc.) |
| **Type-specific TTL** | ❌ Missing | No automatic expiration policies |
| **Relationship links** | ❌ Missing | Memories are atomic, no connections |
| **Recency bias** | ❌ Missing | Search doesn't favor recent memories |
| **Metadata validation** | ❌ Missing | Unstructured JSON, no schema |
| **Contradiction detection** | ❌ Missing | No conflict resolution |

---

## Files & Code Locations

| Component | File | LOC |
|-----------|------|-----|
| Schemas | `packages/shared/src/schemas.ts` | 75 |
| Types | `packages/shared/src/types.ts` | 233 |
| Migrations | `packages/server/src/db/migrations.ts` | 160 |
| Memory repo | `packages/server/src/db/memory-repo.ts` | 203 |
| Hybrid search | `packages/server/src/search/hybrid.ts` | 239 |
| Store tool | `packages/server/src/tools/memory-store.ts` | 86 |
| Cleanup tool | `packages/server/src/tools/memory-cleanup.ts` | 64 |
| Session end hook | `packages/hooks/src/handlers/session-end.ts` | 27 |
| Transcript parsing | `packages/hooks/src/lib/transcript-parser.ts` | 113 |

---

[STAGE:end:memory_schema_analysis]

