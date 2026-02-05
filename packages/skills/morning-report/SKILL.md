---
name: morning-report
description: See results of overnight automation tasks. Shows what completed, failed, and needs attention.
---

# /morning-report

See results of overnight automation.

Usage: /morning-report [since]

## Behavior
1. Determine the "since" date:
   - If provided: use that date (ISO format)
   - If not: use yesterday at midnight (covers overnight window)
2. Call `mcp__claude-memory__task_results` with:
   - since: determined date
   - limit: 50
3. Format results as a summary report:

### Report Format

**Header:**
```
# Morning Report — {date}
{completed_count} completed | {failed_count} failed | {total_cost} USD total
```

**Per-task detail:**
```
## [{status_emoji}] {task_description}
- **Status:** {success/failed}
- **Duration:** {duration}
- **Tokens:** {tokens_used} (~${cost_usd})
- **Summary:** {result_summary}
{if failed: **Error:** {error_message}}
```

Where status_emoji is "PASS" for success and "FAIL" for failure.

4. If no results, indicate that no overnight tasks ran

## Examples
- `/morning-report` → shows last night's results
- `/morning-report 2025-01-10` → shows results since Jan 10
