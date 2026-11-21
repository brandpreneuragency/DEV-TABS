// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { db } from './db';

describe('historic chat upgrades', () => {
  it('resets v6 legacy chats but preserves the original document through the OpenCode upgrade', async () => {
    await db.delete();
    const old = new Dexie('ZenEditorDB');
    old.version(6).stores({
      documents: 'id, title, updatedAt, order',
      chatMessages: 'id, documentId, taskId, agentId, timestamp',
      agents: 'id, name, isDefault, scope',
      providerConfigs: 'id, provider, isActive',
      settings: 'key',
      quickPrompts: 'id, createdAt, scope',
      fileHandles: 'key',
      tasks: 'id, title, updatedAt, order, projectId, status, parentId',
      projects: 'id, name',
      taskComments: 'id, taskId, createdAt',
      taskAIChangeBatches: 'id, taskId, createdAt, expiresAt',
    });
    await old.open();
    await old.table('documents').add({ id: 'doc-1', title: 'Historic draft',
      content: 'Preserved document body', createdAt: 100, updatedAt: 102, order: 0 });
    await old.table('chatMessages').bulkAdd([
      { id: 'old-user', documentId: 'doc-1', agentId: 'agent-1', role: 'user',
        content: 'First question', timestamp: 101 },
      { id: 'old-answer', documentId: 'doc-1', agentId: 'agent-1', role: 'assistant',
        content: 'Preserved answer', timestamp: 102 },
    ]);
    old.close();

    await db.open();
    expect(await db.chatMessages.count()).toBe(0);
    expect(await db.chatThreads.get('legacy-document:doc-1')).toBeUndefined();
    expect(await db.table('documents').get('doc-1')).toMatchObject({
      title: 'Historic draft', content: 'Preserved document body',
    });
  });
});
