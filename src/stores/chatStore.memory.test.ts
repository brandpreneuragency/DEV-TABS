import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../services/db';
import type { ChatThreadMeta } from '../types';
import { useChatStore } from './chatStore';

beforeEach(async () => {
  await db.delete();
  await db.open();
  useChatStore.setState({ threads: [], activeThreadId: null, messagesByThread: {},
    currentContext: null, contextLoading: false, lastViewedPerContext: {} });
});

describe('Memory chat history', () => {
  it('persists separate histories for items without mixing document or other collection chats', async () => {
    const note = JSON.stringify(['notes', 'same.md']);
    const resource = JSON.stringify(['resources', 'same.md']);
    await useChatStore.getState().loadThreadsForContext({ memoryId: note });
    await useChatStore.getState().newChat({ mode: 'writer', memoryId: note });
    const noteThread = useChatStore.getState().activeThreadId!;

    await useChatStore.getState().loadThreadsForContext({ memoryId: resource });
    expect(useChatStore.getState().threads).toEqual([]);
    await useChatStore.getState().newChat({ mode: 'writer', memoryId: resource });
    const resourceThread = useChatStore.getState().activeThreadId!;
    expect(resourceThread).not.toBe(noteThread);

    await useChatStore.getState().loadThreadsForContext({ workspaceId: 'document' });
    expect(useChatStore.getState().threads).toEqual([]);
    await useChatStore.getState().loadThreadsForContext({ memoryId: note });
    expect(useChatStore.getState().threads.map((thread) => thread.id)).toEqual([noteThread]);
    expect(useChatStore.getState().activeThreadId).toBe(noteThread);
    expect(await db.chatThreads.get(noteThread)).toMatchObject({ memoryId: note, mode: 'writer' });
  });

  it('ignores an older history load that finishes after selecting another item', async () => {
    const oldThread: ChatThreadMeta = { id: 'old', mode: 'writer', memoryId: 'old-item',
      title: 'Old chat', createdAt: 1, updatedAt: 1 };
    let finishOld!: (threads: ChatThreadMeta[]) => void;
    const pending = new Dexie.Promise<ChatThreadMeta[]>((resolve) => { finishOld = (threads) => resolve(threads); });
    const originalFilter = db.chatThreads.filter.bind(db.chatThreads);
    const filter = vi.spyOn(db.chatThreads, 'filter').mockImplementationOnce((predicate) => {
      const collection = originalFilter(predicate);
      vi.spyOn(collection, 'toArray').mockReturnValueOnce(pending);
      return collection;
    });
    const oldLoad = useChatStore.getState().loadThreadsForContext({ memoryId: 'old-item' });
    await useChatStore.getState().loadThreadsForContext({ memoryId: 'new-item' });
    finishOld([oldThread]);
    await oldLoad;
    expect(useChatStore.getState().currentContext).toEqual({ memoryId: 'new-item' });
    expect(useChatStore.getState().threads).toEqual([]);
    expect(useChatStore.getState().activeThreadId).toBeNull();
    expect(useChatStore.getState().contextLoading).toBe(false);
    filter.mockRestore();
  });
});
