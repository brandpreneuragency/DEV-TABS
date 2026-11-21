import { readMemoryToRead, type MemoryToReadSnapshot } from '../memoryToRead/reader';
import type { MemoryResourcesSource } from '../memoryResources/reader';

export const MEMORY_SOMEDAY_DIRECTORY = 'MOTHER/MEMORY/Someday';
export type MemorySomedaySnapshot = MemoryToReadSnapshot;

/** One idea folder per card. Root files and asset trees are never read. */
export function readMemorySomeday(source: MemoryResourcesSource): Promise<MemorySomedaySnapshot> {
  return readMemoryToRead({
    list: async (relative) => {
      const entries = await source.list(relative);
      return relative ? entries : entries.filter((entry) => !entry.isFile || entry.isDirectory || entry.isSymlink);
    },
    read: (relative) => source.read(relative),
  });
}
