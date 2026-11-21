import { db, type TabsDB } from '../db';
import type { ProviderAccount } from './types';

export const ACCOUNT_CARDS_KEY = 'providerAccounts.cardIds.v1';

export interface AccountCardPreferences {
  ids: string[];
  removedIds: string[];
}

/** Presentation only: no credentials, identity, quota or native registry migration. */
export interface AccountCardsStorage {
  load(): Promise<AccountCardPreferences>;
  save(preferences: AccountCardPreferences): Promise<void>;
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id: unknown) => typeof id === 'string');
}

export function createAccountCardsStorage(database: Pick<TabsDB, 'settings'> = db): AccountCardsStorage {
  return {
    async load() {
      const row = await database.settings.get(ACCOUNT_CARDS_KEY);
      if (!row) return { ids: [], removedIds: [] };
      const value = row.value;
      if (typeof value !== 'object' || value === null || !isIdList(value.ids)
        || (value.removedIds !== undefined && !isIdList(value.removedIds))) {
        throw new Error('Invalid account card preferences');
      }
      return { ids: [...new Set<string>(value.ids)], removedIds: [...new Set<string>(value.removedIds)] };
    },
    async save({ ids, removedIds }) {
      await database.settings.put({ key: ACCOUNT_CARDS_KEY, value: removedIds.length ? { ids, removedIds } : { ids } });
    },
  };
}

/** Old background checks are not proof that the owner added an empty slot. */
export function accountCardIds({ ids, removedIds }: AccountCardPreferences, accounts: ProviderAccount[]): string[] {
  return [...new Set([...ids, ...accounts.filter((account) => account.identity !== null
    || account.lastSuccessAt !== null || account.status === 'configured'
    || account.status === 'connected' || account.status === 'duplicate').map((account) => account.id)])]
    .filter((id) => !removedIds.includes(id));
}
