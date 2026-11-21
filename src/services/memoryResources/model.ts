import { parseMemoryNote, type MemoryNote } from '../memoryNotes/model';

export interface MemoryResource extends MemoryNote {
  category: string | null;
  sourceUrl: string | null;
}

export function safeUrl(value: string): string | null {
  if (Array.from(value).some((character) => character.charCodeAt(0) <= 32
    || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159))
    || value.includes('\\') || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null;
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function scalar(value: string): string | null {
  const text = value.trim();
  if (text.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(text); return typeof parsed === 'string' ? parsed : null; } catch { return null; }
  }
  if (text.startsWith("'")) return text.endsWith("'") ? text.slice(1, -1).replace(/''/g, "'") : null;
  return text.replace(/\s+#.*$/, '');
}

/** Ignore fenced/indented examples: their labels and headings are not declarations. */
function proseLines(markdown: string): string[] {
  let fence: string | null = null;
  return markdown.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return '';
    }
    return fence || /^(?: {4}|\t)/.test(line) ? '' : line;
  });
}

function declaredSource(text: string, lines: string[]): string | null {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  for (const line of header?.[1].split('\n') ?? []) {
    const match = /^(?:source|source_url|url):\s*(.*)$/i.exec(line);
    if (match) return safeUrl(scalar(match[1]) ?? '');
  }
  let sectionDepth = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (sectionDepth && heading[1].length <= sectionDepth) sectionDepth = 0;
      if (/^(?:sources?|kaynaklar)(?:\s|$)/i.test(heading[2])) sectionDepth = heading[1].length;
      continue;
    }
    const label = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:source|source_url|url|kaynak)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i.exec(line);
    if (label || sectionDepth) {
      const value = (label?.[1] ?? line).replace(/(`+)[\s\S]*?\1/g, '');
      const link = /\[[^\]]*\]\(([^\s)]+)\)/.exec(value)?.[1]
        ?? /https?:\/\/[^\s<>]+/i.exec(value)?.[0];
      if (link) return safeUrl(link);
      if (label) return null;
    }
  }
  return null;
}

export function parseMemoryResource(relativePath: string, text: string): MemoryResource {
  const note = parseMemoryNote(relativePath, text);
  const lines = proseLines(note.markdown);
  const paragraphs = lines.map((line) => /^#{1,6}\s/.test(line) ? '' : line).join('\n').split(/\n\s*\n/);
  const prose = paragraphs.find((paragraph) => paragraph.trim() && !paragraph.split('\n').some((line) =>
    /^\s*(?:#|[-*+]\s|\d+[.)]\s|>|\||<|(?:\*\*)?(?:source|source_url|url|kaynak)(?:\*\*)?\s*:)/i.test(line)));
  return { ...note, preview: prose ? parseMemoryNote('', prose).preview : '',
    category: relativePath.includes('/') ? relativePath.split('/')[0] : null,
    sourceUrl: declaredSource(text, lines) };
}
