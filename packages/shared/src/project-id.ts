import { createHash } from 'node:crypto';

/**
 * Normalize a git remote URL so that SSH and HTTPS variants
 * of the same repo produce the same ID.
 *
 * Examples:
 *   git@github.com:user/repo.git  -> https://github.com/user/repo
 *   https://github.com/user/repo  -> https://github.com/user/repo
 *   ssh://git@github.com/user/repo.git -> https://github.com/user/repo
 */
export function normalizeGitUrl(url: string): string {
  let normalized = url.trim();

  // Handle ssh:// prefix
  normalized = normalized.replace(/^ssh:\/\//, '');

  // Convert git@host:user/repo -> https://host/user/repo
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Ensure https:// prefix
  if (!normalized.startsWith('https://') && !normalized.startsWith('http://')) {
    normalized = `https://${normalized}`;
  }

  // Strip trailing .git
  normalized = normalized.replace(/\.git$/, '');

  // Strip trailing slash
  normalized = normalized.replace(/\/$/, '');

  // Lowercase the hostname (not the path — repo names can be case-sensitive on some hosts)
  try {
    const parsed = new URL(normalized);
    parsed.hostname = parsed.hostname.toLowerCase();
    normalized = parsed.toString().replace(/\/$/, '');
  } catch {
    // If URL parsing fails, just lowercase the whole thing
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

/**
 * Derive a project ID from a git remote URL.
 * Returns first 16 hex chars of SHA-256 hash of the normalized URL.
 */
export function deriveProjectId(gitRemoteUrl: string): string {
  const normalized = normalizeGitUrl(gitRemoteUrl);
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.substring(0, 16);
}

/**
 * Fallback: derive a project ID from a folder path.
 * Used when the directory is not a git repo.
 */
export function deriveProjectIdFromPath(folderPath: string): string {
  // Normalize path separators and trailing slashes
  const normalized = folderPath.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return hash.substring(0, 16);
}
