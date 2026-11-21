import { billingResetTime, remainingPercent, usageWindow } from './model';
import { ACCOUNT_PROVIDERS, type ProviderAccount } from './types';

const TRAY_PERIODS = ['H', 'W', 'M'] as const;
export type TrayPeriod = typeof TRAY_PERIODS[number];
export interface TrayQuota { remaining: number | null; resetsAt: number | null }

/** Never turn a weekly/unknown allowance into an estimated monthly quota. */
export function trayQuota(account: ProviderAccount, period: TrayPeriod): TrayQuota | null {
  if (account.duplicateOf || account.status === 'duplicate') return null;
  const provider = ACCOUNT_PROVIDERS.find((entry) => entry.id === account.providerId);
  if (provider?.usageKind === 'windows') {
    const window = period === 'M' ? null : usageWindow(account.usage, period === 'H' ? 300 : 10080);
    return window ? { remaining: remainingPercent(window.usedPercent), resetsAt: window.resetsAt } : null;
  }
  const billing = account.usage?.billing;
  if (provider?.usageKind === 'billing' && billing
    && ((period === 'W' && billing.period === 'weekly') || (period === 'M' && billing.period === 'monthly'))) {
    return { remaining: remainingPercent(billing.usedPercent), resetsAt: billingResetTime(billing.resetsAt) };
  }
  return null;
}

export function availableTrayQuotas(account: ProviderAccount) {
  return TRAY_PERIODS.flatMap((period) => {
    const quota = trayQuota(account, period);
    return quota?.remaining == null ? [] : [{ period, remaining: quota.remaining, resetsAt: quota.resetsAt }];
  });
}
