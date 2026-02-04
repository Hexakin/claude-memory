import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProject } from '../lib/project-detect.js';

describe('project-detect', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `project-detect-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('detectProject', () => {
    it('detects project from a real git directory', async () => {
      const realGitRepo = 'C:\\Users\\t4nk3\\Documents\\GitHub\\claude-memory';
      const result = await detectProject(realGitRepo);

      expect(result).toBeDefined();
      expect(result.projectId).toBeDefined();
      expect(typeof result.projectId).toBe('string');
      expect(result.projectName).toBeDefined();
    });

    it('returns a projectId string of 16 hex chars', async () => {
      const realGitRepo = 'C:\\Users\\t4nk3\\Documents\\GitHub\\claude-memory';
      const result = await detectProject(realGitRepo);

      expect(result.projectId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns projectName extracted from URL', async () => {
      const realGitRepo = 'C:\\Users\\t4nk3\\Documents\\GitHub\\claude-memory';
      const result = await detectProject(realGitRepo);

      expect(result.projectName).toBe('claude-memory');
    });

    it('falls back to path-based ID for non-git directories', async () => {
      const result = await detectProject(tempDir);

      expect(result).toBeDefined();
      expect(result.projectId).toBeDefined();
      expect(typeof result.projectId).toBe('string');
      expect(result.projectId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns null projectName for non-git directories', async () => {
      const result = await detectProject(tempDir);

      expect(result.projectName).toBeNull();
    });

    it('handles git directory without remote', async () => {
      const gitDir = join(tempDir, '.git');
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');

      const result = await detectProject(tempDir);

      expect(result).toBeDefined();
      expect(result.projectId).toMatch(/^[0-9a-f]{16}$/);
      expect(result.projectName).toBeNull();
    });

    it('extracts project name from SSH git URLs', async () => {
      const gitDir = join(tempDir, '.git');
      await mkdir(gitDir, { recursive: true });
      const gitConfig = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:user/my-project.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
      await writeFile(join(gitDir, 'config'), gitConfig);

      const result = await detectProject(tempDir);

      expect(result.projectName).toBe('my-project');
    });

    it('extracts project name from HTTPS git URLs', async () => {
      const gitDir = join(tempDir, '.git');
      await mkdir(gitDir, { recursive: true });
      const gitConfig = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/user/another-project.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`;
      await writeFile(join(gitDir, 'config'), gitConfig);

      const result = await detectProject(tempDir);

      expect(result.projectName).toBe('another-project');
    });
  });
});
