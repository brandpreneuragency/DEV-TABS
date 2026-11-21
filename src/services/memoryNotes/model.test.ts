// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMemoryNote, selectMemoryNotes } from './model';

describe('Memory Markdown cards', () => {
  it('reads scalar frontmatter and preserves the original Markdown body', () => {
    const note = parseMemoryNote('original.md', '\uFEFF---\r\ncreated: null\r\nupdated: "2026-10-20T12:30:00+03:00"\r\nextra: preserved on disk\r\n---\r\n\r\n# Başlık\r\n\r\nKısa açıklama. Bir diğer cümle.\r\n\r\n## Details\r\n- **Keep** the source.');
    expect(note.title).toBe('Başlık');
    expect(note.created).toBeNull();
    expect(note.updated).toBe('2026-10-20T12:30:00+03:00');
    expect(note.markdown).toContain('- **Keep** the source.');
    expect(note.markdown).not.toContain('extra:');
    expect(note.preview).toBe('Kısa açıklama. Bir diğer cümle. - Keep the source.');
  });
  it('does not manufacture dates from filenames or invalid metadata', () => {
    const note = parseMemoryNote('26-01-01-Old.md', '---\ncreated: 2026-01-01\nupdated: "2026-02-30T00:00:00Z"\n---\nNo heading.');
    expect(note).toMatchObject({ title: '26-01-01-Old', created: null, updated: null });
    expect(parseMemoryNote('empty.md', '').title).toBe('empty');
  });
  it('searches Turkish title, body and filename and sorts unknown dates last', () => {
    const older = parseMemoryNote('one.md', '---\nupdated: "2026-09-01T00:00:00Z"\n---\n# İlk not\nIŞIK');
    const newer = parseMemoryNote('two.md', '---\nupdated: "2026-10-01T00:00:00Z"\n---\n# Yeni not');
    const unknown = parseMemoryNote('alpha.md', '# Alpha');
    const input = [unknown, older, newer];
    expect(selectMemoryNotes(input, 'ışık', 'updated', 'tr')).toEqual([older]);
    expect(selectMemoryNotes(input, 'two.md', 'updated', 'tr')).toEqual([newer]);
    expect(selectMemoryNotes(input, '', 'updated', 'en')).toEqual([newer, older, unknown]);
    expect(input).toEqual([unknown, older, newer]);
  });
});
