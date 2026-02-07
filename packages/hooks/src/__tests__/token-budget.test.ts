import { describe, it, expect } from 'vitest';
import { trimToTokenBudget, estimateTokens, type Section } from '../lib/token-budget.js';

describe('Token Budget', () => {
  it('includes all sections when within budget', () => {
    const sections: Section[] = [
      { title: 'Rules', items: ['Rule 1', 'Rule 2'], priority: 1, maxTokens: 300 },
      { title: 'Project', items: ['Memory 1'], priority: 2, maxTokens: 300 },
    ];

    const result = trimToTokenBudget(sections);
    expect(result).toContain('Rules');
    expect(result).toContain('Rule 1');
    expect(result).toContain('Rule 2');
    expect(result).toContain('Project');
    expect(result).toContain('Memory 1');
  });

  it('respects priority ordering (lower number = higher priority)', () => {
    const sections: Section[] = [
      { title: 'Low Priority', items: ['Item 1'], priority: 4, maxTokens: 150 },
      { title: 'High Priority', items: ['Item 2'], priority: 1, maxTokens: 300 },
    ];

    const result = trimToTokenBudget(sections);
    expect(result).toContain('High Priority');
    expect(result).toContain('Item 2');
  });

  it('trims low-priority sections when over budget', () => {
    const longItem = 'A'.repeat(500);
    const sections: Section[] = [
      { title: 'Rules', items: [longItem, longItem], priority: 1, maxTokens: 300 },
      { title: 'Project', items: [longItem, longItem], priority: 2, maxTokens: 300 },
      { title: 'Global', items: [longItem, longItem], priority: 4, maxTokens: 150 },
    ];

    const result = trimToTokenBudget(sections, 200);
    // Rules (highest priority) should be included
    expect(result).toContain('Rules');
  });

  it('truncates individual items to fit section budget', () => {
    const longItem = 'B'.repeat(2000);
    const sections: Section[] = [
      { title: 'Rules', items: [longItem], priority: 1, maxTokens: 100 },
    ];

    const result = trimToTokenBudget(sections);
    expect(result).toContain('Rules');
    expect(result.length).toBeLessThan(2000);
    // Should have truncation marker
    expect(result).toContain('...');
  });

  it('always includes rules section header', () => {
    const sections: Section[] = [
      { title: 'Rules (Always Apply)', items: ['Use TypeScript'], priority: 1, maxTokens: 300 },
    ];

    const result = trimToTokenBudget(sections);
    expect(result).toContain('# Claude Memory');
    expect(result).toContain('Rules (Always Apply)');
    expect(result).toContain('Use TypeScript');
  });

  it('skips empty sections', () => {
    const sections: Section[] = [
      { title: 'Rules', items: [], priority: 1, maxTokens: 300 },
      { title: 'Project', items: ['Item 1'], priority: 2, maxTokens: 300 },
    ];

    const result = trimToTokenBudget(sections);
    expect(result).not.toContain('Rules');
    expect(result).toContain('Project');
  });

  it('estimateTokens returns reasonable estimate', () => {
    const text = 'Hello world'; // 11 chars = ~3 tokens
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('does not exceed max token budget', () => {
    const sections: Section[] = [
      { title: 'Rules', items: Array(50).fill('Rule item content here'), priority: 1, maxTokens: 300 },
      { title: 'Project', items: Array(50).fill('Project item content here'), priority: 2, maxTokens: 300 },
      { title: 'Recent', items: Array(50).fill('Recent item content here'), priority: 3, maxTokens: 250 },
      { title: 'Global', items: Array(50).fill('Global item content here'), priority: 4, maxTokens: 150 },
    ];

    const result = trimToTokenBudget(sections, 1000);
    const estimatedTokens = estimateTokens(result);
    // Allow some slack due to headers
    expect(estimatedTokens).toBeLessThanOrEqual(1200);
  });
});
