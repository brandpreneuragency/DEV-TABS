import { describe, expect, it } from 'vitest';
import { availableTrayQuotas, trayQuota } from './trayModel';
import type { ProviderAccount } from './types';

const account: ProviderAccount = {
  id: 'codex-1', providerId: 'openai-codex', label: 'Codex 1', status: 'connected', duplicateOf: null,
  identity: { key: 'fixture', email: 'fixture@example.invalid', workspaceId: null, plan: null },
  lastSuccessAt: 1000, lastAttemptAt: 1000, error: null,
  usage: { windows: [
    { id: 'primary', windowMinutes: 300, usedPercent: 20, resetsAt: 5000 },
    { id: 'secondary', windowMinutes: 10080, usedPercent: 30, resetsAt: 9000 },
  ], resetTokens: null },
};

describe('tray quota periods', () => {
  it('selects independent reported windows and does not fabricate a monthly Codex quota', () => {
    expect(trayQuota(account, 'H')).toEqual({ remaining: 80, resetsAt: 5000 });
    expect(trayQuota(account, 'W')).toEqual({ remaining: 70, resetsAt: 9000 });
    expect(trayQuota(account, 'M')).toBeNull();
    expect(availableTrayQuotas(account).map(({ period }) => period)).toEqual(['H', 'W']);
  });

  it('defaults to the available period and uses explicit monthly billing only for M', () => {
    const monthly = { ...account, providerId: 'grok', usage: { windows: [], resetTokens: null,
      billing: { period: 'monthly', usedPercent: 40, resetsAt: '2026-11-01T00:00:00Z', prepaidBalanceCents: 2000 } } };
    expect(availableTrayQuotas(monthly).map(({ period }) => period)).toEqual(['M']);
    expect(trayQuota(monthly, 'M')).toEqual({ remaining: 60, resetsAt: Date.parse('2026-11-01T00:00:00Z') });
    expect(trayQuota(monthly, 'W')).toBeNull();
    expect(trayQuota(monthly, 'H')).toBeNull();
    expect(availableTrayQuotas({ ...account, usage: { windows: [account.usage!.windows[1]], resetTokens: null } })
      .map(({ period }) => period)).toEqual(['W']);
  });

  it('keeps missing, invalid and duplicate quotas honest', () => {
    expect(trayQuota({ ...account, duplicateOf: 'codex-2' }, 'H')).toBeNull();
    expect(trayQuota({ ...account, usage: null }, 'W')).toBeNull();
    expect(trayQuota({ ...account, usage: { windows: [
      { id: 'primary', windowMinutes: 300, usedPercent: 101, resetsAt: null },
    ], resetTokens: null } }, 'H')).toEqual({ remaining: null, resetsAt: null });
    expect(trayQuota({ ...account, providerId: 'commandCode' }, 'H')).toBeNull();
  });

  it('shows Claude five-hour and weekly windows but never invents a monthly quota', () => {
    const claude = { ...account, providerId: 'claude' };
    expect(trayQuota(claude, 'H')).toEqual({ remaining: 80, resetsAt: 5000 });
    expect(trayQuota(claude, 'W')).toEqual({ remaining: 70, resetsAt: 9000 });
    expect(trayQuota(claude, 'M')).toBeNull();
  });
});
