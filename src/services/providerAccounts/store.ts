import { create } from 'zustand';
import { providerAccountsClient } from './desktopClient';
import { accountCardIds, createAccountCardsStorage, type AccountCardPreferences, type AccountCardsStorage } from './cards';
import { ACCOUNT_PROVIDERS, CONSUMER_IDS, type AccountLoginStart, type ConsumerObservation, type ProviderAccount, type ProviderAccountsClient } from './types';

interface ProviderAccountsState {
  providerFilter: string | null;
  providerToAdd: string | null;
  selectProvider(providerId: string | null): void;
  openAddForm(): void;
  setProviderToAdd(providerId: string | null): void;
  accounts: ProviderAccount[];
  cardIds: string[];
  cardsLoaded: boolean;
  savingCards: boolean;
  cardError: string | null;
  connections: ConsumerObservation[];
  loaded: boolean;
  loading: boolean;
  refreshing: boolean;
  observing: boolean;
  error: string | null;
  connectionError: string | null;
  actionErrors: Record<string, string>;
  pendingLogins: Record<string, AccountLoginStart>;
  load(): Promise<void>;
  addAccount(providerId: string): Promise<boolean>;
  removeAccount(accountId: string): Promise<boolean>;
  refresh(accountId?: string): Promise<void>;
  refreshConnections(): Promise<void>;
  connect(accountId: string): Promise<void>;
  connectApiKey(accountId: string, apiKey: string): Promise<boolean>;
  openLogin(accountId: string): Promise<void>;
  openUsage(accountId: string): Promise<void>;
  pollLogins(): Promise<void>;
  cancelLogin(accountId: string): Promise<void>;
}

export function availableAccountProviders(accounts: ProviderAccount[], cardIds: string[]) {
  return ACCOUNT_PROVIDERS.filter((provider) => accounts.some((account) =>
    account.providerId === provider.id && !cardIds.includes(account.id)));
}

export function createProviderAccountsStore(client: ProviderAccountsClient, cards: AccountCardsStorage = createAccountCardsStorage()) {
  const versions = new Map<string, number>();
  const starting = new Set<string>();
  const polling = new Set<string>();
  let removedIds: string[] = [];
  const version = (id: string) => versions.get(id) ?? 0;
  const invalidate = (id: string) => versions.set(id, version(id) + 1);
  return create<ProviderAccountsState>((set, get) => {
    const merge = (rows: ProviderAccount[], expected: Map<string, number>, only?: Set<string>) => {
      const accounts = new Map(get().accounts.map((row) => [row.id, row]));
      for (const row of rows) {
        if ((!only || only.has(row.id)) && version(row.id) === (expected.get(row.id) ?? 0)) accounts.set(row.id, row);
      }
      const rowsToKeep = [...accounts.values()].sort((left, right) => left.id.localeCompare(right.id));
      set({ accounts: rowsToKeep });
    };
    const canChangeCards = () => get().loaded && get().cardsLoaded && !get().loading && !get().savingCards;
    const saveCards = async (preferences: AccountCardPreferences) => {
      set({ savingCards: true, cardError: null });
      try {
        await cards.save(preferences);
        removedIds = preferences.removedIds;
        set({ cardIds: preferences.ids });
        return true;
      } catch { set({ cardError: 'cardsSaveFailed' }); return false; }
      finally { set({ savingCards: false }); }
    };
    const actionError = (id: string, error: string) => set({ actionErrors: { ...get().actionErrors, [id]: error } });
    const clearActionError = (id: string) => {
      const actionErrors = { ...get().actionErrors }; delete actionErrors[id]; set({ actionErrors });
    };
    const removeLogin = (id: string) => {
      const pendingLogins = { ...get().pendingLogins }; delete pendingLogins[id]; set({ pendingLogins });
    };
    return {
      providerFilter: null, providerToAdd: null,
      selectProvider: (providerFilter) => set({ providerFilter, providerToAdd: null }),
      setProviderToAdd: (providerToAdd) => set({ providerToAdd }),
      openAddForm: () => {
        const { accounts, cardIds, providerFilter } = get();
        const available = availableAccountProviders(accounts, cardIds);
        const preferred = available.find((provider) => provider.id === providerFilter) ?? available[0];
        set({ providerToAdd: preferred?.id ?? '' });
      },
      cardIds: [], cardsLoaded: false, savingCards: false, cardError: null,
      accounts: [], connections: CONSUMER_IDS.map((id) => ({ id, providerId: null, identity: null,
        evidence: 'unavailable', observedAt: null, error: null })),
      loaded: false, loading: false, refreshing: false, observing: false, error: null, connectionError: null,
      actionErrors: {}, pendingLogins: {},
      load: async () => {
        if (get().loading || get().savingCards) return;
        const expected = new Map(versions); set({ loading: true, error: null });
        try {
          merge(await client.list(), expected); set({ loaded: true });
          try {
            const saved = await cards.load();
            removedIds = saved.removedIds;
            const ids = accountCardIds({ ids: [...saved.ids, ...get().cardIds], removedIds }, get().accounts);
            set({ cardIds: ids, cardsLoaded: true, cardError: null });
            if (ids.length !== saved.ids.length || ids.some((id, index) => id !== saved.ids[index])) {
              try { await cards.save({ ids, removedIds }); }
              catch { set({ cardError: 'cardsSaveFailed' }); }
            }
          } catch {
            // Only the last confirmed selection can distinguish removed accounts from active ones.
            set({ cardsLoaded: false, cardError: 'cardsLoadFailed' });
          }
        }
        catch { set({ error: 'loadFailed' }); }
        finally { set({ loading: false }); }
      },
      addAccount: async (providerId) => {
        if (!canChangeCards()) return false;
        const account = ACCOUNT_PROVIDERS.some((provider) => provider.id === providerId)
          ? get().accounts.find((row) => row.providerId === providerId && !get().cardIds.includes(row.id)) : undefined;
        if (!account) { set({ cardError: 'accountLimit' }); return false; }
        return saveCards({ ids: [...get().cardIds, account.id], removedIds: removedIds.filter((id) => id !== account.id) });
      },
      removeAccount: async (accountId) => {
        if (!canChangeCards() || !get().cardIds.includes(accountId) || starting.has(accountId) || get().pendingLogins[accountId]) return false;
        invalidate(accountId);
        return saveCards({ ids: get().cardIds.filter((id) => id !== accountId), removedIds: [...removedIds, accountId] });
      },
      refresh: async (accountId) => {
        if (get().refreshing || !get().cardsLoaded || get().savingCards) return;
        const targets = new Set(get().accounts.filter((row) => get().cardIds.includes(row.id) && (!accountId || row.id === accountId)
          && !get().pendingLogins[row.id] && !starting.has(row.id)).map((row) => row.id));
        if (!targets.size) return;
        targets.forEach(invalidate); const expected = new Map(versions);
        set({ refreshing: true, error: null });
        try {
          for (const id of targets) {
            if (version(id) !== expected.get(id)) continue;
            try { merge(await client.refresh(id), expected, new Set([id])); }
            catch {
              if (version(id) !== expected.get(id)) continue;
              const accounts = get().accounts.map((row) => row.id === id
                ? { ...row, status: 'error' as const, error: 'refreshFailed', lastAttemptAt: Date.now() } : row);
              set({ accounts, error: 'refreshFailed' });
            }
          }
        } finally { set({ refreshing: false }); }
      },
      refreshConnections: async () => {
        if (get().observing) return;
        set({ observing: true, connectionError: null });
        try {
          const rows = await client.connections();
          set({ connections: CONSUMER_IDS.map((id) => rows.find((row) => row.id === id)
            ?? { id, providerId: null, identity: null, evidence: 'unavailable', observedAt: null, error: 'sourceUnavailable' }) });
        } catch {
          set({ connectionError: 'connectionFailed', connections: get().connections.map((row) => ({
            ...row, providerId: null, identity: null, observedAt: null, evidence: 'unavailable', error: 'connectionFailed',
          })) });
        } finally { set({ observing: false }); }
      },
      connectApiKey: async (accountId, apiKey) => {
        const row = get().accounts.find((account) => account.id === accountId);
        if (!row || row.id !== 'inception-1' || row.providerId !== 'inception' || !get().cardIds.includes(accountId)
          || get().savingCards || starting.has(accountId) || get().pendingLogins[accountId]) return false;
        starting.add(accountId); invalidate(accountId); clearActionError(accountId);
        const epoch = version(accountId);
        try {
          const account = await client.connectApiKey(accountId, apiKey);
          if (version(accountId) !== epoch) return false;
          if (account.id !== accountId || account.providerId !== row.providerId) {
            actionError(accountId, 'loginMismatch'); return false;
          }
          invalidate(accountId);
          merge([account], new Map([[accountId, version(accountId)]]), new Set([accountId]));
          return true;
        } catch { if (version(accountId) === epoch) actionError(accountId, 'apiKeyFailed'); return false; }
        finally { starting.delete(accountId); }
      },
      connect: async (accountId) => {
        if (get().accounts.some((row) => row.id === accountId && ACCOUNT_PROVIDERS.some((provider) =>
          provider.id === row.providerId && provider.authKind === 'apiKey'))) return;
        if (get().savingCards || removedIds.includes(accountId) || starting.has(accountId) || get().pendingLogins[accountId]) return;
        starting.add(accountId); invalidate(accountId); clearActionError(accountId);
        set({ accounts: get().accounts.map((row) => row.id === accountId ? {
          ...row, identity: null, usage: null, lastSuccessAt: null, status: 'authRequired', duplicateOf: null, error: null,
        } : row) });
        try {
          const login = await client.beginLogin(accountId);
          if (login.accountId !== accountId) { actionError(accountId, 'loginMismatch'); return; }
          set({ pendingLogins: { ...get().pendingLogins, [accountId]: login } });
          if (login.flow !== 'cli') await get().openLogin(accountId);
        } catch { actionError(accountId, 'loginFailed'); }
        finally { starting.delete(accountId); }
      },
      openLogin: async (accountId) => {
        const login = get().pendingLogins[accountId]; if (!login) return;
        try { await client.openLogin(accountId, login.loginId); clearActionError(accountId); }
        catch { actionError(accountId, 'browserFailed'); }
      },
      openUsage: async (accountId) => {
        try { await client.openUsage(accountId); clearActionError(accountId); }
        catch { actionError(accountId, 'usagePageFailed'); }
      },
      pollLogins: async () => {
        await Promise.all(Object.entries(get().pendingLogins).map(async ([id, login]) => {
          if (polling.has(id)) return; polling.add(id);
          const epoch = version(id);
          try {
            const result = await client.pollLogin(id, login.loginId);
            if (version(id) !== epoch || get().pendingLogins[id]?.loginId !== login.loginId) return;
            if (result.status === 'pending') return;
            removeLogin(id);
            if (result.status !== 'completed' || result.account?.id !== id) {
              actionError(id, result.account && result.account.id !== id ? 'loginMismatch' : 'loginFailed'); return;
            }
            invalidate(id);
            set({ accounts: [...get().accounts.filter((row) => row.id !== id), result.account]
              .sort((left, right) => left.id.localeCompare(right.id)) });
          } catch {
            if (version(id) === epoch) actionError(id, 'loginFailed');
          } finally { polling.delete(id); }
        }));
      },
      cancelLogin: async (accountId) => {
        const login = get().pendingLogins[accountId]; if (!login) return;
        invalidate(accountId);
        try { await client.cancelLogin(accountId, login.loginId); removeLogin(accountId); clearActionError(accountId); }
        catch { actionError(accountId, 'cancelFailed'); }
      },
    };
  });
}

export const useProviderAccountsStore = createProviderAccountsStore(providerAccountsClient);
