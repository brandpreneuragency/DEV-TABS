// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMemoryToRead } from './model';

describe('To-Read source metadata', () => {
  it('preserves the title, dates and first prose without inventing a source from citations', () => {
    const record = parseMemoryToRead('reading.md', '---\ntitle: "Selected reading"\ncreated: null\nupdated: "2026-10-13T09:44:43+03:00"\nstatus: review\n---\n## Kısaca\n\nİlk cümle. İkinci cümle.\n\n## Discussion\nCitation https://example.invalid/research');
    expect(record).toMatchObject({ fileName: 'reading.md', title: 'Selected reading', created: null, updated: '2026-10-13T09:44:43+03:00', preview: 'İlk cümle. İkinci cümle.', sourceUrl: null });
    expect('category' in record).toBe(false);
    expect(record.markdown).toContain('## Discussion');
  });
  it('decodes one declared captured URL, preserving its case, query and fragment', () => {
    const value = JSON.stringify('"https://Example.invalid/post?id=1#part"');
    const input = `---\nsource_metadata:\n  - path: "old.md"\n    original_source_literal: ${value}\n---\n## Kısaca\n\nAn introduction.`;
    expect(parseMemoryToRead('bundle/note.md', input).sourceUrl).toBe('https://Example.invalid/post?id=1#part');
  });
  it('does not choose a primary source from multiple different captured originals', () => {
    const text = '---\nsource_metadata:\n  - path: "a.md"\n    original_source_literal: "https://example.invalid/a"\n  - path: "b.md"\n    original_source_literal: "https://example.invalid/b"\n---\n# Reading';
    expect(parseMemoryToRead('reading.md', text).sourceUrl).toBeNull();
  });
  it.each(['javascript:alert(1)', 'https://user:pass@example.invalid', 'https://example.invalid/%0a'])('rejects an unsafe captured source: %s', (source) => {
    expect(parseMemoryToRead('reading.md', `---\nsource_metadata:\n  - path: old.md\n    original_source_literal: ${JSON.stringify(source)}\n---\n# Reading`).sourceUrl).toBeNull();
  });
  it('keeps explicit scalar sources authoritative and never replaces an invalid one with a captured fallback', () => {
    const metadata = '\nsource_metadata:\n  - path: old.md\n    original_source_literal: "https://example.invalid/captured"\n---\n# Reading';
    expect(parseMemoryToRead('reading.md', '---\nsource: "https://example.invalid/primary"' + metadata).sourceUrl).toBe('https://example.invalid/primary');
    expect(parseMemoryToRead('reading.md', '---\nsource: "javascript:alert(1)"' + metadata).sourceUrl).toBeNull();
  });
});
