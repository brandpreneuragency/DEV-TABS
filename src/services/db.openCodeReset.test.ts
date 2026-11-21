// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { TabsDB } from './db';

const databases: Dexie[] = [];

async function seedV21() {
  const name = `opencode-reset-fixture-${crypto.randomUUID()}`;
  const schema = new TabsDB(name);
  const stores = Object.fromEntries(schema.tables.map(table => [table.name,
    [table.schema.primKey.src, ...table.schema.indexes.map(index => index.src)].join(', ')]));
  schema.close();
  const old = new Dexie(name);
  databases.push(old);
  old.version(21).stores(stores);
  await old.open();
  const origins = [undefined, 'legacy_api', 'codex', 'grok', 'commandCode', 'mockEcho', 'mockTools'];
  await old.table('chatThreads').bulkPut(origins.map((origin, index) => ({ id: `legacy-${index}`, origin, mode: 'writer', updatedAt: 1 })));
  await old.table('chatThreads').bulkPut([
    { id: 'mapped', origin: 'codex', mode: 'writer' },
    { id: 'new-unmapped', origin: 'openCode', mode: 'writer' },
    { id: 'ambiguous', origin: 'legacy_api', mode: 'writer' },
    { id: 'accepted', mode: 'writer' },
    { id: 'future-origin', origin: 'future-engine', mode: 'writer' },
  ]);
  for (const thread of await old.table('chatThreads').toArray()) {
    await old.table('chatMessages').put({ id: `message-${thread.id}`, threadId: thread.id, content: 'Synthetic transcript' });
  }
  await old.table('chatMessages').put({ id: 'orphan', content: 'Old orphan message' });
  await old.table('openCodeChats').put({ id: 'mapped', sessionID: 'ses_fixture', projectID: 'p', directory: 'C:/synthetic', ownershipMarker: 'mapped' });
  await old.table('openCodeSubmissions').bulkPut([
    { id: 'msg_ambiguous', chatId: 'ambiguous', sessionID: 'ses_ambiguous', status: 'ambiguous', request: { text: 'Keep this intent', delivery: 'queue' } },
    { id: 'msg_accepted', chatId: 'accepted', sessionID: 'ses_accepted', status: 'accepted', acceptedAt: 1 },
    { id: 'msg_pending', chatId: 'missing-thread', sessionID: 'ses_missing', status: 'pending' },
  ]);
  await old.table('codexSessions').put({ appThreadId: 'legacy-2', nativeThreadId: 'old-native' });
  await old.table('codexEvents').put({ id: 'old-event', runId: 'old-run', event: { kind: 'text' } });
  await old.table('codexRuns').bulkPut([
    { runId: 'old-run', clientCommandId: 'old-command', appThreadId: 'legacy-2', scope: { document: { content: 'Recovery snapshot' } }, status: 'recovery_required' },
    { runId: 'opencode:ses_fixture:msg_assistant', clientCommandId: 'msg_new', appThreadId: 'mapped', status: 'running' },
  ]);
  await old.table('codexPendingRequests').put({ requestId: 'proposal', runId: 'old-run', status: 'pending', proposal: { operationId: 'effect', before: 'original', after: 'approved' } });
  await old.table('codexOperationReceipts').put({ operationId: 'effect', runId: 'old-run', appThreadId: 'legacy-2', projection: 'pending', result: 'Preserve effect' });
  await old.table('codexDocumentIntents').put({ operationId: 'effect', workspaceId: 'workspace', status: 'uncertain', afterContent: 'Preserve recovery text' });
  const preserved: Record<string, object[]> = {
    documents: [{ id: 'document', content: 'Saved document' }],
    workspaces: [{ id: 'workspace', currentFile: { content: 'Unsaved document', isDirty: true } }],
    tasks: [{ id: 'task', title: 'Synthetic task', projectId: 'project', updatedAt: 5 }],
    clients: [{ id: 'client', name: 'Synthetic client' }], projects: [{ id: 'project', clientId: 'client' }],
    taskComments: [{ id: 'comment', taskId: 'task', text: 'Keep comment' }],
    taskAIChangeBatches: [{ id: 'batch', taskId: 'task' }],
    agents: [{ id: 'agent', name: 'Keep agent' }], quickPrompts: [{ id: 'prompt', text: 'Keep prompt' }],
    actionGroups: [{ id: 'group', name: 'Keep group' }],
    providerConfigs: [{ id: 'credential-migration-owned', provider: 'synthetic' }],
    githubDrafts: [{ id: 'draft', text: 'Keep GitHub draft' }],
    githubAccounts: [{ id: 'retired-account', login: 'synthetic' }],
    githubWorkspaces: [{ id: 'retired-workspace', accountId: 'retired-account' }],
    githubPrivateCache: [{ id: 'retired-cache', ciphertext: 'Preserve sealed data' }],
    clientNotes: [{ id: 'note', text: 'Keep CRM note' }],
  };
  for (const [table, rows] of Object.entries(preserved)) await old.table(table).bulkPut(rows);
  await old.table('settings').bulkPut([
    ...['activeChatProviderId', 'chatMode', 'codexModelId', 'codexEffort', 'codexExecutablePath', 'codexModelVisibility',
      'grokModelVisibility', 'commandCodeModelVisibility', 'providerModelId:grok', 'providerModelId:commandCode',
      'providerModelId:openCode', 'providerReasoningEffort:grok:synthetic', 'codexHandoff:legacy-2'].map(key => ({ key, value: 'old-chat-only' })),
    ...['language', 'editorFontSize', 'activeAgentId', 'systemInstructions', 'selectedClientId',
      'openCodeModelId', 'openCodeAgentId', 'openCodeModelVisibility', 'codexMigrationStatus',
      'codexMigrationManifest', 'codexMigrationBackupPath', 'codexMigrationBackupHash',
      'providerAccounts', 'tasksAuthority', 'codexFutureSetting', 'providerReasoningEffort:unknown:synthetic']
      .map(key => ({ key, value: `preserve-${key}` })),
  ]);
  const expected = Object.fromEntries(await Promise.all([
    ...Object.keys(preserved), 'openCodeChats', 'openCodeSubmissions', 'codexRuns', 'codexPendingRequests',
    'codexOperationReceipts', 'codexDocumentIntents',
  ].map(async table => [table, await old.table(table).toArray()])));
  old.close();
  return { name, expected };
}

afterEach(async () => {
  const fixtures = databases.splice(0);
  for (const database of fixtures) database.close();
  for (const name of new Set(fixtures.map(database => database.name))) await Dexie.delete(name);
});

describe('versioned OpenCode prototype legacy-chat reset', () => {
  it('opens when a legacy settings cursor contains a null row without deleting unrelated data', async () => {
    const { name, expected } = await seedV21();
    const upgraded = new TabsDB(name); databases.push(upgraded);
    // The installed WebView exposed a null settings cursor value. Emulate that
    // storage boundary without fabricating an invalid inline-key IDB record.
    upgraded.use({
      stack: 'dbcore', name: 'synthetic-null-setting',
      create: core => ({
        ...core,
        table: tableName => {
          const table = core.table(tableName);
          if (tableName !== 'settings') return table;
          return {
            ...table,
            openCursor: async request => {
              const cursor = await table.openCursor(request);
              return cursor && new Proxy(cursor, {
                get: (target, property, receiver) => property === 'value' && target.primaryKey === 'language'
                  ? null : Reflect.get(target, property, receiver),
              });
            },
          };
        },
      }),
    });
    await upgraded.open();
    expect(upgraded.verno).toBe(22);
    upgraded.close();
    const reopened = new TabsDB(name); databases.push(reopened); await reopened.open();
    expect(await reopened.settings.get('language')).toEqual({ key: 'language', value: 'preserve-language' });
    expect(await reopened.settings.get('activeChatProviderId')).toBeUndefined();
    for (const [table, rows] of Object.entries(expected)) expect(await reopened.table(table).toArray(), table).toEqual(rows);
  });

  it('removes only legacy chat state and keeps mappings, admissions, business recovery and app data byte-for-byte', async () => {
    const { name, expected } = await seedV21();
    const upgraded = new TabsDB(name); databases.push(upgraded);
    await upgraded.open();
    expect(upgraded.verno).toBe(22);
    expect((await upgraded.chatThreads.toArray()).map(row => row.id).sort()).toEqual(['accepted', 'ambiguous', 'future-origin', 'mapped', 'new-unmapped']);
    expect((await upgraded.chatMessages.toArray()).map(row => row.id).sort()).toEqual(['message-accepted', 'message-ambiguous', 'message-future-origin', 'message-mapped', 'message-new-unmapped']);
    expect(await upgraded.codexSessions.count()).toBe(0);
    expect(await upgraded.codexEvents.count()).toBe(0);
    for (const [table, rows] of Object.entries(expected)) expect(await upgraded.table(table).toArray(), table).toEqual(rows);
    const settings = await upgraded.settings.toArray();
    expect(settings.every(row => String(row.value).startsWith('preserve-'))).toBe(true);
    expect(settings).toHaveLength(16);
  });

  it('does not reset again on reopen or erase later OpenCode session/admission data', async () => {
    const { name } = await seedV21();
    const upgraded = new TabsDB(name); databases.push(upgraded); await upgraded.open();
    await upgraded.table('chatThreads').put({ id: 'later', origin: 'openCode' });
    await upgraded.table('openCodeChats').put({ id: 'later', sessionID: 'ses_later' });
    await upgraded.table('openCodeSubmissions').put({ id: 'msg_later', chatId: 'later', status: 'ambiguous' });
    const before = Object.fromEntries(await Promise.all(upgraded.tables.map(async table => [table.name, await table.toArray()])));
    upgraded.close();
    const reopened = new TabsDB(name); databases.push(reopened); await reopened.open();
    for (const [table, rows] of Object.entries(before)) expect(await reopened.table(table).toArray(), table).toEqual(rows);
  });

  it('rolls back the reset with the upgrade transaction and safely retries', async () => {
    const { name, expected } = await seedV21();
    const failing = new TabsDB(name); databases.push(failing);
    failing.version(23).stores({}).upgrade(() => { throw new Error('Synthetic later upgrade failure'); });
    await expect(failing.open()).rejects.toThrow('Synthetic later upgrade failure');
    failing.close();
    const beforeRetry = new Dexie(name); databases.push(beforeRetry); await beforeRetry.open();
    expect(beforeRetry.verno).toBe(21);
    expect(await beforeRetry.table('chatThreads').get('legacy-0')).toBeDefined();
    expect(await beforeRetry.table('settings').get('activeChatProviderId')).toBeDefined();
    beforeRetry.close();
    const retry = new TabsDB(name); databases.push(retry); await retry.open();
    expect(await retry.chatThreads.get('legacy-0')).toBeUndefined();
    for (const [table, rows] of Object.entries(expected)) expect(await retry.table(table).toArray(), table).toEqual(rows);
  });
});
