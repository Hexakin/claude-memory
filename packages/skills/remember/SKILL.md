---
name: remember
description: Store something in Claude's persistent memory. Use when user wants to save preferences, conventions, or decisions.
---

# /remember

Store something in Claude's persistent memory.

Usage: /remember <text>

## Behavior
1. Parse the text after "/remember"
2. Detect project context (auto-derive project ID from current git remote using SHA-256 of normalized URL)
3. Call `mcp__claude-memory__memory_store` with:
   - text: the user's input
   - source: "user"
   - project: detected project ID (or null for global)
   - tags: auto-detect from content (e.g., "convention", "architecture", "preference", "debugging", "decision")
4. Confirm what was stored and how many chunks it produced

## Tag Detection Guidelines
- Code style/linting preferences → "convention"
- Architecture decisions → "architecture", "decision"
- Debugging findings → "debugging"
- Tool/library preferences → "preference"
- Team/people info → "team"
- Deployment/infra → "infrastructure"

## Examples
- `/remember always use pnpm in this project` → tags: ["convention", "preference"]
- `/remember the auth service uses JWT with RS256` → tags: ["architecture", "decision"]
- `/remember fix for OOM: increase Node heap to 4GB` → tags: ["debugging"]
