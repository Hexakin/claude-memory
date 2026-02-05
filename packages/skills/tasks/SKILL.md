---
name: tasks
description: Manage overnight automation tasks. Add, list, or cancel tasks for background execution.
---

# /tasks

Manage overnight automation tasks.

Usage:
  /tasks add <description>     — Queue a new task
  /tasks list [status]         — Show tasks (default: all)
  /tasks cancel <id>           — Cancel a pending task
  /tasks results [since]       — Show completed task results

## Behavior

### /tasks add <description>
1. Parse the task description
2. Auto-detect task type from description:
   - Contains "review" or "PR" → type: "code-review"
   - Contains "test" or "coverage" → type: "test-runner"
   - Contains "doc" or "readme" → type: "doc-updater"
   - Contains "refactor" → type: "refactor"
   - Otherwise → type: "custom"
3. Detect current project context
4. Call `mcp__claude-memory__task_add` with:
   - description: the user's input
   - type: auto-detected type
   - project: detected project ID
   - repoUrl: current git remote URL (if available)
5. Confirm the task was queued with its ID and scheduled time

### /tasks list [status]
1. Call `mcp__claude-memory__task_list` with:
   - status: provided status or "all"
   - limit: 20
2. Display tasks formatted as a table:
   | ID | Type | Status | Description | Created |

### /tasks cancel <id>
1. Call `mcp__claude-memory__task_cancel` with:
   - id: the provided task ID
2. Confirm cancellation or report that the task couldn't be cancelled (already running/completed)

### /tasks results [since]
1. Call `mcp__claude-memory__task_results` with:
   - since: provided date or yesterday's date (ISO format)
   - limit: 10
2. Display results with summary, success/fail status, duration, and cost

## Examples
- `/tasks add review the authentication module for security issues`
- `/tasks list pending`
- `/tasks cancel abc123`
- `/tasks results 2025-01-15`
