import { describe, expect, it } from 'vitest';
import {
  chunkMarkdownByStructure,
  extractCleanMarkdownFromHtml,
  preprocessMarkdownContent,
} from '../src/dom/markdown-extractor.js';

describe('markdown extractor alignment', () => {
  it('extracts markdown with content stats', () => {
    const html = `
      <html>
        <body>
          <h1>Report</h1>
          <p>Revenue <a href="https://example.com/revenue">details</a></p>
          <img src="data:image/png;base64,abc" />
        </body>
      </html>
    `;

    const result = extractCleanMarkdownFromHtml(html, {
      extract_links: false,
      method: 'test',
      url: 'https://example.com',
    });

    expect(result.content).toContain('# Report');
    expect(result.content).not.toContain('data:image/png');
    expect(result.stats.method).toBe('test');
    expect(result.stats.url).toBe('https://example.com');
    expect(result.stats.original_html_chars).toBeGreaterThan(0);
    expect(result.stats.initial_markdown_chars).toBeGreaterThan(0);
  });

  it('keeps table headers in overlap when chunking table continuations', () => {
    const content = [
      '# KPI',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| Revenue | 100 |',
      '| Cost | 40 |',
      '| Margin | 60 |',
      '| Growth | 20% |',
      '',
      'Summary paragraph',
    ].join('\n');

    const chunks = chunkMarkdownByStructure(content, 80, 5, 0);
    expect(chunks.length).toBeGreaterThan(1);

    const continuation = chunks.find(
      (chunk) => chunk.overlap_prefix.includes('| Metric | Value |')
    );
    expect(continuation).toBeDefined();
    expect(continuation?.overlap_prefix).toContain('| --- | --- |');
  });

  it('starts chunk list from the chunk containing start_from_char', () => {
    const content = [
      '# First',
      '',
      'A'.repeat(150),
      '',
      '# Second',
      '',
      'B'.repeat(150),
    ].join('\n');
    const allChunks = chunkMarkdownByStructure(content, 140, 3, 0);
    expect(allChunks.length).toBeGreaterThan(1);

    const secondChunk = allChunks[1]!;
    const resumed = chunkMarkdownByStructure(
      content,
      140,
      3,
      secondChunk.char_offset_start
    );
    expect(resumed[0]?.chunk_index).toBe(secondChunk.chunk_index);
  });

  it('preprocesses markdown by removing large json-like noise', () => {
    const noisy = [
      'Real line',
      '',
      '{"$type":"x","blob":"' + 'a'.repeat(120) + '"}',
      '',
      '',
      '',
      '',
      'Another line',
    ].join('\n');

    const processed = preprocessMarkdownContent(noisy);
    expect(processed.content).toContain('Real line');
    expect(processed.content).toContain('Another line');
    expect(processed.content).not.toContain('"$type"');
    expect(processed.chars_filtered).toBeGreaterThan(0);
  });
});
