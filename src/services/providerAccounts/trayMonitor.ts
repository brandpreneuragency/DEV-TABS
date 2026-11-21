import { create } from 'zustand';
import { accountCardIds, createAccountCardsStorage, type AccountCardPreferences, type AccountCardsStorage } from './cards';
import { providerAccountsClient } from './desktopClient';
import { ACCOUNT_PROVIDERS, type ProviderAccount, type ProviderAccountsClient } from './types';

interface TrayMonitorState {
  accounts: ProviderAccount[];
  loading: boolean;
  refreshing: boolean;
  active: boolean;
  error: 'loadFailed' | 'cardsLoadFailed' | 'refreshFailed' | null;
  open(): Promise<void>;
  close(): void;
  refresh(): Promise<void>;
}

/** Separate presentation state, but the same native account authority. No settings/login writes. */
export function createTrayMonitor(
  client: Pick<ProviderAccountsClient, 'list' | 'refresh'>,
  cards: Pick<AccountCardsStorage, 'load'>,
) {
  let generation = 0;
  return create<TrayMonitorState>((set, get) => ({
    accounts: [], loading: false, refreshing: false, active: false, error: null,
    open: async () => {
      generation++;
      set({ active: true, loading: true, refreshing: false, error: null });
      await get().refresh();
    },
    close: () => { generation++; set({ active: false, loading: false, refreshing: false }); },
    refresh: async () => {
      if (!get().active || get().refreshing) return;
      const epoch = generation;
      set({ refreshing: true, error: null });
      try {
        const rows = await client.list();
        if (epoch !== generation) return;
        let preferences: AccountCardPreferences;
        try {
          preferences = await cards.load();
        } catch {
          if (epoch === generation) set({ accounts: [], error: 'cardsLoadFailed' });
          return;
        }
        if (epoch !== generation) return;
        const visible = (snapshot: ProviderAccount[]) => accountCardIds(preferences, snapshot)
          .flatMap((id) => snapshot.find((row) => row.id === id) ?? []);
        const accounts = visible(rows);
        set({ accounts, loading: false });
        const targets = accounts.filter((row) => row.identity && !row.duplicateOf && row.status !== 'duplicate'
          && (row.status === 'connected' || row.status === 'error' || (row.providerId === 'claude' && row.status === 'configured'))
          && ACCOUNT_PROVIDERS.some((provider) => provider.id === row.providerId && provider.usage));
        for (const row of targets) {
          if (epoch !== generation) return;
          try {
            await client.refresh(row.id);
            if (epoch !== generation) return;
            // Reconcile all sanitized rows, including identity/duplicate changes from the main window.
            const rows = await client.list();
            if (epoch === generation) set({ accounts: visible(rows) });
          } catch {
            if (epoch === generation) set({ error: 'refreshFailed', accounts: get().accounts.map((current) =>
              current.id === row.id ? { ...current, status: 'error', error: 'refreshFailed' } : current) });
          }
        }
      } catch {
        if (epoch === generation) set({ accounts: [], error: 'loadFailed' });
      } finally {
        if (epoch === generation) set({ loading: false, refreshing: false });
      }
    },
  }));
}

export const useTrayMonitor = createTrayMonitor(providerAccountsClient, createAccountCardsStorage());
