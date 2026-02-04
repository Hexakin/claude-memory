import { HOOK_TIMEOUT_MS } from '@claude-memory/shared';
import type { HookInput } from './types.js';
import { handleSessionStart } from './handlers/session-start.js';
import { handleSessionEnd } from './handlers/session-end.js';

async function main(): Promise<void> {
  // Global timeout - never block Claude Code
  const timer = setTimeout(() => process.exit(0), HOOK_TIMEOUT_MS);

  try {
    // Skip if not configured
    if (!process.env.CLAUDE_MEMORY_URL) {
      process.exit(0);
    }

    // Read stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8');

    if (!raw.trim()) {
      process.exit(0);
    }

    const input: HookInput = JSON.parse(raw);

    switch (input.hook_event_name) {
      case 'SessionStart': {
        const result = await handleSessionStart(input);
        if (result.additionalContext) {
          process.stdout.write(JSON.stringify(result));
        }
        break;
      }
      case 'SessionEnd': {
        await handleSessionEnd(input);
        break;
      }
      default:
        // Unknown event, ignore silently
        break;
    }
  } catch {
    // Never fail - exit cleanly on any error
  } finally {
    clearTimeout(timer);
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(0));
