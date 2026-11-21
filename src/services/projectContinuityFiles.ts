import { getMetadata, openFileDialog, readTextFile } from './fs-adapter';
import { isTauriRuntime } from './runtime';
import { assertReferencePath } from './projectContinuity';

export interface ContinuityPreview { text: string; readAt: number; modifiedAt: number | null }
const MAX_BYTES = 256_000;

export async function selectContinuityFile(): Promise<string | null> {
  if (!isTauriRuntime()) throw new Error('continuity.desktopOnly');
  const path = await openFileDialog([{ name: 'Markdown / Text', extensions: ['md', 'txt'] }]);
  if (path !== null) assertReferencePath(path);
  return path;
}

/** Explicit re-selection grants this read, not persistent background file access. */
export async function readContinuityFile(path: string): Promise<ContinuityPreview | null> {
  assertReferencePath(path);
  const selected = await selectContinuityFile();
  if (selected === null) return null;
  if (selected !== path) throw new Error('continuity.mismatch');
  const before = await getMetadata(path);
  if (!before.isFile || before.isDirectory) throw new Error('continuity.unavailable');
  if (!Number.isFinite(before.size) || before.size < 0 || before.size > MAX_BYTES) throw new Error('continuity.tooLarge');
  const text = await readTextFile(path);
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('continuity.tooLarge');
  const after = await getMetadata(path);
  if (!after.isFile || after.isDirectory || before.size !== after.size
    || before.modifiedAt?.getTime() !== after.modifiedAt?.getTime()) throw new Error('continuity.changed');
  return { text, readAt: Date.now(), modifiedAt: after.modifiedAt?.getTime() ?? null };
}
