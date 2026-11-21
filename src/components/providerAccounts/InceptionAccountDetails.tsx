import { useEffect, useId, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderAccount } from '../../services/providerAccounts/types';

// Published tiers, not an observation of the connected account's effective limits.
const PUBLISHED_LIMITS = [
  { label: 'requests', free: 1000, payg: 3000 },
  { label: 'inputTokens', free: 1000000, payg: 3000000 },
  { label: 'outputTokens', free: 100000, payg: 300000 },
] as const;

export function InceptionAccountDetails({ account, disabled, onConnect }: {
  account: ProviderAccount;
  disabled: boolean;
  onConnect: (accountId: string, apiKey: string) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const hintId = useId();
  const number = (value: number) => value.toLocaleString(i18n.language);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  return <>
    <div className="provider-reset-tokens"><span>{t('providerAccounts.inception.oneTimeGrant')}</span><strong>{number(100000000)}</strong></div>
    <p>{t('providerAccounts.inception.grantHint')}</p>
    <div className="provider-reset-tokens"><span>{t('providerAccounts.inception.remainingCredit')}</span><strong>{t('providerAccounts.unknown')}</strong></div>
    <p>{t('providerAccounts.inception.balanceUnavailable')}</p>
    <div className="provider-table-scroll">
      <table className="provider-published-limits" aria-label={t('providerAccounts.inception.publishedLimits')}>
        <caption>{t('providerAccounts.inception.publishedLimits')}</caption>
        <thead><tr><th scope="col">{t('providerAccounts.inception.perMinute')}</th>
          <th scope="col">{t('providerAccounts.inception.free')}</th><th scope="col">{t('providerAccounts.inception.payg')}</th></tr></thead>
        <tbody>{PUBLISHED_LIMITS.map((limit) => <tr key={limit.label}>
          <th scope="row">{t(`providerAccounts.inception.${limit.label}`)}</th><td>{number(limit.free)}</td><td>{number(limit.payg)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p>{t('providerAccounts.inception.limitsHint')}</p>
    <button ref={trigger} type="button" className="ui-button" aria-expanded={open} disabled={disabled || saving}
      onClick={() => setOpen(!open)}><KeyRound />{t('providerAccounts.inception.manageKey')}</button>
    {open && <form className="provider-key-form" aria-label={t('providerAccounts.inception.manageKey')}
      onKeyDown={(event) => { if (event.key === 'Escape' && !saving) { event.preventDefault(); close(); } }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || saving || !input.current?.value) return;
        const apiKey = input.current.value;
        input.current.value = '';
        setSaving(true);
        try { if (await onConnect(account.id, apiKey)) close(); }
        finally { setSaving(false); }
      }}>
      <label className="ui-field" htmlFor={inputId}>{t('providerAccounts.inception.apiKey')}
        <input ref={input} id={inputId} className="ui-input" type="password" autoComplete="off" spellCheck={false}
          required maxLength={512} pattern="[^\s]+" aria-describedby={hintId} disabled={disabled || saving} /></label>
      <p id={hintId}>{t('providerAccounts.inception.keyHint')}</p>
      <div className="provider-key-actions">
        <button type="submit" className="ui-button" disabled={disabled || saving}>{t(saving ? 'providerAccounts.inception.verifying' : 'providerAccounts.inception.verifyKey')}</button>
        <button type="button" className="ui-button" disabled={saving} onClick={close}>{t('providerAccounts.cancelAdd')}</button>
      </div>
    </form>}
    <p>{t('providerAccounts.inception.browserHint')}</p>
  </>;
}
