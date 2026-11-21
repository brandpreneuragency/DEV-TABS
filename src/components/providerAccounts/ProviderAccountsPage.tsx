import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Plus, RefreshCw, UserRound, UserRoundMinus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauriRuntime } from '../../services/runtime';
import { accountIsStale, billingResetTime, remainingPercent, USAGE_REFRESH_MS, usageWindow } from '../../services/providerAccounts/model';
import { availableAccountProviders, useProviderAccountsStore } from '../../services/providerAccounts/store';
import type { ProviderAccount, UsageWindow } from '../../services/providerAccounts/types';
import { ACCOUNT_PROVIDERS } from '../../services/providerAccounts/types';
import { PrimaryWorkspaceContent } from '../layout/workspace';
import { AssistantToggle } from '../layout/workspace/AssistantToggle';
import { InceptionAccountDetails } from './InceptionAccountDetails';
import { BankedResets } from './BankedResets';
import './providerAccounts.css';

export function ProviderAccountsPage({ store = useProviderAccountsStore }: { store?: typeof useProviderAccountsStore }) {
  const { t, i18n } = useTranslation();
  const accounts = store((state) => state.accounts);
  const cardIds = store((state) => state.cardIds);
  const cardsLoaded = store((state) => state.cardsLoaded);
  const savingCards = store((state) => state.savingCards);
  const cardError = store((state) => state.cardError);
  const loaded = store((state) => state.loaded);
  const loading = store((state) => state.loading);
  const refreshing = store((state) => state.refreshing);
  const error = store((state) => state.error);
  const pending = store((state) => state.pendingLogins);
  const actionErrors = store((state) => state.actionErrors);
  const [now, setNow] = useState(() => Date.now());
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const providerFilter = store((state) => state.providerFilter);
  const providerToAdd = store((state) => state.providerToAdd);
  const setProviderToAdd = store((state) => state.setProviderToAdd);
  const addOpen = providerToAdd !== null;
  const providerInput = useRef<HTMLSelectElement>(null);
  const visibleAccounts = cardIds.flatMap((id) => accounts.find((account) => account.id === id) ?? [])
    .filter((account) => providerFilter === null || account.providerId === providerFilter);
  const selectedProvider = ACCOUNT_PROVIDERS.find((provider) => provider.id === providerFilter);
  const availableProviders = availableAccountProviders(accounts, cardIds);
  const desktop = isTauriRuntime();
  const stamp = (value: number | null) => value === null ? t('providerAccounts.unknown')
    : new Date(value).toLocaleString(i18n.language);

  useEffect(() => {
    if (!desktop) return;
    void store.getState().load().then(() => store.getState().refresh());
  }, [desktop, store]);
  useEffect(() => {
    if (addOpen) providerInput.current?.focus();
  }, [addOpen]);
  useEffect(() => () => { setProviderToAdd(null); }, [setProviderToAdd]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!desktop || !autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void store.getState().refresh();
    }, USAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, desktop, store]);
  const hasPending = Object.keys(pending).length > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => { void store.getState().pollLogins(); }, 2000);
    return () => window.clearInterval(timer);
  }, [hasPending, store]);

  const refresh = () => {
    if (!loaded || !cardsLoaded) { void store.getState().load().then(() => store.getState().refresh()); return; }
    void store.getState().refresh();
    setNow(Date.now());
  };
  const closeAdd = () => {
    setProviderToAdd(null);
    document.getElementById('provider-accounts-add-button')?.focus();
  };
  const addAccount = async () => {
    if (!providerToAdd || !await store.getState().addAccount(providerToAdd)) return;
    if (store.getState().providerToAdd !== providerToAdd) return;
    if (providerFilter !== null) store.getState().selectProvider(providerToAdd);
    closeAdd();
  };
  const removeAccount = async (id: string) => {
    if (await store.getState().removeAccount(id)) {
      document.getElementById('provider-accounts-add-button')?.focus();
    }
  };
  const connect = async (id: string) => {
    setConnecting(id);
    try { await store.getState().connect(id); } finally { setConnecting(null); }
  };
  const connectApiKey = async (id: string, apiKey: string) => {
    setConnecting(id);
    try { return await store.getState().connectApiKey(id, apiKey); } finally { setConnecting(null); }
  };
  const limitBlock = (usedPercent: number | null, resetsAt: number | null, title: string) => {
    const remaining = remainingPercent(usedPercent);
    if (remaining === null) return null;

    const value = remaining.toLocaleString(i18n.language, { maximumFractionDigits: 1 });
    const remainingText = t('providerAccounts.remaining', { value });
    const minutes = resetsAt === null ? 0 : Math.max(0, Math.ceil((resetsAt - now) / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    const reset = resetsAt === null ? t('providerAccounts.resetUnknown')
      : resetsAt <= now ? t('providerAccounts.resetAwaitingRefresh')
        : days > 0 ? t('providerAccounts.resetDaysHoursMinutes', { days, hours, minutes: minutes % 60 })
          : hours > 0 ? t('providerAccounts.resetHoursMinutes', { hours, minutes: minutes % 60 })
            : t('providerAccounts.resetMinutes', { minutes });
    return <div className="provider-limit">
      <div className="provider-limit-heading"><div className="provider-limit-label"><span>{title}</span>
        <span className="provider-reset-countdown" title={resetsAt === null ? reset : t('providerAccounts.resetsAt', { time: stamp(resetsAt) })}
          aria-label={resetsAt !== null && resetsAt > now ? t('providerAccounts.resetsIn', { time: reset }) : reset}>
          {reset}</span></div>
        <strong title={remainingText}>{t('providerAccounts.percent', { value })}</strong></div>
      <progress max={100} value={remaining} aria-label={title} aria-valuetext={remainingText} />
    </div>;
  };
  const windowBlock = (window: UsageWindow | null, title: string) =>
    limitBlock(window?.usedPercent ?? null, window?.resetsAt ?? null, title);
  const accountCard = (account: ProviderAccount) => {
    const provider = ACCOUNT_PROVIDERS.find((entry) => entry.id === account.providerId);
    const apiKey = provider?.authKind === 'apiKey';
    const billing = account.usage?.billing;
    const busy = Boolean(pending[account.id]) || connecting === account.id;
    return <article key={account.id} className="ui-card provider-account-card" aria-label={account.label}>
      <header className="provider-card-heading"><div><h2>{account.label}</h2>
        <p>{apiKey ? t('providerAccounts.inception.accessOnly') : account.identity?.email ?? account.identity?.workspaceId ?? t(account.identity || account.status === 'configured'
          ? 'providerAccounts.identityUnavailable' : 'providerAccounts.noAccount')}</p></div>
        <div className="provider-card-actions">
          <span className="provider-last-read" title={stamp(account.lastSuccessAt)}>{t('providerAccounts.lastRead', {
            time: account.lastSuccessAt === null ? t('providerAccounts.unknown') : new Date(account.lastSuccessAt).toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' }),
          })}</span>
          {pending[account.id] ? <>
            {pending[account.id].flow !== 'cli' && <button type="button" className="ui-button" onClick={() => void store.getState().openLogin(account.id)}><ExternalLink />{t('providerAccounts.openBrowser')}</button>}
            <button type="button" className="ui-button" onClick={() => void store.getState().cancelLogin(account.id)}>{t('providerAccounts.cancelLogin')}</button>
          </> : !apiKey && ['disconnected', 'authRequired', 'error'].includes(account.status) ? <button type="button" className="ui-button" disabled={!desktop || busy || connecting !== null || hasPending || savingCards}
            onClick={() => void connect(account.id)}><UserRound />{t(account.identity ? 'providerAccounts.reconnect' : 'providerAccounts.connect')}</button>
            : <span className="provider-status" data-status={account.status} role="img"
              aria-label={t(apiKey && account.status === 'configured' ? 'providerAccounts.inception.savedKey' : `providerAccounts.status.${account.status}`)}
              title={t(apiKey && account.status === 'configured' ? 'providerAccounts.inception.savedKey' : `providerAccounts.status.${account.status}`)} />}
          {provider?.externalUsage && <button type="button" className="ui-button" disabled={!desktop}
            onClick={() => void store.getState().openUsage(account.id)}><ExternalLink />{t(apiKey ? 'providerAccounts.inception.openBilling' : 'providerAccounts.openUsage')}</button>}
          <button type="button" className="ui-button ui-button--compact ui-button--ghost ui-button--danger" disabled={!desktop || !cardsLoaded || loading || savingCards || busy}
            aria-label={t('providerAccounts.removeAccount', { account: account.label })}
            title={t('providerAccounts.removeAccount', { account: account.label })}
            onClick={() => void removeAccount(account.id)}><UserRoundMinus aria-hidden="true" />{t('providerAccounts.remove')}</button>
        </div></header>
      {account.duplicateOf ? <p role="status">{t('providerAccounts.duplicate', { account: account.duplicateOf })}</p> : provider?.usageKind === 'windows' ? <>
        {windowBlock(usageWindow(account.usage, 300), t('providerAccounts.fiveHour'))}
        {windowBlock(usageWindow(account.usage, 10080), t('providerAccounts.weekly'))}
        {account.providerId === 'claude' && windowBlock(usageWindow(account.usage, 10080, 'weeklyFable'), t('providerAccounts.fableWeekly'))}
      </> : provider?.usageKind === 'billing' ? <>
        {limitBlock(billing?.usedPercent ?? null, billingResetTime(billing?.resetsAt), t(billing?.period === 'weekly'
          ? 'providerAccounts.weekly' : billing?.period === 'monthly' ? 'providerAccounts.monthly' : 'providerAccounts.allowance'))}
        <div className="provider-reset-tokens"><span>{t('providerAccounts.prepaidBalance')}</span><strong>{billing?.prepaidBalanceCents == null
          ? t('providerAccounts.unknown') : new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(billing.prepaidBalanceCents / 100)}</strong></div>
      </> : provider?.usageKind === 'publishedLimits' ? <InceptionAccountDetails account={account}
        disabled={!desktop || connecting !== null || hasPending || savingCards} onConnect={connectApiKey} />
        : <p>{t('providerAccounts.usageUnavailable')}</p>}
      <BankedResets account={account} now={now} />
      {provider?.usage && accountIsStale(account, now) && <p className="provider-warning">{t('providerAccounts.stale')}</p>}
      {account.status === 'configured' && <p>{t(apiKey ? 'providerAccounts.inception.savedKey' : 'providerAccounts.configuredHint')}</p>}
      {account.error && <p className="provider-warning" role="status">{t(apiKey ? 'providerAccounts.inception.checkFailed' : account.providerId === 'openai-codex' ? 'providerAccounts.accountError'
        : `providerAccounts.externalErrors.${['cliUnavailable', 'unsupportedAuth', 'unsupportedProtocol', 'unsafeStorage', 'loginExpired',
          'claudeAuthRequired', 'claudeAccessDenied', 'claudeRateLimited', 'claudeInvalidUsage', 'claudeNetworkUnavailable', 'claudeIdentityUnavailable'].includes(account.error) ? account.error : 'checkFailed'}`)}</p>}
      {pending[account.id] && <p role="status">{t(pending[account.id].flow === 'cli' ? 'providerAccounts.cliLoginPending' : 'providerAccounts.loginPending', { provider: provider?.name ?? account.label })}</p>}
      {actionErrors[account.id] && <p role="alert" className="provider-warning">{t(`providerAccounts.errors.${actionErrors[account.id]}`)}</p>}
    </article>;
  };

  return <PrimaryWorkspaceContent mode="providerAccounts" contextPanelAvailable={false} contextPanelOpen={false} contextPanelWidthVw={0}
    centerPanel={<section className="provider-accounts-page" aria-label={t('providerAccounts.title')}>
      <div className="ui-toolbar provider-accounts-toolbar"><h1>{selectedProvider?.name ?? t('providerAccounts.title')}</h1>
        <div className="provider-toolbar-actions"><label className="provider-auto-refresh"><input type="checkbox" checked={autoRefresh}
          onChange={(event) => setAutoRefresh(event.currentTarget.checked)} />{t('providerAccounts.autoRefresh')}</label>
          <button type="button" className="ui-button" disabled={!desktop || loading || refreshing || savingCards}
            aria-busy={loading || refreshing} onClick={refresh}><RefreshCw />{t(loading ? 'providerAccounts.loading'
              : refreshing ? 'providerAccounts.refreshing' : 'providerAccounts.refresh')}</button>
          <AssistantToggle id="provider-accounts-btn-assistant" variant="header" />
        </div>
      </div>
      <div className="ui-page-body provider-accounts-body">
        {!desktop && <p role="status">{t('providerAccounts.desktopOnly')}</p>}
        {addOpen && <form id="provider-accounts-add-form" className="ui-card provider-add-form" aria-label={t('providerAccounts.addAccount')}
          onSubmit={(event) => { event.preventDefault(); void addAccount(); }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeAdd(); } }}>
          <label className="ui-field provider-add-provider">{t('providerAccounts.provider')}
            <select ref={providerInput} className="ui-input" value={providerToAdd} disabled={savingCards}
              onChange={(event) => setProviderToAdd(event.currentTarget.value)}>
              <option value="" disabled>{t('providerAccounts.chooseProvider')}</option>
              {ACCOUNT_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}
                disabled={!availableProviders.some((available) => available.id === provider.id)}>{provider.name}</option>)}
            </select>
          </label>
          <button type="submit" className="ui-button" disabled={savingCards || !availableProviders.some((provider) => provider.id === providerToAdd)}>
            <Plus />{t('providerAccounts.addAccount')}</button>
          <button type="button" className="ui-button" disabled={savingCards} onClick={closeAdd}>{t('providerAccounts.cancelAdd')}</button>
          <p className="provider-description">{t(providerToAdd
            ? `providerAccounts.descriptions.${providerToAdd}` : 'providerAccounts.errors.accountLimit')}</p>
        </form>}
        {loading && <p role="status">{t('providerAccounts.loading')}</p>}
        {error && <p role="alert" className="provider-warning">{t(`providerAccounts.errors.${error}`)}</p>}
        {cardError && <p role="alert" className="provider-warning">{t(`providerAccounts.errors.${cardError}`)}</p>}
        {loaded && cardsLoaded && !visibleAccounts.length && <p role="status">{selectedProvider
          ? t('providerAccounts.emptyProvider', { provider: selectedProvider.name }) : t('providerAccounts.empty')}</p>}
        <div className="provider-accounts-grid">{visibleAccounts.map(accountCard)}</div>
      </div>
    </section>} />;
}
