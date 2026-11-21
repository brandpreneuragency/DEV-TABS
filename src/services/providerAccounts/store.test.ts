import { describe, expect, it, vi } from 'vitest';
import { createProviderAccountsStore as createStore } from './store';
import type { AccountCardsStorage } from './cards';
import type { ProviderAccount, ProviderAccountsClient } from './types';

const createProviderAccountsStore = (api: ProviderAccountsClient, cards: AccountCardsStorage = {
  load: vi.fn().mockResolvedValue({ ids: [], removedIds: [] }), save: vi.fn().mockResolvedValue(undefined),
}) => createStore(api, cards);

const slot = (id = 'codex-1'): ProviderAccount => ({
  id, providerId: 'openai-codex', label: id, identity: null, status: 'disconnected',
  duplicateOf: null, lastAttemptAt: null, lastSuccessAt: null, error: null, usage: null,
});
const connected = (): ProviderAccount => ({ ...slot(), status: 'connected', lastSuccessAt: 2000,
  identity: { key: 'synthetic-principal', email: 'synthetic@example.invalid', workspaceId: 'workspace-a', plan: 'pro' },
  usage: { windows: [{ id: 'fiveHour', windowMinutes: 300, usedPercent: 40, resetsAt: 3000 }], resetTokens: 3 },
});
function client(): ProviderAccountsClient {
  return {
    list: vi.fn().mockResolvedValue([slot(), slot('codex-2')]),
    refresh: vi.fn().mockResolvedValue([connected(), slot('codex-2')]),
    beginLogin: vi.fn().mockResolvedValue({ accountId: 'codex-1', loginId: 'login-a', authUrl: 'https://auth.openai.com/authorize' }),
    openLogin: vi.fn().mockResolvedValue(undefined),
    pollLogin: vi.fn().mockResolvedValue({ status: 'completed', account: connected(), error: null }),
    cancelLogin: vi.fn().mockResolvedValue(undefined), openUsage: vi.fn().mockResolvedValue(undefined), connections: vi.fn().mockResolvedValue([]),
    connectApiKey: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('provider accounts state ownership', () => {
  it('verifies an Inception key without retaining it in state or accepting late refresh results', async () => {
    const api = client();
    const inception: ProviderAccount = { ...slot('inception-1'), providerId: 'inception', label: 'Inception Labs 1', status: 'connected', lastSuccessAt: 1000 };
    vi.mocked(api.list).mockResolvedValue([inception]);
    const refreshResult = deferred<ProviderAccount[]>();
    vi.mocked(api.refresh).mockReturnValue(refreshResult.promise);
    const keyResult = deferred<ProviderAccount>();
    vi.mocked(api.connectApiKey).mockReturnValue(keyResult.promise);
    const store = createProviderAccountsStore(api);
    await store.getState().load();
    const refreshing = store.getState().refresh('inception-1');
    const connecting = store.getState().connectApiKey('inception-1', 'synthetic-unusable-key');
    expect(store.getState().accounts).toEqual([inception]);
    expect(await store.getState().connectApiKey('inception-1', 'another-unusable-key')).toBe(false);
    keyResult.resolve({ ...inception, lastSuccessAt: 2000 });
    expect(await connecting).toBe(true);
    refreshResult.resolve([{ ...inception, status: 'error' }]); await refreshing;
    expect(store.getState().accounts[0]).toMatchObject({ status: 'connected', lastSuccessAt: 2000, identity: null, usage: null });
    expect(JSON.stringify(store.getState())).not.toContain('synthetic-unusable-key');
    expect(api.connectApiKey).toHaveBeenCalledExactlyOnceWith('inception-1', 'synthetic-unusable-key');
    expect(api.beginLogin).not.toHaveBeenCalled();
  });

  it('keeps the prior account on failed or mismatched API-key connections and rejects other providers', async () => {
    const api = client();
    const inception: ProviderAccount = { ...slot('inception-1'), providerId: 'inception', status: 'connected', lastSuccessAt: 1000 };
    vi.mocked(api.list).mockResolvedValue([inception]);
    const store = createProviderAccountsStore(api); await store.getState().load();
    vi.mocked(api.connectApiKey).mockRejectedValue(new Error('synthetic-sensitive-error'));
    expect(await store.getState().connectApiKey('inception-1', 'unusable')).toBe(false);
    expect(store.getState().accounts).toEqual([inception]);
    expect(store.getState().actionErrors['inception-1']).toBe('apiKeyFailed');
    expect(JSON.stringify(store.getState())).not.toContain('synthetic-sensitive-error');
    vi.mocked(api.connectApiKey).mockResolvedValue({ ...inception, id: 'codex-1' });
    expect(await store.getState().connectApiKey('inception-1', 'unusable')).toBe(false);
    expect(store.getState().accounts).toEqual([inception]);
    expect(await store.getState().connectApiKey('codex-1', 'unusable')).toBe(false);
    expect(api.connectApiKey).toHaveBeenCalledTimes(2);
  });

  it('rejects list responses started during an API-key replacement after that replacement completes', async () => {
    const api = client();
    const inception: ProviderAccount = { ...slot('inception-1'), providerId: 'inception', status: 'connected', lastSuccessAt: 1000 };
    vi.mocked(api.list).mockResolvedValue([inception]);
    const keyResult = deferred<ProviderAccount>(); vi.mocked(api.connectApiKey).mockReturnValue(keyResult.promise);
    const store = createProviderAccountsStore(api); await store.getState().load();
    const connecting = store.getState().connectApiKey('inception-1', 'synthetic-unusable-key');
    const listResult = deferred<ProviderAccount[]>(); vi.mocked(api.list).mockReturnValue(listResult.promise);
    const loading = store.getState().load();
    keyResult.resolve({ ...inception, lastSuccessAt: 2000 }); expect(await connecting).toBe(true);
    listResult.resolve([inception]); await loading;
    expect(store.getState().accounts[0].lastSuccessAt).toBe(2000);
  });

  it('starts with no cards and adds exactly one selected slot without starting login', async () => {
    const api = client();
    const cards = { load: vi.fn().mockResolvedValue({ ids: [], removedIds: [] }), save: vi.fn().mockResolvedValue(undefined) };
    const store = createProviderAccountsStore(api, cards);
    await store.getState().load();
    expect(store.getState().cardIds).toEqual([]);
    expect(await store.getState().addAccount('openai-codex')).toBe(true);
    expect(store.getState().cardIds).toEqual(['codex-1']);
    expect(cards.save).toHaveBeenCalledExactlyOnceWith({ ids: ['codex-1'], removedIds: [] });
    expect(api.beginLogin).not.toHaveBeenCalled();
    expect(api.openLogin).not.toHaveBeenCalled();
  });

  it('lets an isolated CLI login own its window without trying to reopen a browser URL', async () => {
    const api = client();
    const login = { accountId: 'claude-1', loginId: 'cli-login', authUrl: '', flow: 'cli' as const };
    vi.mocked(api.beginLogin).mockResolvedValue(login);
    const store = createProviderAccountsStore(api);
    await store.getState().connect('claude-1');
    expect(store.getState().pendingLogins['claude-1']).toEqual(login);
    expect(api.openLogin).not.toHaveBeenCalled();
  });

  it('does not probe unused slots and refreshes only added account IDs', async () => {
    const api = client(); const store = createProviderAccountsStore(api);
    await store.getState().load();
    await store.getState().refresh();
    expect(api.refresh).not.toHaveBeenCalled();
    await store.getState().addAccount('openai-codex');
    await store.getState().refresh();
    expect(api.refresh).toHaveBeenCalledExactlyOnceWith('codex-1');
    expect(store.getState().cardIds).toEqual(['codex-1']);
  });

  it('restores selected blank cards and existing accounts but not previously probed empty slots', async () => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue([connected(), slot('codex-2'), {
      ...slot('claude-1'), providerId: 'claude', status: 'authRequired', lastAttemptAt: 999,
    }]);
    const cards = { load: vi.fn().mockResolvedValue({ ids: ['codex-2'], removedIds: [] }), save: vi.fn() };
    const store = createProviderAccountsStore(api, cards);
    await store.getState().load();
    expect(store.getState().cardIds).toEqual(['codex-2', 'codex-1']);
    expect(cards.save).toHaveBeenCalledExactlyOnceWith({ ids: ['codex-2', 'codex-1'], removedIds: [] });
  });

  it('keeps failed and overlapping additions from creating ghost or duplicate cards', async () => {
    const api = client(); const write = deferred<void>();
    const cards = { load: vi.fn().mockResolvedValue({ ids: [], removedIds: [] }), save: vi.fn().mockReturnValue(write.promise) };
    const store = createProviderAccountsStore(api, cards);
    await store.getState().load();
    const adding = store.getState().addAccount('openai-codex');
    expect(await store.getState().addAccount('openai-codex')).toBe(false);
    expect(store.getState().cardIds).toEqual([]);
    write.resolve(); await adding;
    expect(store.getState().cardIds).toEqual(['codex-1']);
    cards.save.mockRejectedValue(new Error('fixture failure'));
    expect(await store.getState().addAccount('openai-codex')).toBe(false);
    expect(store.getState().cardIds).toEqual(['codex-1']);
    expect(store.getState().cardError).toBe('cardsSaveFailed');
    cards.save.mockResolvedValue(undefined);
    expect(await store.getState().addAccount('openai-codex')).toBe(true);
    expect(store.getState().cardIds).toEqual(['codex-1', 'codex-2']);
    expect(await store.getState().addAccount('openai-codex')).toBe(false);
    expect(await store.getState().addAccount('invented-provider')).toBe(false);
    expect(store.getState().cardIds).toEqual(['codex-1', 'codex-2']);
  });

  it('keeps a card on a failed removal and serializes the retry with other card edits', async () => {
    const api = client();
    const cards = { load: vi.fn().mockResolvedValue({ ids: ['codex-1'], removedIds: [] }), save: vi.fn() };
    const store = createProviderAccountsStore(api, cards);
    await store.getState().load();
    cards.save.mockRejectedValueOnce(new Error('fixture write failure'));
    expect(await store.getState().removeAccount('codex-1')).toBe(false);
    expect(store.getState().cardIds).toEqual(['codex-1']);
    expect(store.getState().cardError).toBe('cardsSaveFailed');

    const write = deferred<void>();
    cards.save.mockReturnValueOnce(write.promise);
    const retry = store.getState().removeAccount('codex-1');
    expect(await store.getState().addAccount('openai-codex')).toBe(false);
    expect(await store.getState().removeAccount('codex-1')).toBe(false);
    expect(store.getState().cardIds).toEqual(['codex-1']);
    write.resolve();
    expect(await retry).toBe(true);
    expect(store.getState().cardIds).toEqual([]);
    expect(store.getState().cardError).toBeNull();
  });

  it('does not restore a removed card when its last refresh completes', async () => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue([connected()]);
    const result = deferred<ProviderAccount[]>();
    vi.mocked(api.refresh).mockReturnValue(result.promise);
    const store = createProviderAccountsStore(api);
    await store.getState().load();
    const refresh = store.getState().refresh();
    expect(await store.getState().removeAccount('codex-1')).toBe(true);
    result.resolve([connected()]);
    await refresh;
    expect(store.getState().cardIds).toEqual([]);
    await store.getState().refresh();
    expect(api.refresh).toHaveBeenCalledExactlyOnceWith('codex-1');
  });

  it('keeps the last confirmed selection when saved cards become unreadable', async () => {
    const api = client();
    vi.mocked(api.list).mockResolvedValue([connected(), { ...connected(), id: 'codex-2' }]);
    const cards = { load: vi.fn().mockResolvedValueOnce({ ids: ['codex-1'], removedIds: ['codex-2'] })
      .mockRejectedValue(new Error('fixture failure')), save: vi.fn() };
    const store = createProviderAccountsStore(api, cards);
    await store.getState().load();
    await store.getState().load();
    expect(store.getState().cardIds).toEqual(['codex-1']);
    expect(store.getState().cardError).toBe('cardsLoadFailed');
    expect(await store.getState().addAccount('openai-codex')).toBe(false);
    expect(await store.getState().removeAccount('codex-1')).toBe(false);
    expect(cards.save).not.toHaveBeenCalled();
  });

  it('loads real adapter results and never starts login merely to show a dashboard', async () => {
    const api = client(); const store = createProviderAccountsStore(api);
    await store.getState().load();
    expect(store.getState().accounts).toHaveLength(2);
    expect(api.beginLogin).not.toHaveBeenCalled();
    expect(api.openLogin).not.toHaveBeenCalled();
  });

  it('does not let an older list response overwrite a newly completed login', async () => {
    const api = client(); const pendingList = deferred<ProviderAccount[]>();
    vi.mocked(api.list).mockReturnValue(pendingList.promise);
    const store = createProviderAccountsStore(api);
    const loading = store.getState().load();
    await store.getState().connect('codex-1');
    await store.getState().pollLogins();
    pendingList.resolve([slot(), slot('codex-2')]); await loading;
    expect(store.getState().accounts.find((item) => item.id === 'codex-1')?.status).toBe('connected');
    expect(store.getState().accounts).toHaveLength(2);
  });

  it('preserves last-good limits and exposes a failed refresh instead of fabricating zero/full quota', async () => {
    const api = client(); const store = createProviderAccountsStore(api);
    await store.getState().load(); await store.getState().addAccount('openai-codex'); await store.getState().refresh();
    vi.mocked(api.refresh).mockRejectedValue(new Error('probe failed'));
    await store.getState().refresh();
    expect(store.getState().accounts[0].usage?.resetTokens).toBe(3);
    expect(store.getState().accounts[0].status).toBe('error');
    expect(store.getState().accounts[0].lastSuccessAt).toBe(2000);
  });

  it('withholds the old identity and quota immediately while a replacement sign-in starts', async () => {
    const api = client(); const store = createProviderAccountsStore(api);
    await store.getState().load(); await store.getState().addAccount('openai-codex'); await store.getState().refresh();
    const begin = deferred<Awaited<ReturnType<ProviderAccountsClient['beginLogin']>>>();
    vi.mocked(api.beginLogin).mockReturnValue(begin.promise);
    const connecting = store.getState().connect('codex-1');
    expect(store.getState().accounts[0]).toMatchObject({ identity: null, usage: null, lastSuccessAt: null, status: 'authRequired' });
    begin.resolve({ accountId: 'codex-1', loginId: 'replacement', authUrl: 'https://auth.openai.com/authorize' });
    await connecting;
  });

  it('discards a late login completion after cancellation', async () => {
    const api = client(); const pendingPoll = deferred<Awaited<ReturnType<ProviderAccountsClient['pollLogin']>>>();
    vi.mocked(api.pollLogin).mockReturnValue(pendingPoll.promise);
    const store = createProviderAccountsStore(api); await store.getState().load();
    await store.getState().connect('codex-1');
    const polling = store.getState().pollLogins();
    await store.getState().cancelLogin('codex-1');
    pendingPoll.resolve({ status: 'completed', account: connected(), error: null }); await polling;
    expect(store.getState().accounts[0].identity).toBeNull();
    expect(store.getState().pendingLogins).toEqual({});
  });

  it('does not replace a slot with a mismatched account returned by a login response', async () => {
    const api = client(); const store = createProviderAccountsStore(api); await store.getState().load();
    await store.getState().connect('codex-1');
    vi.mocked(api.pollLogin).mockResolvedValue({ status: 'completed', account: { ...connected(), id: 'codex-2' }, error: null });
    await store.getState().pollLogins();
    expect(store.getState().accounts.every((item) => item.identity === null)).toBe(true);
    expect(store.getState().actionErrors['codex-1']).toBeTruthy();
  });

  it('removes a previous consumer identity when its current observation fails', async () => {
    const api = client(); const store = createProviderAccountsStore(api);
    vi.mocked(api.connections).mockResolvedValue([{ id: 'hermes-mother', providerId: 'openai-codex',
      identity: connected().identity, evidence: 'configured', observedAt: 1000, error: 'runtimeUnverified' }]);
    await store.getState().refreshConnections();
    expect(store.getState().connections[0].identity).not.toBeNull();
    vi.mocked(api.connections).mockRejectedValue(new Error('fixture disconnected'));
    await store.getState().refreshConnections();
    expect(store.getState().connections[0]).toMatchObject({ identity: null, providerId: null, evidence: 'unavailable', observedAt: null });
  });
});
