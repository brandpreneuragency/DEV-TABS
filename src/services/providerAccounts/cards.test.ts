import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabsDB } from '../db';
import { ACCOUNT_CARDS_KEY, createAccountCardsStorage } from './cards';
import { createProviderAccountsStore } from './store';
import type { ProviderAccount, ProviderAccountsClient } from './types';

let database: TabsDB;
beforeEach(() => { database = new TabsDB('provider-account-cards-fixture'); });
afterEach(async () => { await database.delete(); });

const empty: ProviderAccount = { id: 'claude-1', providerId: 'claude', label: 'Claude 1',
  identity: null, usage: null, status: 'disconnected', duplicateOf: null,
  lastAttemptAt: null, lastSuccessAt: null, error: null };
const api = (): ProviderAccountsClient => ({
  list: vi.fn().mockResolvedValue([empty]), refresh: vi.fn().mockResolvedValue([empty]),
  beginLogin: vi.fn(), openLogin: vi.fn(), openUsage: vi.fn(), connectApiKey: vi.fn(),
  pollLogin: vi.fn(), cancelLogin: vi.fn(), connections: vi.fn().mockResolvedValue([]),
});

describe('persisted account cards', () => {
  it('reopens a selected blank card through the real settings adapter without storing account data', async () => {
    const first = createProviderAccountsStore(api(), createAccountCardsStorage(database));
    await first.getState().load();
    expect(first.getState().cardIds).toEqual([]);
    await database.settings.put({ key: 'unrelated-fixture', value: 'preserve-me' });
    await first.getState().addAccount('claude');
    expect(await database.settings.get(ACCOUNT_CARDS_KEY)).toEqual({ key: ACCOUNT_CARDS_KEY, value: { ids: ['claude-1'] } });
    const second = createProviderAccountsStore(api(), createAccountCardsStorage(database));
    await second.getState().load();
    expect(second.getState().cardIds).toEqual(['claude-1']);
    expect(await database.settings.get('unrelated-fixture')).toEqual({ key: 'unrelated-fixture', value: 'preserve-me' });
  });

  it('preserves malformed preferences and prevents additions instead of replacing them', async () => {
    const original = { key: ACCOUNT_CARDS_KEY, value: { ids: 'not-an-array' } };
    await database.settings.put(original);
    const store = createProviderAccountsStore(api(), createAccountCardsStorage(database));
    await store.getState().load();
    expect(store.getState().cardError).toBe('cardsLoadFailed');
    expect(await store.getState().addAccount('claude')).toBe(false);
    expect(await database.settings.get(ACCOUNT_CARDS_KEY)).toEqual(original);
  });

  it('does not rediscover a connected card on startup when removal preferences are unreadable', async () => {
    const original = { key: ACCOUNT_CARDS_KEY, value: { ids: [], removedIds: 'unreadable' } };
    await database.settings.put(original);
    const client = api();
    vi.mocked(client.list).mockResolvedValue([{ ...empty, status: 'connected' }]);
    const store = createProviderAccountsStore(client, createAccountCardsStorage(database));
    await store.getState().load();
    expect(store.getState().cardError).toBe('cardsLoadFailed');
    expect(store.getState().cardIds).toEqual([]);
    await store.getState().refresh();
    expect(client.refresh).not.toHaveBeenCalled();
    expect(await database.settings.get(ACCOUNT_CARDS_KEY)).toEqual(original);
  });

  it('deduplicates saved IDs while retaining unknown IDs without inventing native slots', async () => {
    await database.settings.put({ key: ACCOUNT_CARDS_KEY, value: { ids: ['claude-1', 'claude-1', 'future-slot'] } });
    const store = createProviderAccountsStore(api(), createAccountCardsStorage(database));
    await store.getState().load();
    expect(store.getState().cardIds).toEqual(['claude-1', 'future-slot']);
    expect(store.getState().accounts).toEqual([empty]);
    expect(await store.getState().addAccount('claude')).toBe(false);
  });

  it('persists legacy connected cards once so later sign-in expiry does not hide their cards', async () => {
    const adapter = api();
    vi.mocked(adapter.list).mockResolvedValue([{ ...empty, status: 'configured' }]);
    const store = createProviderAccountsStore(adapter, createAccountCardsStorage(database));
    await store.getState().load();
    expect(store.getState().cardIds).toEqual(['claude-1']);
    const next = createProviderAccountsStore(api(), createAccountCardsStorage(database));
    await next.getState().load();
    expect(next.getState().cardIds).toEqual(['claude-1']);
  });

  it('keeps a removed connected account out of Accounts after refresh and restart', async () => {
    const firstAccount: ProviderAccount = { ...empty, id: 'codex-1', providerId: 'openai-codex', label: 'Codex 1', status: 'connected' };
    const secondAccount = { ...firstAccount, id: 'codex-2', label: 'Codex 2' };
    const client = api();
    vi.mocked(client.list).mockResolvedValue([firstAccount, secondAccount]);
    vi.mocked(client.refresh).mockResolvedValue([firstAccount, secondAccount]);
    const cards = createAccountCardsStorage(database);
    const store = createProviderAccountsStore(client, cards);
    await store.getState().load();
    expect(store.getState().cardIds).toEqual(['codex-1', 'codex-2']);

    expect(await store.getState().removeAccount('codex-1')).toBe(true);
    await store.getState().refresh();
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith('codex-2');
    expect(store.getState().cardIds).toEqual(['codex-2']);

    const reopened = createProviderAccountsStore(client, cards);
    await reopened.getState().load();
    expect(reopened.getState().cardIds).toEqual(['codex-2']);
    expect(await reopened.getState().addAccount('openai-codex')).toBe(true);
    expect(reopened.getState().cardIds).toEqual(['codex-2', 'codex-1']);
  });
});
