import { beforeEach, describe, expect, it, vi } from 'vitest';
import { providerAccountsClient } from './desktopClient';
import type { ProviderAccount } from './types';

const { invoke, desktop } = vi.hoisted(() => ({ invoke: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../runtime', () => ({ isTauriRuntime: desktop }));
beforeEach(() => { invoke.mockReset(); desktop.mockReturnValue(true); });

const account: ProviderAccount = {
  id: 'inception-1', providerId: 'inception', label: 'Inception Labs 1',
  status: 'connected', identity: null, usage: null, duplicateOf: null,
  lastAttemptAt: 1000, lastSuccessAt: 1000, error: null,
};

describe('native API-key account boundary', () => {
  it('sends only the explicit input to the dedicated native command and receives sanitized metadata', async () => {
    invoke.mockResolvedValue(account);
    expect(await providerAccountsClient.connectApiKey('inception-1', 'synthetic-unusable-key')).toEqual(account);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('provider_accounts_connect_api_key', {
      accountId: 'inception-1', apiKey: 'synthetic-unusable-key',
    });
    expect(JSON.stringify(account)).not.toContain('synthetic-unusable-key');
  });

  it('never submits a credential from browser preview', async () => {
    desktop.mockReturnValue(false);
    await expect(providerAccountsClient.connectApiKey('inception-1', 'synthetic-unusable-key')).rejects.toThrow('desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });
});
