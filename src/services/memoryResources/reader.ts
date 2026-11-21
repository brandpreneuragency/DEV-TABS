import { MemoryNotesError, MAX_MEMORY_NOTE_BYTES, type MemoryNotesIssue } from '../memoryNotes/reader';
import { parseMemoryResource, type MemoryResource } from './model';

export const MEMORY_RESOURCES_DIRECTORY = 'MOTHER/MEMORY/Resources';
export interface DirEntry { name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }
export interface MemoryResourcesSnapshot { notes: MemoryResource[]; issues: MemoryNotesIssue[] }
export interface MemoryResourcesSource {
  list(relativeDirectory: string): Promise<DirEntry[]>;
  read(relativePath: string): Promise<string>;
}

export function isResourceSegment(name: string): boolean {
  return !!name && !name.startsWith('.') && !/[. ]$/.test(name)
    && !/[\\/:]/.test(name) && !Array.from(name).some((character) => character.charCodeAt(0) < 32
      || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159)) && !/^VAULT$/i.test(name);
}
export function isResourceMarkdown(name: string): boolean {
  return isResourceSegment(name) && /\.md$/i.test(name)
    && !/^(?:AGENTS|README|CLAUDE)\.md$/i.test(name) && !/\.sync-conflict-/i.test(name);
}

/** Exactly root → category → optional item bundle; asset directories are never scanned. */
export async function readMemoryResources(source: MemoryResourcesSource): Promise<MemoryResourcesSnapshot> {
  const notes: MemoryResource[] = [];
  const issues: MemoryNotesIssue[] = [];
  const eligible = (entries: DirEntry[], parent: string): DirEntry[] => entries.filter((entry) => {
    const fileName = parent ? `${parent}/${entry.name}` : entry.name;
    if (/\.sync-conflict-/i.test(entry.name)) { issues.push({ fileName, reason: 'conflict' }); return false; }
    if (!isResourceSegment(entry.name) || entry.isSymlink || entry.isFile === entry.isDirectory) {
      issues.push({ fileName, reason: 'unsafe' }); return false;
    }
    return true;
  });
  const read = async (path: string) => {
    try {
      const text = await source.read(path);
      if (new TextEncoder().encode(text).byteLength > MAX_MEMORY_NOTE_BYTES) throw new MemoryNotesError('tooLarge');
      notes.push(parseMemoryResource(path, text));
    } catch (error) {
      issues.push({ fileName: path, reason: error instanceof MemoryNotesError && error.code === 'tooLarge' ? 'tooLarge' : 'read' });
    }
  };
  const listChild = async (path: string): Promise<DirEntry[] | null> => {
    try { return eligible(await source.list(path), path); }
    catch { issues.push({ fileName: path, reason: 'read' }); return null; }
  };
  for (const entry of eligible(await source.list(''), '')) {
    if (entry.isFile) { if (isResourceMarkdown(entry.name)) await read(entry.name); continue; }
    const category = await listChild(entry.name);
    if (!category) continue;
    for (const child of category) {
      const path = `${entry.name}/${child.name}`;
      if (child.isFile) { if (isResourceMarkdown(child.name)) await read(path); continue; }
      const bundle = await listChild(path);
      if (!bundle) continue;
      const mains = bundle.filter((item) => item.isFile && isResourceMarkdown(item.name));
      // A main beside conventional assets is supported; unfamiliar deeper structure is not guessed.
      const deeper = bundle.some((item) => item.isDirectory && !/^(?:assets|images|attachments)$/i.test(item.name));
      if (mains.length !== 1 || deeper) issues.push({ fileName: path, reason: 'bundle' });
      else await read(`${path}/${mains[0].name}`);
    }
  }
  return { notes, issues };
}
