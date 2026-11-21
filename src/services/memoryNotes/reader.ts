import { parseMemoryNote, type MemoryNote } from './model';

export const MEMORY_NOTES_DIRECTORY = 'MOTHER/MEMORY/Notes';
export const MAX_MEMORY_NOTE_BYTES = 1_048_576;

export type MemoryNotesIssueReason = 'unsafe' | 'conflict' | 'read' | 'tooLarge' | 'bundle';
export interface MemoryNotesIssue { fileName: string; reason: MemoryNotesIssueReason }
export interface MemoryNotesSnapshot<T extends MemoryNote = MemoryNote> { notes: T[]; issues: MemoryNotesIssue[] }

/** Deliberately read-only and non-recursive. Never accepts a caller-selected root. */
export interface MemoryNotesSource {
  list(): Promise<{ name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean }[]>;
  read(fileName: string): Promise<string>;
}

export class MemoryNotesError extends Error {
  readonly code: 'unsupported' | 'missing' | 'read' | 'tooLarge';
  constructor(code: MemoryNotesError['code']) {
    super(`Memory Notes: ${code}`);
    this.code = code;
  }
}

function hasUnsafePathCharacters(name: string): boolean {
  return /[\\/:]/.test(name) || Array.from(name).some((character) => character.charCodeAt(0) < 32);
}

export function isMemoryNoteName(name: string): boolean {
  return !hasUnsafePathCharacters(name) && !name.startsWith('.')
    && /\.md$/i.test(name) && !/^(?:AGENTS|README|CLAUDE)\.md$/i.test(name)
    && !/\.sync-conflict-/i.test(name);
}

export async function readMemoryNotes(source: MemoryNotesSource): Promise<MemoryNotesSnapshot> {
  const notes: MemoryNote[] = [];
  const issues: MemoryNotesIssue[] = [];
  const entries = await source.list();
  for (const entry of entries) {
    if (entry.isDirectory || !/\.md$/i.test(entry.name)) continue;
    if (entry.isSymlink || hasUnsafePathCharacters(entry.name)) {
      issues.push({ fileName: entry.name, reason: 'unsafe' });
      continue;
    }
    if (/\.sync-conflict-/i.test(entry.name)) {
      issues.push({ fileName: entry.name, reason: 'conflict' });
      continue;
    }
    if (!entry.isFile || !isMemoryNoteName(entry.name)) continue;
    try {
      const text = await source.read(entry.name);
      notes.push(parseMemoryNote(entry.name, text));
    } catch (error) {
      issues.push({ fileName: entry.name, reason: error instanceof MemoryNotesError && error.code === 'tooLarge' ? 'tooLarge' : 'read' });
    }
  }
  return { notes, issues };
}
