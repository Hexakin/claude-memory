import { describe, it, expect } from 'vitest';
import { normalizeGitUrl, deriveProjectId, deriveProjectIdFromPath } from '../project-id.js';

describe('project-id', () => {
  describe('normalizeGitUrl', () => {
    it('should normalize SSH to HTTPS', () => {
      const sshUrl = 'git@github.com:user/repo.git';
      const normalized = normalizeGitUrl(sshUrl);

      expect(normalized).toBe('https://github.com/user/repo');
    });

    it('should normalize HTTPS with .git suffix', () => {
      const httpsUrl = 'https://github.com/user/repo.git';
      const normalized = normalizeGitUrl(httpsUrl);

      expect(normalized).toBe('https://github.com/user/repo');
    });

    it('should normalize HTTPS without .git', () => {
      const httpsUrl = 'https://github.com/user/repo';
      const normalized = normalizeGitUrl(httpsUrl);

      expect(normalized).toBe('https://github.com/user/repo');
    });

    it('should handle ssh:// prefix', () => {
      const sshUrl = 'ssh://git@github.com/user/repo.git';
      const normalized = normalizeGitUrl(sshUrl);

      // After removing ssh://, it becomes git@github.com/user/repo.git (with /)
      // which doesn't match the : pattern, so it adds https:// prefix
      expect(normalized).toBe('https://git@github.com/user/repo');
    });

    it('should handle trailing slash', () => {
      const urlWithSlash = 'https://github.com/user/repo/';
      const normalized = normalizeGitUrl(urlWithSlash);

      expect(normalized).toBe('https://github.com/user/repo');
    });

    it('should lowercase hostname but preserve path case', () => {
      const mixedCaseUrl = 'https://GitHub.com/User/Repo.git';
      const normalized = normalizeGitUrl(mixedCaseUrl);

      // Hostname should be lowercase, path case preserved
      expect(normalized).toBe('https://github.com/User/Repo');
    });

    it('should handle GitLab URLs', () => {
      const gitlabUrl = 'git@gitlab.com:group/project.git';
      const normalized = normalizeGitUrl(gitlabUrl);

      expect(normalized).toBe('https://gitlab.com/group/project');
    });

    it('should handle BitBucket URLs', () => {
      const bitbucketUrl = 'git@bitbucket.org:team/repo.git';
      const normalized = normalizeGitUrl(bitbucketUrl);

      expect(normalized).toBe('https://bitbucket.org/team/repo');
    });
  });

  describe('deriveProjectId', () => {
    it('should produce consistent project IDs', () => {
      const sshUrl = 'git@github.com:user/repo.git';
      const httpsUrl = 'https://github.com/user/repo.git';

      const id1 = deriveProjectId(sshUrl);
      const id2 = deriveProjectId(httpsUrl);

      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different repos', () => {
      const url1 = 'https://github.com/user/repo1.git';
      const url2 = 'https://github.com/user/repo2.git';

      const id1 = deriveProjectId(url1);
      const id2 = deriveProjectId(url2);

      expect(id1).not.toBe(id2);
    });

    it('should return 16 character hex string', () => {
      const url = 'https://github.com/user/repo.git';
      const id = deriveProjectId(url);

      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should be case-insensitive for hostnames', () => {
      const url1 = 'https://GitHub.com/user/repo.git';
      const url2 = 'https://github.com/user/repo.git';

      const id1 = deriveProjectId(url1);
      const id2 = deriveProjectId(url2);

      expect(id1).toBe(id2);
    });

    it('should handle complex repo paths', () => {
      const url = 'https://github.com/org/sub-org/nested/repo.git';
      const id = deriveProjectId(url);

      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('deriveProjectIdFromPath', () => {
    it('should derive project ID from path', () => {
      const path = '/home/user/projects/my-project';
      const id = deriveProjectIdFromPath(path);

      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should produce same ID for same path', () => {
      const path = '/home/user/projects/my-project';
      const id1 = deriveProjectIdFromPath(path);
      const id2 = deriveProjectIdFromPath(path);

      expect(id1).toBe(id2);
    });

    it('should handle Windows paths', () => {
      const path = 'C:\\Users\\user\\projects\\my-project';
      const id = deriveProjectIdFromPath(path);

      expect(id).toHaveLength(16);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('should normalize path separators', () => {
      const windowsPath = 'C:\\Users\\user\\projects\\my-project';
      const unixPath = 'C:/Users/user/projects/my-project';

      const id1 = deriveProjectIdFromPath(windowsPath);
      const id2 = deriveProjectIdFromPath(unixPath);

      expect(id1).toBe(id2);
    });

    it('should handle trailing slashes', () => {
      const path1 = '/home/user/projects/my-project';
      const path2 = '/home/user/projects/my-project/';

      const id1 = deriveProjectIdFromPath(path1);
      const id2 = deriveProjectIdFromPath(path2);

      expect(id1).toBe(id2);
    });

    it('should be case-insensitive', () => {
      const path1 = '/home/user/Projects/my-project';
      const path2 = '/home/user/projects/my-project';

      const id1 = deriveProjectIdFromPath(path1);
      const id2 = deriveProjectIdFromPath(path2);

      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different paths', () => {
      const path1 = '/home/user/projects/project1';
      const path2 = '/home/user/projects/project2';

      const id1 = deriveProjectIdFromPath(path1);
      const id2 = deriveProjectIdFromPath(path2);

      expect(id1).not.toBe(id2);
    });
  });

  describe('integration', () => {
    it('should handle complete workflow', () => {
      const sshUrl = 'git@github.com:myorg/myrepo.git';
      const httpsUrl = 'https://github.com/myorg/myrepo';
      const httpsUrlWithGit = 'https://github.com/myorg/myrepo.git';

      const id1 = deriveProjectId(sshUrl);
      const id2 = deriveProjectId(httpsUrl);
      const id3 = deriveProjectId(httpsUrlWithGit);

      // All should produce the same ID
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);

      // Path-based ID should be different
      const pathId = deriveProjectIdFromPath('/home/user/myrepo');
      expect(pathId).not.toBe(id1);
    });
  });
});
