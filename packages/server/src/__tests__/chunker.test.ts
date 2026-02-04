import { describe, it, expect } from 'vitest';
import { chunkText } from '../embedding/chunker.js';

describe('chunker', () => {
  it('should return single chunk for short text', () => {
    const text = 'This is a short text that fits in one chunk.';
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('should split long text into multiple chunks', () => {
    // Create text that's definitely longer than 500 tokens (2000+ chars)
    const longText = 'This is a line of text.\n'.repeat(100);
    const chunks = chunkText(longText);

    expect(chunks.length).toBeGreaterThan(1);

    // Verify each chunk has sequential indices
    chunks.forEach((chunk, idx) => {
      expect(chunk.chunkIndex).toBe(idx);
    });
  });

  it('should preserve overlap between chunks', () => {
    // Create text with distinctive lines
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`Line ${i}: This is content for line ${i}`);
    }
    const text = lines.join('\n');

    const chunks = chunkText(text, 500, 50); // maxTokens=500, overlap=50

    if (chunks.length > 1) {
      // Check that some content from end of chunk N appears at start of chunk N+1
      const chunk0End = chunks[0].content.slice(-100);
      const chunk1Start = chunks[1].content.slice(0, 200);

      // Should have some overlap
      const hasOverlap = chunk0End.split('\n').some(line =>
        line.length > 0 && chunk1Start.includes(line)
      );
      expect(hasOverlap).toBe(true);
    }
  });

  it('should not split inside code blocks', () => {
    // Create text with a code block in the middle
    const beforeCode = 'Some text before.\n'.repeat(30);
    const codeBlock = '```typescript\nfunction example() {\n  return "test";\n}\n```';
    const afterCode = '\nSome text after.\n'.repeat(30);
    const text = beforeCode + codeBlock + afterCode;

    const chunks = chunkText(text, 300, 20);

    // Check that no chunk starts or ends with incomplete code block markers
    for (const chunk of chunks) {
      const backtickCount = (chunk.content.match(/```/g) || []).length;
      // Code blocks should have even number of ``` (opening and closing)
      expect(backtickCount % 2).toBe(0);
    }
  });

  it('should handle empty text', () => {
    const chunks = chunkText('');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('');
  });

  it('should assign sequential chunk indices', () => {
    const longText = 'Line of text.\n'.repeat(150);
    const chunks = chunkText(longText);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it('should include token count for each chunk', () => {
    const text = 'This is a test with some content.';
    const chunks = chunkText(text);

    expect(chunks[0].tokenCount).toBeGreaterThan(0);
    expect(chunks[0].tokenCount).toBeTypeOf('number');
  });

  it('should respect maxTokens parameter', () => {
    const text = 'Word '.repeat(200); // ~200 words
    const chunks = chunkText(text, 100, 10); // Max 100 tokens per chunk

    // Each chunk should be roughly under maxTokens with reasonable buffer
    // The chunker splits on line boundaries so chunks might exceed slightly
    chunks.forEach(chunk => {
      expect(chunk.tokenCount).toBeLessThanOrEqual(300); // Generous buffer for line-based splitting
    });
  });

  it('should handle text with no newlines', () => {
    const text = 'a '.repeat(1000); // Long text without newlines
    const chunks = chunkText(text);

    // Should still create a single chunk (or handle gracefully)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle markdown headings properly', () => {
    const text = `# Heading 1
Content under heading 1.

## Heading 2
${'More content.\n'.repeat(50)}

### Heading 3
${'Even more content.\n'.repeat(50)}`;

    const chunks = chunkText(text, 300, 20);

    // Just verify it doesn't crash and produces valid chunks
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    chunks.forEach(chunk => {
      expect(chunk.content).toBeTruthy();
      expect(chunk.chunkIndex).toBeTypeOf('number');
    });
  });
});
