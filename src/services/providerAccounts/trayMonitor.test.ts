import { describe, expect, it, vi } from 'vitest';
import { createTrayMonitor } from './trayMonitor';
import type { ProviderAccount } from './types';

const account: ProviderAccount = {
  id: 'codex-1', providerId: 'openai-codex', label: 'Codex 1', status: 'connected', duplicateOf: null,
  identity: { key: 'fixture', email: 'fixture@example.invalid', workspaceId: null, plan: null },
  lastSuccessAt: 1000, lastAttemptAt: 1000, error: null, usage: null,
};
const blank: ProviderAccount = { ...account, id: 'codex-2', label: 'Codex 2', status: 'disconnected', identity: null, lastSuccessAt: null };
function fixture() {
  const client = { list: vi.fn().mockResolvedValue([account, blank]), refresh: vi.fn().mockResolvedValue([account, blank]) };
  const cards = { load: vi.fn().mockResolvedValue({ ids: [], removedIds: [] }), save: vi.fn() };
  return { client, cards, store: createTrayMonitor(client, cards) };
}

describe('read-only tray monitor', () => {
  it('refreshes a configured Claude login so an existing slot can acquire its first quota', async () => {
    const { client, store } = fixture();
    const claude: ProviderAccount = { ...account, id: 'claude-1', providerId: 'claude', status: 'configured' };
    client.list.mockResolvedValue([claude]);
    await store.getState().open();
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith('claude-1');
  });
  it('shows added/connected cards, refreshes only visible quota accounts and never writes card settings', async () => {
    const { client, cards, store } = fixture();
    await store.getState().open();
    expect(store.getState().accounts.map((row) => row.id)).toEqual(['codex-1']);
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith('codex-1');
    expect(cards.save).not.toHaveBeenCalled();
    expect(store.getState().loading).toBe(false);
  });

  it('rereads added cards on each open, without probing a signed-out slot', async () => {
    const { client, cards, store } = fixture();
    await store.getState().open(); store.getState().close();
    cards.load.mockResolvedValue({ ids: ['codex-2'], removedIds: [] }); client.refresh.mockClear();
    await store.getState().open();
    expect(store.getState().accounts.map((row) => row.id)).toEqual(['codex-2', 'codex-1']);
    expect(client.refresh).toHaveBeenCalledExactlyOnceWith('codex-1');
    expect(cards.save).not.toHaveBeenCalled();
  });

  it('stops showing and refreshing a connected account removed in the main window', async () => {
    const { cards, client, store } = fixture();
    await store.getState().open();
    cards.load.mockResolvedValue({ ids: ['codex-2'], removedIds: ['codex-1'] });
    client.refresh.mockClear();
    await store.getState().refresh();
    expect(store.getState().accounts).toEqual([blank]);
    store.getState().close();
    await store.getState().open();
    expect(store.getState().accounts).toEqual([blank]);
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('discards a late result after close/reopen, including a replaced account identity', async () => {
    const { client, store } = fixture();
    let resolve!: (rows: ProviderAccount[]) => void;
    client.list.mockImplementationOnce(() => new Promise<ProviderAccount[]>((done) => { resolve = done; }));
    const old = store.getState().open();
    store.getState().close();
    const replacement = { ...account, identity: { ...account.identity!, key: 'replacement', email: 'new@example.invalid' } };
    client.list.mockResolvedValue([replacement]);
    await store.getState().open();
    resolve([account]); await old;
    expect(store.getState().accounts[0].identity?.key).toBe('replacement');
  });

  it('keeps last-good data with an explicit refresh failure and stops while hidden', async () => {
    const { client, store } = fixture();
    client.refresh.mockRejectedValue(new Error('fixture unavailable'));
    await store.getState().open();
    expect(store.getState().accounts[0].id).toBe('codex-1');
    expect(store.getState().error).toBe('refreshFailed');
    expect(store.getState().accounts[0].status).toBe('error');
    store.getState().close(); client.refresh.mockClear();
    await store.getState().refresh();
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('shows storage failure instead of claiming the account list is empty', async () => {
    const { cards, store, client } = fixture(); cards.load.mockRejectedValue(new Error('fixture unavailable'));
    await store.getState().open();
    expect(store.getState().error).toBe('cardsLoadFailed');
    expect(client.refresh).not.toHaveBeenCalled();
    expect(cards.save).not.toHaveBeenCalled();
  });
});
