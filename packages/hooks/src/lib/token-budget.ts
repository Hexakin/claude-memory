const MAX_INJECTION_TOKENS = 1000;
const APPROX_CHARS_PER_TOKEN = 4;

export interface Section {
  title: string;
  items: string[];
  priority: number;  // lower number = higher priority
  maxTokens: number;
}

/**
 * Trim sections to fit within a token budget.
 * Priority order (lower number = higher priority):
 * 1. Rules (always included, up to 300 tokens)
 * 2. Project context (up to 300 tokens)
 * 3. Recent learnings/pitfalls (up to 250 tokens)
 * 4. Global preferences (up to 150 tokens)
 *
 * If total exceeds budget, trim lowest-priority sections first,
 * then truncate individual items within sections.
 */
export function trimToTokenBudget(
  sections: Section[],
  maxTokens = MAX_INJECTION_TOKENS,
): string {
  // Sort sections by priority (ascending = highest priority first)
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);

  let remainingTokens = maxTokens;
  const outputSections: string[] = ['# Claude Memory'];

  for (const section of sorted) {
    if (remainingTokens <= 0) break;

    const sectionBudget = Math.min(section.maxTokens, remainingTokens);
    const sectionChars = sectionBudget * APPROX_CHARS_PER_TOKEN;

    if (section.items.length === 0) continue;

    let sectionContent = `\n## ${section.title}`;
    let usedChars = sectionContent.length;

    for (const item of section.items) {
      const itemLine = `\n- ${item}`;
      if (usedChars + itemLine.length <= sectionChars) {
        sectionContent += itemLine;
        usedChars += itemLine.length;
      } else {
        // Try to fit a truncated version
        const available = sectionChars - usedChars - 6; // 6 for "\n- ..."
        if (available > 20) {
          sectionContent += `\n- ${item.slice(0, available)}...`;
          usedChars = sectionChars;
        }
        break;
      }
    }

    outputSections.push(sectionContent);
    const tokensUsed = Math.ceil(usedChars / APPROX_CHARS_PER_TOKEN);
    remainingTokens -= tokensUsed;
  }

  return outputSections.join('\n');
}

/**
 * Estimate token count from a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}
