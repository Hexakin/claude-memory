import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { deriveProjectId, deriveProjectIdFromPath, normalizeGitUrl } from '@claude-memory/shared';

/**
 * Find the .git directory by walking up from cwd.
 * Handles both .git directory and .git file (worktrees).
 */
async function findGitRoot(cwd: string): Promise<string | null> {
  let current = cwd;

  while (current !== dirname(current)) {
    const gitPath = join(current, '.git');
    try {
      const stats = await stat(gitPath);
      if (stats.isDirectory() || stats.isFile()) {
        return gitPath;
      }
    } catch {
      // .git not found at this level, continue up
    }
    current = dirname(current);
  }

  return null;
}

/**
 * Parse git config file to extract remote origin URL.
 * Handles both .git directory and .git file (worktrees).
 */
async function parseGitRemoteUrl(gitPath: string): Promise<string | null> {
  try {
    // Check if .git is a file (worktree)
    const stats = await stat(gitPath);
    let configPath: string;

    if (stats.isFile()) {
      // .git file contains: gitdir: /path/to/worktree
      const gitFileContent = await readFile(gitPath, 'utf-8');
      const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        configPath = join(match[1].trim(), 'config');
      } else {
        return null;
      }
    } else {
      configPath = join(gitPath, 'config');
    }

    const configContent = await readFile(configPath, 'utf-8');

    // Parse [remote "origin"] section
    const remoteMatch = configContent.match(/\[remote "origin"\]([\s\S]*?)(?=\[|$)/);
    if (!remoteMatch) return null;

    const remoteSection = remoteMatch[1];
    const urlMatch = remoteSection.match(/url\s*=\s*(.+)/);
    if (!urlMatch) return null;

    return urlMatch[1].trim();
  } catch {
    return null;
  }
}

/**
 * Extract repository name from git URL.
 * Examples:
 * - https://github.com/Hexakin/claude-memory.git → claude-memory
 * - git@github.com:Hexakin/claude-memory.git → claude-memory
 * - /path/to/repo.git → repo
 */
function extractRepoName(url: string): string | null {
  try {
    // Remove .git suffix
    const withoutGit = url.replace(/\.git$/, '');

    // Extract last path component
    const parts = withoutGit.split(/[/\\:]/);
    const lastPart = parts[parts.length - 1];

    return lastPart || null;
  } catch {
    return null;
  }
}

/**
 * Detect project ID and name from git remote URL in the given directory.
 * Falls back to path-based derivation if no git remote found.
 */
export async function detectProject(cwd: string): Promise<{ projectId: string; projectName: string | null }> {
  const gitPath = await findGitRoot(cwd);

  if (gitPath) {
    const remoteUrl = await parseGitRemoteUrl(gitPath);
    if (remoteUrl) {
      const normalizedUrl = normalizeGitUrl(remoteUrl);
      return {
        projectId: deriveProjectId(normalizedUrl),
        projectName: extractRepoName(remoteUrl),
      };
    }
  }

  // Fallback: use path-based derivation
  return {
    projectId: deriveProjectIdFromPath(cwd),
    projectName: null,
  };
}
