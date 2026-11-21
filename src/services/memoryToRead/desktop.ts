import { isTauriRuntime } from '../runtime';
import { MAX_MEMORY_NOTE_BYTES, MemoryNotesError } from '../memoryNotes/reader';
import { isResourceMarkdown, isResourceSegment } from '../memoryResources/reader';
import { MEMORY_TO_READ_DIRECTORY, readMemoryToRead, type MemoryToReadSnapshot } from './reader';

/** Fixed read-only root; no picker, download, write or mark-read operation.
 * Directory-entry checks reject known links, but are not atomic no-follow opens.
 * As with Resources, concurrent pathname replacement/reparse races remain outside this guarantee.
 */
export async function loadMemoryToRead(): Promise<MemoryToReadSnapshot> {
  if (!isTauriRuntime()) throw new MemoryNotesError('unsupported');
  try {
    const { BaseDirectory, readDir, stat, readTextFile } = await import('@tauri-apps/plugin-fs');
    const options = { baseDir: BaseDirectory.Home };
    const fixedSegments = MEMORY_TO_READ_DIRECTORY.split('/');
    const verify = async (relative: string, file: boolean) => {
      const segments = relative ? relative.split('/') : [];
      if (segments.length > (file ? 2 : 1) || segments.some((part) => !isResourceSegment(part) || /\.sync-conflict-/i.test(part))
        || (file && !isResourceMarkdown(segments.at(-1) ?? ''))) throw new MemoryNotesError('read');
      const all = [...fixedSegments, ...segments];
      let parent = '';
      for (let index = 0; index < all.length; index++) {
        const matches = (await readDir(parent, options)).filter((entry) => entry.name === all[index]);
        if (!matches.length) throw new MemoryNotesError(index < fixedSegments.length ? 'missing' : 'read');
        const entry = matches[0];
        const leafFile = file && index === all.length - 1;
        if (matches.length !== 1 || entry.isSymlink !== false
          || (leafFile ? entry.isFile !== true || entry.isDirectory !== false : entry.isDirectory !== true || entry.isFile !== false)) throw new MemoryNotesError('read');
        parent = parent ? `${parent}/${entry.name}` : entry.name;
      }
      return parent;
    };
    return await readMemoryToRead({
      list: async (relative) => readDir(await verify(relative, false), options),
      read: async (relative) => {
        const path = await verify(relative, true);
        const info = await stat(path, options);
        if (!info.isFile || info.isDirectory || info.isSymlink || !Number.isFinite(info.size) || info.size < 0) throw new MemoryNotesError('read');
        if (info.size > MAX_MEMORY_NOTE_BYTES) throw new MemoryNotesError('tooLarge');
        await verify(relative, true);
        const text = await readTextFile(path, options);
        if (new TextEncoder().encode(text).byteLength > MAX_MEMORY_NOTE_BYTES) throw new MemoryNotesError('tooLarge');
        return text;
      },
    });
  } catch (error) {
    throw error instanceof MemoryNotesError ? error : new MemoryNotesError('read');
  }
}
