import { isTauriRuntime } from '../runtime';
import type {
  AccountLoginPoll, AccountLoginStart, ConsumerObservation, ProviderAccount, ProviderAccountsClient,
} from './types';

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriRuntime()) throw new Error('Provider accounts require the TABS desktop app');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Only an explicitly entered API key is sent to native storage; no saved secret is returned. No arbitrary URL/RPC/shell input. */
export const providerAccountsClient: ProviderAccountsClient = {
  list: () => call<ProviderAccount[]>('provider_accounts_list'),
  refresh: (accountId) => call<ProviderAccount[]>('provider_accounts_refresh', { accountId: accountId ?? null }),
  connectApiKey: (accountId, apiKey) => call<ProviderAccount>('provider_accounts_connect_api_key', { accountId, apiKey }),
  beginLogin: (accountId) => call<AccountLoginStart>('provider_accounts_begin_login', { accountId }),
  openLogin: (accountId, loginId) => call<void>('provider_accounts_open_login', { accountId, loginId }),
  pollLogin: (accountId, loginId) => call<AccountLoginPoll>('provider_accounts_poll_login', { accountId, loginId }),
  cancelLogin: (accountId, loginId) => call<void>('provider_accounts_cancel_login', { accountId, loginId }),
  openUsage: (accountId) => call<void>('provider_accounts_open_usage', { accountId }),
  connections: () => call<ConsumerObservation[]>('provider_connections_refresh'),
};
