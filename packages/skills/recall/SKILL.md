---
name: recall
description: Search Claude's persistent memory for relevant context. Use when user wants to find previously stored information.
---

# /recall

Search Claude's persistent memory.

Usage: /recall <query>

## Behavior
1. Parse the query after "/recall"
2. Detect current project context (derive project ID from git remote)
3. Call `mcp__claude-memory__memory_search` with:
   - query: the user's search query
   - scope: "all" (searches both project-scoped and global memories)
   - project: detected project ID
   - maxResults: 10
   - minScore: 0.3
4. Display results formatted as:
   - Score (relevance percentage)
   - Content (truncated to ~200 chars if long)
   - Tags
   - Source and creation date
5. If no results found, suggest broadening the query

## Output Format
For each result, display:
```
[{score}%] {content_preview}
  Tags: {tags}  |  Source: {source}  |  Stored: {createdAt}
```

## Examples
- `/recall coding conventions` → returns stored conventions
- `/recall auth` → returns authentication-related memories
- `/recall what database` → returns database-related memories
