import { HOOK_TIMEOUT_MS, SESSION_END_TIMEOUT_MS } from '@claude-memory/shared';
import type { HookInput } from './types.js';
import { handleSessionStart } from './handlers/session-start.js';
import { handleSessionEnd } from './handlers/session-end.js';
import { createHookLogger } from './lib/logger.js';

const log = createHookLogger('cli');

async function main(): Promise<void> {
  let hookEvent = 'unknown';

  try {
    if (!process.env.CLAUDE_MEMORY_URL) {
      process.exit(0);
    }

    // Read stdin with its own error boundary
    let raw: string;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      raw = Buffer.concat(chunks).toString('utf-8');
    } catch (err) {
      log.error('Failed to read stdin', { error: String(err) });
      process.exit(0);
    }

    if (!raw.trim()) {
      process.exit(0);
    }

    let input: HookInput;
    try {
      input = JSON.parse(raw);
    } catch (err) {
      log.error('Failed to parse stdin JSON', { error: String(err), rawLength: raw.length });
      process.exit(0);
    }

    hookEvent = input.hook_event_name;
    log.info(`Hook started: ${hookEvent}`, { sessionId: input.session_id, cwd: input.cwd });

    switch (input.hook_event_name) {
      case 'SessionStart': {
        const timer = setTimeout(() => {
          log.warn('SessionStart timeout reached');
          process.exit(0);
        }, HOOK_TIMEOUT_MS);

        try {
          const result = await handleSessionStart(input);
          clearTimeout(timer);
          if (result.additionalContext) {
            process.stdout.write(JSON.stringify(result));
          }
        } catch (err) {
          clearTimeout(timer);
          log.error('SessionStart handler failed', { error: String(err) });
        }
        break;
      }
      case 'SessionEnd': {
        const timer = setTimeout(() => {
          log.warn('SessionEnd timeout reached');
          process.exit(0);
        }, SESSION_END_TIMEOUT_MS);

        try {
          await handleSessionEnd(input);
          clearTimeout(timer);
          log.info('SessionEnd completed successfully');
        } catch (err) {
          clearTimeout(timer);
          log.error('SessionEnd handler failed', { error: String(err) });
        }
        break;
      }
      default:
        log.warn(`Unknown hook event: ${input.hook_event_name}`);
        break;
    }
  } catch (err) {
    log.error(`Unhandled error in ${hookEvent}`, { error: String(err) });
  }
}

main().then(() => process.exit(0)).catch((err) => {
  try { log.error('Fatal error in main()', { error: String(err) }); } catch { /* never block exit */ }
  process.exit(0);
});
