/**
 * Robust JSON parser for LLM outputs.
 * Extracts JSON from code fences or free-form text and tolerates minor issues.
 */

export class JsonParser {
  /** Parse JSON from LLM content safely */
  static parse<T = unknown>(raw: string): T {
    // Fast path
    const direct = this.tryParse<T>(raw);
    if (direct.success) return direct.value as T;

    // Extract from ```json ... ``` fences first
    const fencedJson =
      this.extractFencedJson(raw, 'json') ?? this.extractFencedJson(raw);
    if (fencedJson) {
      const fromFence =
        this.tryParse<T>(fencedJson) ||
        this.tryParse<T>(this.minorRepairs(fencedJson));
      if (fromFence.success) return fromFence.value as T;
    }

    // Extract first plausible JSON object/array
    const sliced = this.sliceFirstJsonLike(raw);
    if (sliced) {
      const repaired = this.minorRepairs(sliced);
      const attempt = this.tryParse<T>(repaired) || this.tryParse<T>(sliced);
      if (attempt.success) return attempt.value as T;
    }

    // Last resort: attempt minor repairs on the whole string
    const finalAttempt = this.tryParse<T>(this.minorRepairs(raw));
    if (finalAttempt.success) return finalAttempt.value as T;

    throw new Error(`Unable to parse LLM JSON output: ${raw}`);
  }

  private static tryParse<T>(
    text: string
  ): { success: true; value: T } | { success: false } {
    try {
      const v = JSON.parse(text);
      return { success: true, value: v };
    } catch {
      return { success: false };
    }
  }

  private static extractFencedJson(text: string, lang?: string): string | null {
    const pattern = lang
      ? new RegExp('```\\s*' + lang + '\\s*\n([\\s\\S]*?)\n```', 'i')
      : /```\s*\n([\s\S]*?)\n```/i;
    const match = text.match(pattern);
    if (!match) return null;
    return match[1].trim();
  }

  private static sliceFirstJsonLike(text: string): string | null {
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start = -1;
    let isArray = false;
    if (
      firstBrace !== -1 &&
      (firstBracket === -1 || firstBrace < firstBracket)
    ) {
      start = firstBrace;
      isArray = false;
    } else if (firstBracket !== -1) {
      start = firstBracket;
      isArray = true;
    }
    if (start === -1) return null;

    // Naive balance matching
    const open = isArray ? '[' : '{';
    const close = isArray ? ']' : '}';
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        // skip strings
        const end = this.findStringEnd(text, i);
        if (end === -1) break;
        i = end;
        continue;
      }
      if (ch === open) depth++;
      if (ch === close) depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
    // If unbalanced, try to close it
    const tailClose = isArray ? ']' : '}';
    return text.slice(start) + tailClose;
  }

  private static findStringEnd(text: string, startQuoteIndex: number): number {
    let i = startQuoteIndex + 1;
    while (i < text.length) {
      if (text[i] === '"' && text[i - 1] !== '\\') return i;
      i++;
    }
    return -1;
  }

  private static minorRepairs(text: string): string {
    let repaired = text.trim();

    // Fix double braces at start/end (common LLM output issue)
    if (repaired.startsWith('{{') && repaired.endsWith('}}')) {
      repaired = repaired.slice(1, -1);
    }
    if (repaired.startsWith('[[') && repaired.endsWith(']]')) {
      repaired = repaired.slice(1, -1);
    }

    // Fix improperly escaped backticks in JSON strings
    // Convert \` back to ` since backticks don't need escaping in JSON
    repaired = repaired.replace(/\\`/g, '`');

    // Replace single quotes with double quotes where safe (avoid in numbers/booleans)
    // This is heuristic; apply only when looks like JSON-like keys
    if (/\{[\s\S]*?\}/.test(repaired) || /\[[\s\S]*?\]/.test(repaired)) {
      repaired = repaired.replace(
        /([,{[]]\s*)'([^'\n\r]+?)'(\s*:\s*)/g,
        '$1"$2"$3'
      );
      repaired = repaired.replace(/:\s*'([^'\n\r]*?)'/g, ': "$1"');
    }
    // Remove trailing commas before } or ]
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // Ensure it starts with { or [ if it looks like JSON
    const firstCurly = repaired.indexOf('{');
    const firstSquare = repaired.indexOf('[');
    if (firstCurly > 0 || firstSquare > 0) {
      const slice = this.sliceFirstJsonLike(repaired);
      if (slice) return slice;
    }
    return repaired;
  }
}
