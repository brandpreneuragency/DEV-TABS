import { isTauriRuntime } from '../runtime';
import {
  isMemoryNoteName, MAX_MEMORY_NOTE_BYTES, MEMORY_NOTES_DIRECTORY, MemoryNotesError, readMemoryNotes,
  type MemoryNotesSnapshot,
} from './reader';

/** No writer, picker, remote transport or persistent content cache. */
export async function loadMemoryNotes(): Promise<MemoryNotesSnapshot> {
  if (!isTauriRuntime()) throw new MemoryNotesError('unsupported');
  try {
    const { BaseDirectory, exists, readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs');
    const options = { baseDir: BaseDirectory.Home };
    if (!await exists(MEMORY_NOTES_DIRECTORY, options)) throw new MemoryNotesError('missing');
    return await readMemoryNotes({
      list: () => readDir(MEMORY_NOTES_DIRECTORY, options),
      read: async (fileName) => {
        if (!isMemoryNoteName(fileName)) throw new MemoryNotesError('read');
        const path = `${MEMORY_NOTES_DIRECTORY}/${fileName}`;
        const info = await stat(path, options);
        if (!info.isFile || info.isSymlink) throw new MemoryNotesError('read');
        if (info.size > MAX_MEMORY_NOTE_BYTES) throw new MemoryNotesError('tooLarge');
        const text = await readTextFile(path, options);
        if (new TextEncoder().encode(text).byteLength > MAX_MEMORY_NOTE_BYTES) throw new MemoryNotesError('tooLarge');
        return text;
      },
    });
  } catch (error) {
    throw error instanceof MemoryNotesError ? error : new MemoryNotesError('read');
  }
}
