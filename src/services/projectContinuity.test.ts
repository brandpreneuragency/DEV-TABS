import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { ContinuityRepository } from './projectContinuity';
import { META_KEY } from './taskAuthority/model';

const databases: Dexie[] = [];
async function fixture() {
  const db = new Dexie(`continuity-test-${crypto.randomUUID()}`);
  db.version(1).stores({ settings: 'key', projects: 'id', tasks: 'id' });
  databases.push(db);
  await db.table('projects').bulkPut([
    { id: 'a', name: 'Same', createdAt: 1 }, { id: 'b', name: 'Same', createdAt: 2 },
  ]);
  await db.table('tasks').put({ id: 'task', projectId: 'a', status: 'pending' });
  return { db, repo: new ContinuityRepository(db) };
}
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.delete())); });

it('persists references by exact project identity, survives rename and never mutates tasks/projects', async () => {
  const { db, repo } = await fixture();
  const original = await db.table('tasks').toArray();
  const initial = await repo.load('a');
  const saved = await repo.save(initial, { source: 'C:/work/repo/README.md' });
  expect(saved.revision).toBe(1);
  await db.table('projects').update('a', { name: 'Renamed' });
  db.close();
  await db.open();
  expect((await new ContinuityRepository(db).load('a')).references.source).toBe('C:/work/repo/README.md');
  expect((await repo.load('b')).references).toEqual({});
  expect(await db.table('tasks').toArray()).toEqual(original);
  expect(await db.table('projects').get('a')).toEqual({ id: 'a', name: 'Renamed', createdAt: 1 });
});

it('rejects stale writes, deletion and replacement identities without losing saved references', async () => {
  const { db, repo } = await fixture();
  const initial = await repo.load('a');
  await repo.save(initial, { workRecord: 'C:/repo/docs/work/topic.md' });
  await expect(repo.save(initial, {})).rejects.toThrow('continuity.conflict');
  await db.table('projects').update('a', { createdAt: 9 });
  await expect(repo.save(initial, {})).rejects.toThrow('continuity.conflict');
  expect((await repo.load('a')).references).toEqual({});
  await db.table('projects').delete('a');
  await expect(repo.load('a')).rejects.toThrow('continuity.missingProject');
});

it('isolates authority databases and fails closed on malformed persisted metadata', async () => {
  const { db, repo } = await fixture();
  const initial = await repo.load('a');
  await repo.save(initial, { source: 'C:/repo/README.md' });
  const metadata = { schema: 1, phase: 'active', actor: 'fixture', databaseId: 'authority-a', generation: 1, baseline: [], conflicts: [], deletions: [] };
  await db.table('settings').put({ key: META_KEY, value: metadata });
  expect((await repo.load('a')).references).toEqual({});
  await expect(repo.save(initial, {})).rejects.toThrow('continuity.conflict');
  const current = await repo.load('a');
  await db.table('settings').put({ key: `projectContinuityV1:${current.identity}`, value: { ...current, references: { source: 'javascript:alert(1)' } } });
  await expect(repo.load('a')).rejects.toThrow('continuity.invalid');
});

it.each(['javascript:alert(1)', 'https://example.com/a.md', '../a.md', 'C:/VAULT/a.md', 'C:/repo/.git/config.txt', 'C:/repo/.env.txt', 'C:/repo/../private.md', '//server/share/a.md', 'C:/repo/run.exe', 'C:/repo/CON.md'])('rejects unsafe reference %s before persistence', async path => {
  const { repo } = await fixture();
  const initial = await repo.load('a');
  await expect(repo.save(initial, { source: path })).rejects.toThrow('continuity.invalid');
  expect((await repo.load('a')).revision).toBe(0);
});
