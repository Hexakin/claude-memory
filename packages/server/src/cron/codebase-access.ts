import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

interface CloneOptions {
  branch?: string;
  token?: string;
}

/**
 * Shallow-clone a git repository into the target directory.
 * Returns the target directory path on success.
 */
export async function cloneRepo(
  repoUrl: string,
  targetDir: string,
  options?: CloneOptions,
): Promise<string> {
  let url = repoUrl;

  // Inject auth token into HTTPS URL if provided
  if (options?.token && url.startsWith('https://')) {
    const parsed = new URL(url);
    parsed.username = options.token;
    url = parsed.toString();
  }

  const args = ['clone', '--depth', '1'];

  if (options?.branch) {
    args.push('--branch', options.branch);
  }

  args.push(url, targetDir);

  await execFileAsync('git', args, {
    timeout: 120_000, // 2 minute timeout for clone
  });

  return targetDir;
}

/**
 * Remove a cloned repository directory.
 */
export async function cleanupClone(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Create a temporary directory with the given prefix.
 * Returns the path to the created directory.
 */
export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
