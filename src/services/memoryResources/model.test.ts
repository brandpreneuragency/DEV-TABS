// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMemoryResource } from './model';

describe('resource metadata', () => {
  it('preserves note fields and selects prose and an explicit Sources section', () => {
    const result = parseMemoryResource('Tools/item/main.md', '---\nkind: resource\ncreated: 2026-10-01T12:00:00Z\n---\n# Tool\n\n## Kısaca\nİlk cümle. İkinci cümle.\n\n## Retained assessment\nOther https://unrelated.test\n\n## Sources and provenance\n- https://github.com/owner/repo\n- https://other.test');
    expect(result).toMatchObject({ fileName: 'Tools/item/main.md', category: 'Tools', title: 'Tool', created: '2026-10-01T12:00:00Z', preview: 'İlk cümle. İkinci cümle.', sourceUrl: 'https://github.com/owner/repo' });
    expect(result.markdown).toContain('## Retained assessment');
  });
  it.each(['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/\u0001', 'https://example.test/%0a'])('rejects unsafe declared URLs: %s', (url) => {
    expect(parseMemoryResource('item.md', `---\nsource: ${JSON.stringify(url)}\n---\n# Item`).sourceUrl).toBeNull();
  });
  it('does not promote body URLs or code examples to sources', () => {
    expect(parseMemoryResource('item.md', '# Item\n\nSee https://other.test\n\n```md\nSource: https://example.test\n## Sources\nhttps://example.test\n```').sourceUrl).toBeNull();
  });
  it('ignores inline-code URLs and stops at the next peer heading', () => {
    expect(parseMemoryResource('item.md', '# Item\n\n## Sources\nExample: `https://example.test`\n\n## Limits\nhttps://unrelated.test').sourceUrl).toBeNull();
  });
  it.each(['source', 'source_url', 'url'])('supports scalar %s without normalizing the literal URL', (key) => {
    expect(parseMemoryResource('item.md', `---\n${key}: 'https://Example.test/a?x=1#part'\n---\n# Item`).sourceUrl).toBe('https://Example.test/a?x=1#part');
  });
  it('supports labeled links and Kaynaklar sections', () => {
    expect(parseMemoryResource('item.md', '# Item\n\n**Source:** [Repo](https://example.test/repo)').sourceUrl).toBe('https://example.test/repo');
    expect(parseMemoryResource('item.md', '# Item\n\n## Kaynaklar\n- https://example.test/repo').sourceUrl).toBe('https://example.test/repo');
    expect(parseMemoryResource('item.md', '# Item').category).toBeNull();
  });
});
