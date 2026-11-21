import type Dexie from 'dexie';
import { readMetadata } from './taskAuthority/cache';

export type ReferenceRole = 'source' | 'workRecord';
export type References = Partial<Record<ReferenceRole, string>>;
export interface ContinuityRecord {
  schema: 1;
  projectId: string;
  identity: string;
  revision: number;
  references: References;
}

export function assertReferencePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > 2048 || !/^[a-z]:[/\\]/i.test(path)
    || /[<>|?*]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32) || path.slice(2).includes(':')
    || !/\.(md|txt)$/i.test(path)) throw new Error('continuity.invalid');
  const parts = path.slice(3).split(/[/\\]/);
  if (parts.some(part => !part || part.startsWith('.') || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])([.]|$)/i.test(part)
    || /^(vault|credentials?|secrets?|node_modules)$/i.test(part)
    || /^(credentials?|secrets?)[.]/i.test(part))) throw new Error('continuity.invalid');
}

function assertReferences(value: unknown): asserts value is References {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('continuity.invalid');
  for (const [role, path] of Object.entries(value)) {
    if (role !== 'source' && role !== 'workRecord') throw new Error('continuity.invalid');
    assertReferencePath(path);
  }
}

function assertRecord(value: unknown, projectId: string, identity: string): asserts value is ContinuityRecord {
  if (!value || typeof value !== 'object') throw new Error('continuity.invalid');
  const record = value as Partial<ContinuityRecord>;
  if (record.schema !== 1 || record.projectId !== projectId || record.identity !== identity
    || !Number.isSafeInteger(record.revision) || record.revision! < 0) throw new Error('continuity.invalid');
  assertReferences(record.references);
}

/** Local settings only: never add fields to the task-authority Project payload. */
export class ContinuityRepository {
  private database: Dexie;
  constructor(database: Dexie) { this.database = database; }

  private async identity(projectId: string): Promise<string> {
    const project = await this.database.table<{ id: string; createdAt: number }, string>('projects').get(projectId);
    if (!project || !Number.isFinite(project.createdAt)) throw new Error('continuity.missingProject');
    const meta = await readMetadata(this.database);
    if (meta && (meta.phase !== 'active' || typeof meta.databaseId !== 'string' || !meta.databaseId)) throw new Error('continuity.unavailable');
    return JSON.stringify([meta?.databaseId ?? 'local-only', projectId, project.createdAt]);
  }

  async load(projectId: string): Promise<ContinuityRecord> {
    return this.database.transaction('r', ['settings', 'projects'], async () => {
      const identity = await this.identity(projectId);
      const row = await this.database.table<{ key: string; value: unknown }, string>('settings').get(`projectContinuityV1:${identity}`);
      if (row) {
        assertRecord(row.value, projectId, identity);
        return row.value;
      }
      return { schema: 1, projectId, identity, revision: 0, references: {} };
    });
  }

  async save(previous: ContinuityRecord, references: References): Promise<ContinuityRecord> {
    assertRecord(previous, previous.projectId, previous.identity);
    assertReferences(references);
    return this.database.transaction('rw', ['settings', 'projects'], async () => {
      if (await this.identity(previous.projectId) !== previous.identity) throw new Error('continuity.conflict');
      const key = `projectContinuityV1:${previous.identity}`;
      const row = await this.database.table<{ key: string; value: unknown }, string>('settings').get(key);
      let revision = 0;
      if (row) {
        assertRecord(row.value, previous.projectId, previous.identity);
        revision = row.value.revision;
      }
      if (revision !== previous.revision) throw new Error('continuity.conflict');
      const next = { ...previous, revision: previous.revision + 1, references };
      await this.database.table('settings').put({ key, value: next });
      return next;
    });
  }
}
