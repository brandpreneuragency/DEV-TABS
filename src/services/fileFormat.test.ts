import { describe, expect, it } from 'vitest';
import { parseByExt, serialize, SUPPORTED_EXTENSIONS } from './fileFormat';

describe('source-file formatting', () => {
  it('loads ordinary JSON as a code block and saves the original manifest text', () => {
    const text = '{\n  "manifest_version": 3,\n  "name": "Pure Black"\n}\n';
    const document = parseByExt(text, 'json');

    expect(document).toMatchObject({
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'json' },
        content: [{ type: 'text', text }],
      }],
    });
    expect(serialize(document, 'json')).toBe(text);
  });

  it.each([
    '{\n  "type": "doc",\n  "name": "configuration"\n}\n',
    '{\n  "type": "doc",\n  "content": [],\n  "setting": true\n}\n',
    '[1,\n  2,\n  3]\n',
    'null\n',
    '{\n  "unfinished":\n',
  ])('keeps ordinary or unfinished JSON as literal source: %s', (text) => {
    expect(serialize(parseByExt(text, 'json'), 'json')).toBe(text);
  });

  it.each(SUPPORTED_EXTENSIONS.filter((ext) => !['md', 'markdown'].includes(ext)))(
    'preserves indentation, tabs, blank lines, CRLF and trailing whitespace in .%s',
    (ext) => {
      const text = '\r\n  first\tvalue  \r\n\r\n\tsecond\r\n\r\n';
      expect(serialize(parseByExt(text, ext), ext)).toBe(text);
      expect(serialize(parseByExt('', ext), ext)).toBe('');
    },
  );

  it('still imports and saves native TipTap JSON documents as document JSON', () => {
    const original = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Formatted note', marks: [{ type: 'bold' }] }],
      }],
    };
    const parsed = parseByExt(JSON.stringify(original), 'json');

    expect(parsed).toEqual(original);
    expect(JSON.parse(serialize(parsed, 'json'))).toEqual(original);
  });

  it('leaves Markdown headings, emphasis and fenced code on the rich-document path', () => {
    const parsed = parseByExt('# Title\n\n**bold**\n\n```json\n{}\n```', 'md');
    const saved = serialize(parsed, 'md');

    expect(saved).toContain('# Title');
    expect(saved).toContain('**bold**');
    expect(saved).toContain('```json\n{}\n```');
  });
});
