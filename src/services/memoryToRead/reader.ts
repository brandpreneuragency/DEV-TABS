import { MAX_MEMORY_NOTE_BYTES, MemoryNotesError, type MemoryNotesSnapshot } from '../memoryNotes/reader';
import { isResourceMarkdown, isResourceSegment, type DirEntry, type MemoryResourcesSource } from '../memoryResources/reader';
import { parseMemoryToRead, type MemoryToRead } from './model';

export const MEMORY_TO_READ_DIRECTORY = 'MOTHER/MEMORY/To-Read';
export type MemoryToReadSnapshot = MemoryNotesSnapshot<MemoryToRead>;

/** Direct reading records plus one-level, single-record asset bundles. No categories. */
export async function readMemoryToRead(source: MemoryResourcesSource): Promise<MemoryToReadSnapshot> {
  const result: MemoryToReadSnapshot = { notes: [], issues: [] };
  const eligible = (entries: DirEntry[], parent: string) => entries.filter((entry) => {
    const fileName = parent ? `${parent}/${entry.name}` : entry.name;
    if (/\.sync-conflict-/i.test(entry.name)) { result.issues.push({ fileName, reason: 'conflict' }); return false; }
    if (!isResourceSegment(entry.name) || entry.isSymlink || entry.isFile === entry.isDirectory) {
      result.issues.push({ fileName, reason: 'unsafe' }); return false;
    }
    return true;
  });
  const read = async (fileName: string) => {
    try {
      const text = await source.read(fileName);
      if (new TextEncoder().encode(text).byteLength > MAX_MEMORY_NOTE_BYTES) throw new MemoryNotesError('tooLarge');
      result.notes.push(parseMemoryToRead(fileName, text));
    } catch (error) {
      result.issues.push({ fileName, reason: error instanceof MemoryNotesError && error.code === 'tooLarge' ? 'tooLarge' : 'read' });
    }
  };
  for (const entry of eligible(await source.list(''), '')) {
    if (entry.isFile) { if (isResourceMarkdown(entry.name)) await read(entry.name); continue; }
    let children: DirEntry[];
    try { children = eligible(await source.list(entry.name), entry.name); }
    catch { result.issues.push({ fileName: entry.name, reason: 'read' }); continue; }
    if (!children.length) continue; // Preserve empty legacy folders without treating them as records.
    const records = children.filter((child) => child.isFile && isResourceMarkdown(child.name));
    const deeper = children.some((child) => child.isDirectory && !/^(?:assets|images|attachments)$/i.test(child.name));
    if (records.length !== 1 || deeper) result.issues.push({ fileName: entry.name, reason: 'bundle' });
    else await read(`${entry.name}/${records[0].name}`);
  }
  return result;
}
