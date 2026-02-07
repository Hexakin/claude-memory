# Memory Enhancement Roadmap

**Context:** Analysis of missing cross-conversation intelligence features
**Date:** 2026-02-07
**Audience:** Engineers implementing memory improvements

---

## Problem Statement

Current memory system stores and retrieves facts but lacks **semantic organization** for intelligent cross-conversation reasoning. Memories are treated as interchangeable units, preventing:

- Smart retention (keeping important memories, pruning irrelevant ones)
- Type-specific policies (e.g., preferences last forever, session context expires)
- Relationship reasoning ("this contradicts what we learned earlier")
- Temporal awareness ("this was relevant 3 sessions ago, not now")
- Deduplication ("we already stored this preference")

---

## Gap Analysis

### Gap 1: No Memory Typing (BLOCKER)

**Current:** All memories equal. Source only tracks HOW it was created, not WHAT it is.

**What's Missing:**
```typescript
// Current
type MemorySource = 'user' | 'session-summary' | 'automation' | 'hook';

// Needed
type MemoryType =
  | 'preference'      // User choice (e.g., "prefer Opus")
  | 'learning'        // Discovered pattern (e.g., "webpack config X works")
  | 'objective'       // Current goal (e.g., "finish auth refactor")
  | 'context'         // Session/project context (e.g., "working on UI")
  | 'history'         // What happened (e.g., "fixed bug in X")
  | 'constraint'      // Limitation (e.g., "Node 18+ required")
  | 'decision'        // Why we chose something (e.g., "BCrypt = OWASP")
  | 'relationship';   // Links between entities (e.g., "A calls B")
```

**Impact:**
- 🟢 Enables type-specific TTLs
- 🟢 Allows type-specific search scoring
- 🟢 Enables duplicate detection per type
- 🟢 Supports type-aware cleanup policies

**Implementation Steps:**
1. Add `type` column to memories table
2. Extend `Memory` interface with `type` field
3. Update `memoryStoreSchema` to accept `type` parameter
4. Add validation: only valid types accepted
5. Update search to filter/score by type
6. Backfill existing memories with type='history' (safe default)

**Effort:** ~100 lines across schemas, migrations, types

**Blockers for:** Gap 2, Gap 3, Gap 6

---

### Gap 2: No Deduplication (QUALITY)

**Current:** Identical or near-identical memories stored separately, causing:
- 40–60% storage waste on mature systems
- Search latency (more chunks to process)
- User confusion (redundant results)

**What's Missing:**
```sql
-- New column
ALTER TABLE memories ADD COLUMN content_hash TEXT;
CREATE INDEX idx_memories_content_hash ON memories(content_hash);

-- Detection logic on store
IF EXISTS(SELECT 1 FROM memories WHERE content_hash = ? AND type = ?)
  THEN UPDATE last_accessed_at, increment access_count
  ELSE INSERT new memory
```

**Deduplication Strategy:**

| Strategy | Pros | Cons | Effort |
|----------|------|------|--------|
| **Exact hash** | Fast, deterministic | Only catches identical text | Low (10 lines) |
| **Vector similarity** | Catches paraphrases | Slow, false positives | Medium (50 lines) |
| **Fuzzy match** | Human-like | Tuning required | Medium (40 lines) |
| **Combined** | Best precision | Complex logic | High (150 lines) |

**Recommended:** Start with exact hash, add vector similarity for `preference` type

**Implementation Steps:**
1. Add `content_hash` column (SHA256 of normalized text)
2. Compute hash on store
3. Check existing hashes
4. If found: update timestamps (treat as "re-stated")
5. If not found: proceed with normal insert

**Effort:** ~50 lines

**Depends on:** Gap 1 (needs type to handle duplicates smartly)

---

### Gap 3: No TTL/Auto-Expiration (MAINTENANCE)

**Current:** All memories persist indefinitely, causing:
- Stale context (month-old "current objective" treated as relevant)
- Storage growth
- Search confusion (old + new memories mixed)

**What's Missing:**
```typescript
// Memory type → Default TTL mapping
const DEFAULT_TTLS: Record<MemoryType, number | null> = {
  'preference': null,        // ∞ (never expires)
  'learning': null,          // ∞ (valuable forever)
  'objective': 30 * 24 * 60 * 60 * 1000,  // 30 days
  'context': 7 * 24 * 60 * 60 * 1000,     // 7 days
  'history': 60 * 24 * 60 * 60 * 1000,    // 60 days
  'constraint': null,        // ∞
  'decision': null,          // ∞
  'relationship': null,      // ∞
};
```

**Implementation Steps:**
1. Add `expires_at` column (nullable)
2. On store: calculate `expires_at = now + DEFAULT_TTLS[type]`
3. Add cron job: run daily, delete where `expires_at < now`
4. Optional: soft-delete (mark as inactive, archive)
5. Add `memory_cleanup` tool parameter: type-specific TTLs

**Effort:** ~150 lines (schema + cron + cleanup logic)

**Depends on:** Gap 1 (needs type to determine TTL)

---

### Gap 4: No Relationship Tracking (REASONING)

**Current:** Memories are atomic. Can't express:
- "This learning derives from that experiment"
- "This contradicts what we learned earlier"
- "This supersedes that decision"
- "This is related to that memory"

**What's Missing:**
```sql
CREATE TABLE memory_links (
  source_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL, -- enum
  created_at TEXT DEFAULT now(),
  PRIMARY KEY (source_id, target_id, relationship_type)
);

-- Types
type RelationshipType =
  | 'derives_from'     -- Result of another memory
  | 'contradicts'      -- Opposite of another
  | 'supersedes'       -- Replaces another
  | 'relates_to'       -- Thematically linked
  | 'chain'            -- Part of reasoning chain
  | 'references';      -- Mentions another
```

**Use Cases:**
1. **Contradiction detection:** "Prefer Sonnet" + "Always use Opus" → warning
2. **Context chains:** Follow "chain" links to understand reasoning
3. **Memory merging:** "supersedes" suggests consolidation
4. **Dependency tracking:** Find memories that depend on a deleted memory

**Implementation Steps:**
1. Create `memory_links` junction table
2. Extend `Memory` interface with `relatedMemories?: Link[]`
3. Add `memory_link` tool (create relationship)
4. Update search: optionally traverse links
5. Add cleanup: cascade handling for linked memories

**Effort:** ~200 lines (schema, queries, tools)

**Depends on:** None (but complements Gap 1)

---

### Gap 5: No Recency Bias in Search (RELEVANCE)

**Current:** Search doesn't favor recent memories. A 6-month-old memory scores same as today's.

**What's Missing:**
```typescript
// Time-decay factor
function getRecencyScore(createdAt: string, now = Date.now()): number {
  const ageMs = now - new Date(createdAt).getTime();
  const ageMonths = ageMs / (30 * 24 * 60 * 60 * 1000);

  // Older = lower score, maxed at 1 month
  const clampedAge = Math.min(ageMonths, 1);
  return 1.0 - (0.5 * clampedAge); // 0.5–1.0 range
}

// Integrate into hybrid search
finalScore = baseHybridScore * getRecencyScore(memory.createdAt);
```

**Impact:**
- 🟢 SessionStart memories prioritized (from today)
- 🟢 "Current objective" (recent) beats "old note"
- 🟢 Prevents "memory bloat" (old memories deprioritized)

**Implementation Steps:**
1. Calculate recency factor in search
2. Multiply final hybrid score by recency factor
3. Make weight tunable (default: 0.5 multiplier)
4. Document in search algorithm comments
5. Test with historical memories

**Effort:** ~30 lines

**Depends on:** None (can be added independently)

---

### Gap 6: No Metadata Schema Validation (STRUCTURE)

**Current:** Metadata is unstructured JSON, no validation.

**What's Missing:**
```typescript
// Per-type metadata schemas
const METADATA_SCHEMAS: Record<MemoryType, ZodSchema> = {
  'preference': z.object({
    domain: z.string().optional(),      // e.g., "model", "workflow"
    weight: z.number().min(0).max(1).optional(), // Confidence
    alternatives: z.array(z.string()).optional(),
  }),
  'learning': z.object({
    language: z.string().optional(),    // e.g., "typescript"
    tool: z.string().optional(),        // e.g., "webpack"
    applied: z.boolean().optional(),    // Tested?
  }),
  'objective': z.object({
    deadline: z.string().optional(),    // ISO date
    status: z.enum(['pending', 'in-progress', 'blocked', 'done']).optional(),
    blockers: z.array(z.string()).optional(),
  }),
  // ... etc
};

// Validate on store
const schema = METADATA_SCHEMAS[type];
const validMetadata = schema.parse(input.metadata);
```

**Impact:**
- 🟢 Enables structured queries ("all preferences about models")
- 🟢 Prevents garbage metadata
- 🟢 Improves data quality for analysis

**Implementation Steps:**
1. Define metadata schema per type
2. Validate on store (throw if invalid)
3. Add tool option: `validateMetadata: boolean` (default: false, for backward compat)
4. Document metadata shape for each type
5. Provide examples in tool docs

**Effort:** ~150 lines (schemas + validation)

**Depends on:** Gap 1 (needs type)

---

### Gap 7: No Contradiction Detection (SAFETY)

**Current:** System allows storing "prefer Sonnet" and "always use Opus" without warning.

**What's Missing:**
```typescript
// On store: detect contradictions
async function detectContradictions(
  db: Database,
  newMemory: Memory,
  similarMemories: MemorySearchResult[]
): Promise<Contradiction[]> {

  if (newMemory.type !== 'preference') return [];

  const contradictions: Contradiction[] = [];

  for (const existing of similarMemories) {
    if (existing.type !== 'preference') continue;

    // Check if preference domain is same
    const newDomain = newMemory.metadata.domain;
    const existingDomain = existing.metadata.domain;

    if (newDomain === existingDomain) {
      // Same domain = possible contradiction
      const similarity = cosineSimilarity(
        await embed(newMemory.content),
        await embed(existing.content)
      );

      if (similarity > 0.8) {
        contradictions.push({
          existingMemoryId: existing.id,
          similarity,
          recommendation: 'merge' | 'warning' | 'ignore'
        });
      }
    }
  }

  return contradictions;
}
```

**Impact:**
- 🟢 Prevents conflicting preferences
- 🟢 Alerts user to inconsistencies
- 🟢 Helps with memory debugging

**Implementation Steps:**
1. Implement similarity detection for preferences
2. On store: check for contradictions
3. Return warning in response (non-blocking)
4. Add tool parameter: `detectContradictions: boolean`
5. Log contradictions for user review

**Effort:** ~100 lines

**Depends on:** Gap 1 (needs type = 'preference')

---

## Implementation Sequence

**Recommended order (respects dependencies):**

```
Phase 1 (Foundation)
├─ Gap 1: Add MemoryType enum
├─ Gap 6: Add metadata validation per type
└─ Migration: Backfill existing memories with type='history'

Phase 2 (Quality)
├─ Gap 2: Add content_hash + deduplication
├─ Gap 7: Add contradiction detection
└─ Test: Verify dedup logic with large sample

Phase 3 (Intelligence)
├─ Gap 3: Add TTL + auto-cleanup
├─ Gap 4: Add memory_links relationship tracking
└─ Gap 5: Add recency bias to search

Phase 4 (Optimization)
├─ Performance testing
├─ Schema indexing
└─ Documentation
```

**Critical path:** Gap 1 → {Gap 2, Gap 6, Gap 7} → Gap 3 → Gap 4, Gap 5

---

## Code Location Reference

| Gap | Primary Files | Changes |
|-----|---------------|---------|
| Gap 1 | `packages/shared/src/{schemas,types}.ts`, `packages/server/src/db/migrations.ts` | +100 lines |
| Gap 2 | `packages/server/src/tools/memory-store.ts`, `packages/server/src/db/memory-repo.ts` | +50 lines |
| Gap 3 | `packages/server/src/tools/memory-cleanup.ts`, `packages/server/src/cron/scheduler.ts` | +150 lines |
| Gap 4 | `packages/server/src/db/memory-repo.ts`, `packages/server/src/tools/` | +200 lines |
| Gap 5 | `packages/server/src/search/hybrid.ts` | +30 lines |
| Gap 6 | `packages/shared/src/schemas.ts`, `packages/server/src/tools/memory-store.ts` | +150 lines |
| Gap 7 | `packages/server/src/tools/memory-store.ts` | +100 lines |

---

## Success Metrics

After implementing all gaps:

✅ **No duplicate memories** — Content hash dedup + vector similarity checks
✅ **Smart retention** — Type-specific TTLs reduce stale data
✅ **Type-aware search** — Preferences ranked differently from history
✅ **Relationship reasoning** — Can trace memory dependencies
✅ **Contradiction safety** — Warns on conflicting preferences
✅ **Temporal relevance** — Recent memories prioritized
✅ **Data quality** — Metadata validated per type

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| **Backfill fails** | Write tests first, do in transaction, rollback available |
| **Dedup too aggressive** | Start with exact hash only, monitor for false positives |
| **TTL deletes valuable data** | Make TTLs configurable, offer soft-delete first |
| **Performance impact** | Index all new columns, profile search latency |
| **Breaking changes** | Make type optional initially, default to 'history' |

---

## Related Documents

- **Full Analysis:** `MEMORY_SCHEMA_ANALYSIS.md`
- **Quick Summary:** `.omc/scientist/memory_schema_summary.md`
- **Code:** `packages/shared/src/schemas.ts`, `packages/server/src/db/`

