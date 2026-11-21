import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderAccount } from '../../services/providerAccounts/types';
import './bankedResets.css';

/** Read-only provider inventory. Expiry never silently changes the reported total. */
export function BankedResets({ account, now }: { account: ProviderAccount; now: number }) {
  const { t, i18n } = useTranslation();
  const inventory = account.usage?.resetCredits;
  const count = inventory?.availableCount ?? account.usage?.resetTokens ?? null;
  const observedAt = inventory?.observedAt ?? account.lastSuccessAt;
  const observedDate = observedAt === null ? null : new Date(observedAt);
  const currentYear = new Date(now).getFullYear();
  const formatTimestamp = (date: Date, precision: 'date' | 'minute' | 'exact') => {
    const exact = precision === 'exact';
    return date.toLocaleString(i18n.language, {
      year: exact || date.getFullYear() !== currentYear ? 'numeric' : undefined,
      month: 'short', day: 'numeric',
      hour: precision === 'date' ? undefined : '2-digit',
      minute: precision === 'date' ? undefined : '2-digit',
      second: exact ? '2-digit' : undefined,
      timeZoneName: exact ? 'longOffset' : undefined,
      fractionalSecondDigits: exact && date.getMilliseconds() !== 0 ? 3 : undefined,
    });
  };
  if (account.duplicateOf || account.status === 'duplicate') return null;
  return <section className="provider-banked" aria-label={t('providerAccounts.banked.title')}>
    <div className="provider-banked-summary">
      {count === null ? <span>{t('providerAccounts.banked.title')}</span>
        : <span className="provider-banked-count">{t('providerAccounts.banked.count', { count })}</span>}
      {!!inventory?.credits.length && <ul className="provider-banked-credits" role="list">
        {inventory.credits.map((credit, index) => {
          const expiry = credit.expiryKnown && credit.expiresAt !== null ? new Date(credit.expiresAt) : null;
          const expired = expiry !== null && expiry.getTime() <= now;
          const kind = t(`providerAccounts.banked.kinds.${credit.kind}`);
          const expiryLabel = expiry
            ? `${t('providerAccounts.banked.expires')} ${formatTimestamp(expiry, 'exact')}`
            : t(credit.expiryKnown ? 'providerAccounts.banked.noExpiry' : 'providerAccounts.banked.expiryUnknown');
          const details = `${kind} ×${credit.count} · ${expiryLabel}${expired ? ` · ${t('providerAccounts.banked.expired')}` : ''}`;
          return <li className="provider-banked-credit" key={index} title={details}>
            <span className="provider-banked-credit-details">{details}</span>
            {expiry ? <time dateTime={expiry.toISOString()} aria-hidden="true">{formatTimestamp(expiry, 'date')}</time>
              : <span aria-hidden="true">{expiryLabel}</span>}
            {expired && <TriangleAlert className="provider-banked-credit-warning" aria-hidden="true" />}
          </li>;
        })}
      </ul>}
    </div>
    {count === null ? <p>{t(account.usage?.resetCreditsError === 'surface'
      ? 'providerAccounts.banked.surface' : 'providerAccounts.banked.unavailable')}</p> : <>
      {observedDate && <span className="provider-banked-observed">
        {t('providerAccounts.banked.observed')} <time dateTime={observedDate.toISOString()}
          title={`${t('providerAccounts.banked.observed')} ${formatTimestamp(observedDate, 'exact')}`}>
          {formatTimestamp(observedDate, 'minute')}
        </time>
      </span>}
      {count > 0 && !inventory?.detailsComplete && <p>{t('providerAccounts.banked.partial')}</p>}
      {(account.usage?.resetCreditsError || account.status !== 'connected') && <p>{t('providerAccounts.banked.lastKnown')}</p>}
    </>}
  </section>;
}
