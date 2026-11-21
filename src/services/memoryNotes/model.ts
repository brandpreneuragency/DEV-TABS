export interface MemoryNote {
  fileName: string;
  title: string;
  markdown: string;
  preview: string;
  created: string | null;
  updated: string | null;
}

/** Only simple scalar metadata is needed; this is not a general YAML importer. */
function scalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^(null|~)$/i.test(trimmed)) return null;
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : null;
    } catch { return null; }
  }
  if (trimmed.startsWith("'")) return trimmed.endsWith("'") ? trimmed.slice(1, -1).replace(/''/g, "'") : null;
  if ('>|[]{}&*!'.includes(trimmed[0])) return null;
  return trimmed.replace(/\s+#.*$/, '').trim() || null;
}

function timestamp(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  if (!Number.isFinite(Date.parse(value))) return null;
  const date = value.slice(0, 10);
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? value : null;
}

export function parseMemoryNote(fileName: string, text: string): MemoryNote {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  const metadata = new Map<string, string | null>();
  for (const line of header?.[1].split('\n') ?? []) {
    const field = /^(title|created|updated):\s*(.*)$/.exec(line);
    if (field) metadata.set(field[1], scalar(field[2]));
  }
  const markdown = (header ? normalized.slice(header[0].length) : normalized).trim();
  const heading = /^#\s+(.+?)(?:\s+#+)?$/m.exec(markdown);
  const title = metadata.get('title') || heading?.[1] || fileName.replace(/\.md$/i, '');
  const preview = markdown.replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return { fileName, title, markdown, preview, created: timestamp(metadata.get('created') ?? null),
    updated: timestamp(metadata.get('updated') ?? null) };
}

export type MemoryNotesSort = 'updated' | 'title';

export function selectMemoryNotes<T extends MemoryNote>(notes: T[], query: string, sort: MemoryNotesSort, locale: string): T[] {
  const needle = query.trim().toLocaleLowerCase(locale);
  return notes.filter((note) => !needle
    || `${note.title}\n${note.fileName}\n${note.markdown}`.toLocaleLowerCase(locale).includes(needle))
    .sort((left, right) => {
      const dateOrder = sort === 'updated'
        ? (right.updated ? Date.parse(right.updated) : -Infinity) - (left.updated ? Date.parse(left.updated) : -Infinity) : 0;
      return (Number.isNaN(dateOrder) ? 0 : dateOrder) || left.title.localeCompare(right.title, locale)
        || left.fileName.localeCompare(right.fileName);
    });
}
