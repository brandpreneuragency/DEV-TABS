import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OpenCodeEvent } from '../services/openCode/types';

const mocks = vi.hoisted(() => ({ listener: undefined as ((event: OpenCodeEvent) => void) | undefined,
  listForms: vi.fn(), listPermissions: vi.fn(), discover: vi.fn() }));
vi.mock('../services/runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('../services/openCode/desktopClient', () => ({ openCodeClient: {
  discover: mocks.discover, listModels: async () => [], listAgents: async () => [],
  listen: async (listener: (event: OpenCodeEvent) => void) => { mocks.listener = listener; return () => {}; },
  subscribe: async () => {}, unsubscribe: async () => {}, getMessages: async () => [],
  listForms: mocks.listForms, listPermissions: mocks.listPermissions,
} }));
vi.mock('../services/openCode/persistence', () => ({ listBindings: async () => [] }));
vi.mock('../services/openCode/sessionService', () => ({ toFormInfo: (form: unknown) => form,
  openCodeSessionService: {} }));
import { useOpenCodeStore } from './openCodeStore';

beforeEach(async () => {
  await useOpenCodeStore.getState().stop();
  useOpenCodeStore.setState(useOpenCodeStore.getInitialState());
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.discover.mockResolvedValue({ state: 'connected', generation: 1, detail: null });
  mocks.listForms.mockResolvedValue([]);
  mocks.listPermissions.mockResolvedValue([]);
  await useOpenCodeStore.getState().start();
  useOpenCodeStore.getState().setSession('ses_owned', 'thread');
});
afterEach(async () => {
  await useOpenCodeStore.getState().stop();
  vi.useRealTimers();
});

it('refreshes pending permissions and forms during a running turn without requiring another SSE event', async () => {
  mocks.listPermissions.mockResolvedValue([{ id: 'per_fixture', sessionId: 'ses_owned', action: 'tabs.mutate', resources: ['tabs_tasks_create_v1'], message: null }]);
  mocks.listForms.mockResolvedValue([{ id: 'frm_fixture', sessionId: 'ses_owned', fields: [] }]);
  useOpenCodeStore.getState().setBusy(true, 'thread');
  await vi.advanceTimersByTimeAsync(1500);
  expect(useOpenCodeStore.getState().permissions).toHaveLength(1);
  expect(useOpenCodeStore.getState().forms).toHaveLength(1);
});

it('does not poll idle sessions and stops polling with the subscription', async () => {
  await vi.advanceTimersByTimeAsync(1500);
  expect(mocks.listPermissions).not.toHaveBeenCalled();
  useOpenCodeStore.getState().setBusy(true, 'thread');
  await useOpenCodeStore.getState().stop();
  await vi.advanceTimersByTimeAsync(3000);
  expect(mocks.listPermissions).not.toHaveBeenCalled();
});

it('does not overlap pending-request reads when the service is slow', async () => {
  let release!: (value: never[]) => void;
  mocks.listPermissions.mockReturnValue(new Promise<never[]>(resolve => { release = resolve; }));
  useOpenCodeStore.getState().setBusy(true, 'thread');
  try {
    await vi.advanceTimersByTimeAsync(4500);
    expect(mocks.listPermissions).toHaveBeenCalledTimes(1);
  } finally {
    release([]);
    await vi.advanceTimersByTimeAsync(0);
  }
});

it('shows the native startup failure and clears it after a successful retry', async () => {
  await useOpenCodeStore.getState().stop();
  const error = { code: 'unavailable', message: 'OpenCode CLI was not found. Install it and reopen TABS.' };
  mocks.discover.mockRejectedValueOnce(error);
  await expect(useOpenCodeStore.getState().start()).rejects.toEqual(error);
  expect(useOpenCodeStore.getState()).toMatchObject({ connection: 'unavailable', detail: error.message });
  await useOpenCodeStore.getState().start();
  expect(useOpenCodeStore.getState()).toMatchObject({ connection: 'connected', detail: null });
});

it('shows a refresh failure and preserves the last catalog', async () => {
  const error = { code: 'unauthorized', message: 'The OpenCode service rejected this connection' };
  mocks.discover.mockRejectedValueOnce(error);
  await useOpenCodeStore.getState().refresh();
  expect(useOpenCodeStore.getState()).toMatchObject({ connection: 'unauthorized', detail: error.message });
});
