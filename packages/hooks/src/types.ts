/** JSON received on stdin from Claude Code hooks */
export interface HookInput {
  hook_event_name: 'SessionStart' | 'SessionEnd';
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  source?: string;
  model?: string;
  reason?: string; // SessionEnd only: 'clear', 'logout', 'prompt_input_exit', etc.
}

/** JSON output to stdout for SessionStart hooks */
export interface SessionStartOutput {
  additionalContext?: string;
}

/** Parsed transcript message */
export interface TranscriptMessage {
  role: string;
  content: string;
}

/** Memory client configuration */
export interface MemoryClientConfig {
  serverUrl: string;
  authToken: string;
  timeoutMs: number;
}
