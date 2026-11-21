import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  start: vi.fn(),
  reconcileBindings: vi.fn(),
  setSession: vi.fn(),
  snapshot: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../stores/chatStore', () => ({ useChatStore: (selector: (state: { newChat: () => Promise<void> }) => unknown) => selector({ newChat: async () => {} }) }));
vi.mock('../stores/aiStore', () => ({ useAIStore: { getState: () => ({ getActiveAgent: () => ({ id: 'writer' }) }) } }));
vi.mock('../services/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../services/codex/contextBuilder', () => ({ boundedContext: vi.fn(), captureCodexScope: vi.fn() }));
vi.mock('../services/db', () => ({ db: { openCodeChats: { get: mocks.getBinding } } }));
vi.mock('../services/providers/modelVisibility', () => ({ loadProviderModelVisibility: vi.fn(), visibleProviderModels: vi.fn() }));
vi.mock('../services/openCode/promptDispatch', () => ({ dispatchOpenCodePrompt: vi.fn() }));
vi.mock('../services/openCode/desktopClient', () => ({ openCodeClient: {} }));
vi.mock('../services/openCode/sessionService', () => ({ openCodeSessionService: { reconcileBindings: mocks.reconcileBindings } }));
vi.mock('../stores/openCodeStore', () => ({ useOpenCodeStore: {
  getState: () => ({ start: mocks.start, setSession: mocks.setSession, snapshot: mocks.snapshot }),
  setState: mocks.setState,
} }));

import { useStreamingChat } from './useStreamingChat';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('useStreamingChat thread recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.start.mockResolvedValue(undefined);
    mocks.reconcileBindings.mockResolvedValue(undefined);
    mocks.snapshot.mockResolvedValue(undefined);
  });

  it('ignores a late old-thread restore after switching context', async () => {
    const oldBinding = deferred<{ sessionID: string } | undefined>();
    mocks.getBinding.mockImplementation((id: string) => id === 'thread-a'
      ? oldBinding.promise : Promise.resolve({ sessionID: 'session-b' }));
    const hook = renderHook(({ threadId }) => useStreamingChat(threadId, 'writer'), {
      initialProps: { threadId: 'thread-a' },
    });

    hook.rerender({ threadId: 'thread-b' });
    await waitFor(() => expect(mocks.setSession).toHaveBeenCalledWith('session-b', 'thread-b'));

    await act(async () => { oldBinding.resolve({ sessionID: 'session-a' }); });
    await waitFor(() => expect(mocks.getBinding).toHaveBeenCalledWith('thread-a'));
    expect(mocks.setSession).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).toHaveBeenCalledWith('session-b');
    expect(mocks.setState).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('does not let an old recovery error replace the current connection state', async () => {
    const oldRecovery = deferred<void>();
    mocks.reconcileBindings.mockImplementationOnce(() => oldRecovery.promise).mockResolvedValue(undefined);
    const hook = renderHook(({ threadId }) => useStreamingChat(threadId, 'writer'), {
      initialProps: { threadId: 'thread-a' },
    });
    hook.rerender({ threadId: 'thread-b' });
    await waitFor(() => expect(mocks.setSession).toHaveBeenCalledWith('session-b', 'thread-b'));

    await act(async () => { oldRecovery.reject(new Error('old recovery failed')); });
    expect(mocks.setState).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('preserves the actionable startup failure already published by the store', async () => {
    const startup = deferred<void>();
    mocks.start.mockReturnValueOnce(startup.promise);
    const hook = renderHook(() => useStreamingChat('thread-a', 'writer'));
    await act(async () => {
      startup.reject({ code: 'unavailable', message: 'OpenCode CLI was not found. Install it and reopen TABS.' });
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileBindings).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
    hook.unmount();
  });
});
