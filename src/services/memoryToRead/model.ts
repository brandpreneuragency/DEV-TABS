import type { MemoryNote } from '../memoryNotes/model';
import { parseMemoryResource, safeUrl } from '../memoryResources/model';

export interface MemoryToRead extends MemoryNote { sourceUrl: string | null }

/** Decode the known capture's string-literal representation, never repair a URL. */
function capturedLiteral(value: string): string | null {
  let text = value.trim();
  for (let level = 0; level < 2; level++) {
    if (text.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(text);
        if (typeof decoded !== 'string') return null;
        text = decoded;
      } catch { return null; }
    } else if (text.startsWith("'") && text.endsWith("'")) {
      text = text.slice(1, -1).replace(/''/g, "'");
    } else break;
  }
  return safeUrl(text);
}

function capturedSource(text: string): string | null {
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))?.[1];
  if (!header || /^(?:source|source_url|url):/im.test(header)) return null;
  let inMetadata = false;
  const sources: (string | null)[] = [];
  for (const line of header.split('\n')) {
    if (/^source_metadata:\s*$/.test(line)) { inMetadata = true; continue; }
    if (/^\S/.test(line)) inMetadata = false;
    const original = inMetadata ? /^ {4}original_source_literal:\s*(.*)$/.exec(line) : null;
    if (original) sources.push(capturedLiteral(original[1]));
  }
  if (sources.includes(null)) return null;
  const unique = [...new Set(sources)];
  return unique.length === 1 ? unique[0] : null;
}

export function parseMemoryToRead(relativePath: string, text: string): MemoryToRead {
  const { fileName, title, markdown, preview, created, updated, sourceUrl } = parseMemoryResource(relativePath, text);
  return { fileName, title, markdown, preview, created, updated, sourceUrl: sourceUrl ?? capturedSource(text) };
}
