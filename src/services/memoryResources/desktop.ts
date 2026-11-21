import { isTauriRuntime } from '../runtime';
import { MAX_MEMORY_NOTE_BYTES, MemoryNotesError } from '../memoryNotes/reader';
import {
  isResourceMarkdown, isResourceSegment, MEMORY_RESOURCES_DIRECTORY, readMemoryResources,
  type MemoryResourcesSnapshot,
} from './reader';

/**
 * Fixed Home-relative, read-only adapter. No picker, writes, browser fallback or cache.
 * plugin-fs stat follows symlinks; its isSymlink flag alone is not protection.
 * Revalidate each ancestor and leaf with readDir's non-following entry flags before
 * stat/read. Existing permissions allow readDir/stat, not lstat. These pathname
 * checks are NOT atomic open/no-follow: a concurrent replacement between calls
 * remains a TOCTOU limitation (including Windows reparse-point behavior).
 */
export async function loadMemoryResources(): Promise<MemoryResourcesSnapshot> {
  if (!isTauriRuntime()) throw new MemoryNotesError('unsupported');
  try {
    const { BaseDirectory, readDir, stat, readTextFile } = await import('@tauri-apps/plugin-fs');
    const options = { baseDir: BaseDirectory.Home };
    const fixedSegments = MEMORY_RESOURCES_DIRECTORY.split('/');
    const verify = async (relative: string, file: boolean) => {
      const segments = relative ? relative.split('/') : [];
      if (segments.length > (file ? 3 : 2) || segments.some((part) => !isResourceSegment(part) || /\.sync-conflict-/i.test(part))
        || (file && !isResourceMarkdown(segments.at(-1) ?? ''))) throw new MemoryNotesError('read');
      const all = [...fixedSegments, ...segments];
      let parent = '';
      for (let index = 0; index < all.length; index++) {
        const matches = (await readDir(parent, options)).filter((entry) => entry.name === all[index]);
        if (matches.length === 0) throw new MemoryNotesError(index < fixedSegments.length ? 'missing' : 'read');
        const entry = matches[0];
        const leafFile = file && index === all.length - 1;
        if (matches.length !== 1 || entry.isSymlink !== false
          || (leafFile ? entry.isFile !== true || entry.isDirectory !== false : entry.isDirectory !== true || entry.isFile !== false)) throw new MemoryNotesError('read');
        parent = parent ? `${parent}/${entry.name}` : entry.name;
      }
      return parent;
    };
    return await readMemoryResources({
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
