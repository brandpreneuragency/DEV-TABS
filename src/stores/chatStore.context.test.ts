import { beforeEach, expect, it, vi } from 'vitest';

const queries = vi.hoisted(() => ({ pending: [] as Array<(rows: unknown[]) => void> }));
vi.mock('../services/db', () => ({ db: {
  chatThreads: { filter: () => ({ toArray: () => new Promise((resolve) => queries.pending.push(resolve)) }) },
  chatMessages: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
} }));
vi.mock('../services/openCode/sessionService', () => ({ openCodeSessionService: {} }));
vi.mock('../services/openCode/toolBridge', () => ({ cancelToolContext: vi.fn() }));

import { useChatStore } from './chatStore';

beforeEach(() => {
  queries.pending.length = 0;
  useChatStore.setState({ threads: [], activeThreadId: null, messagesByThread: {}, currentContext: null, lastViewedPerContext: {} });
});

it('keeps an older context load from replacing a newer card selection', async () => {
  useChatStore.setState({ activeThreadId: 'previous', currentContext: { memoryId: 'previous' } });
  useChatStore.getState().setActiveContext({ memoryId: 'notes:a.md' });
  expect(useChatStore.getState().activeThreadId).toBeNull();
  useChatStore.getState().setActiveContext({ memoryId: 'notes:b.md' });

  queries.pending[1]([]);
  await vi.waitFor(() => expect(useChatStore.getState().contextLoading).toBe(false));
  queries.pending[0]([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useChatStore.getState().currentContext?.memoryId).toBe('notes:b.md');
  expect(useChatStore.getState().activeThreadId).toBeNull();
});
