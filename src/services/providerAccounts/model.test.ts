import { describe, expect, it } from 'vitest';
import { accountConnections, accountIsStale, billingResetTime, remainingPercent, usageWindow } from './model';
import type { ConsumerObservation, ProviderAccount } from './types';

const account: ProviderAccount = {
  id: 'codex-1', providerId: 'openai-codex', label: 'Codex 1',
  identity: { key: 'principal-a:workspace-a', email: 'synthetic@example.invalid', workspaceId: 'workspace-a', plan: 'pro' },
  status: 'connected', duplicateOf: null, lastAttemptAt: 1000, lastSuccessAt: 1000, error: null,
  usage: { windows: [], resetTokens: null },
};

describe('provider account presentation rules', () => {
  it('never substitutes a scoped Fable week when the all-model week is missing', () => {
    const usage = { windows: [{ id: 'weeklyFable', windowMinutes: 10080, usedPercent: 20, resetsAt: 9000 }], resetTokens: null };
    expect(usageWindow(usage, 10080)).toBeNull();
    expect(usageWindow(usage, 10080, 'weeklyFable')?.usedPercent).toBe(20);
  });
  it('keeps missing or invalid provider reset timestamps unknown', () => {
    expect(billingResetTime(null)).toBeNull();
    expect(billingResetTime('not-a-date')).toBeNull();
    expect(billingResetTime('2026-06-08T00:00:00Z')).toBe(Date.UTC(2026, 5, 8));
  });

  it('keeps unavailable and invalid percentages unknown rather than reporting full quota', () => {
    expect(remainingPercent(null)).toBeNull();
    expect(remainingPercent(Number.NaN)).toBeNull();
    expect(remainingPercent(-1)).toBeNull();
    expect(remainingPercent(101)).toBeNull();
    expect(remainingPercent(0)).toBe(100);
    expect(remainingPercent(100)).toBe(0);
    expect(remainingPercent(33.5)).toBe(66.5);
  });

  it('identifies five-hour and weekly windows by duration, not response order', () => {
    const usage = { windows: [
      { id: 'primary', windowMinutes: 10080, usedPercent: 70, resetsAt: 9000 },
      { id: 'secondary', windowMinutes: 300, usedPercent: 25, resetsAt: 5000 },
    ], resetTokens: 3 };
    expect(usageWindow(usage, 300)?.usedPercent).toBe(25);
    expect(usageWindow(usage, 10080)?.usedPercent).toBe(70);
    expect(usageWindow(null, 300)).toBeNull();
    expect(usageWindow({ ...usage, windows: [] }, 300)).toBeNull();
  });

  it('never claims old snapshots became fresh because a reset time passed', () => {
    expect(accountIsStale(account, 400000)).toBe(true);
    expect(accountIsStale({ ...account, status: 'error', lastAttemptAt: 2000 }, 2000)).toBe(true);
    expect(accountIsStale({ ...account, lastSuccessAt: null }, 1000)).toBe(true);
    expect(accountIsStale(account, 2000)).toBe(false);
  });

  it('matches consumer bindings by provider and principal/workspace key, never email alone', () => {
    const observation: ConsumerObservation = {
      id: 'hermes-mother', providerId: 'openai-codex', identity: account.identity,
      evidence: 'configured', observedAt: 1000, error: null,
    };
    expect(accountConnections(account, [observation])).toEqual([observation]);
    expect(accountConnections(account, [{ ...observation, identity: { ...account.identity!, key: 'other-workspace' } }])).toEqual([]);
    expect(accountConnections(account, [{ ...observation, evidence: 'unavailable' }])).toEqual([]);
    expect(accountConnections(account, [{ ...observation, providerId: 'another-provider' }])).toEqual([]);
    expect(accountConnections({ ...account, identity: null }, [observation])).toEqual([]);
  });
});
