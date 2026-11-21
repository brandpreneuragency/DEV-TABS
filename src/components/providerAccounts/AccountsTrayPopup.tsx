import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isTauriRuntime } from '../../services/runtime';
import { accountIsStale, remainingPercent, usageWindow, USAGE_REFRESH_MS } from '../../services/providerAccounts/model';
import { availableTrayQuotas, type TrayPeriod } from '../../services/providerAccounts/trayModel';
import { useTrayMonitor } from '../../services/providerAccounts/trayMonitor';
import { loadTrayAppearance, trayWindowClient, type TrayWindowClient } from '../../services/providerAccounts/trayWindow';
import type { ProviderAccount } from '../../services/providerAccounts/types';
import { BankedResets } from './BankedResets';
import './accountsTrayPopup.css';

const periodKeys = { H: 'providerAccounts.tray.hourly', W: 'providerAccounts.weekly', M: 'providerAccounts.tray.monthly' } as const;

function TrayAccountRow({ account, now }: { account: ProviderAccount; now: number }) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<TrayPeriod | null>(null);
  const quotas = availableTrayQuotas(account);
  const quota = quotas.find(({ period }) => period === selected) ?? quotas[0];
  const period = quota?.period;
  const fable = account.providerId === 'claude' ? usageWindow(account.usage, 10080, 'weeklyFable') : null;
  const fableRemaining = remainingPercent(fable?.usedPercent ?? null);
  const title = period && t(period === 'H' && ['openai-codex', 'claude'].includes(account.providerId) ? 'providerAccounts.fiveHour' : periodKeys[period]);
  const value = quota?.remaining.toLocaleString(i18n.language, { maximumFractionDigits: 1 });
  const resetsAt = quota?.resetsAt ?? null;
  const minutes = resetsAt === null ? 0 : Math.max(0, Math.ceil((resetsAt - now) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const reset = resetsAt === null ? t('providerAccounts.resetUnknown')
    : resetsAt <= now ? t('providerAccounts.resetAwaitingRefresh')
      : days > 0 ? t('providerAccounts.resetDaysHoursMinutes', { days, hours, minutes: minutes % 60 })
        : hours > 0 ? t('providerAccounts.resetHoursMinutes', { hours, minutes: minutes % 60 })
          : t('providerAccounts.resetMinutes', { minutes });
  const identity = account.identity?.email ?? account.identity?.workspaceId ?? t(account.identity
    ? 'providerAccounts.identityUnavailable' : 'providerAccounts.noAccount');
  const stale = accountIsStale(account, now);
  const status = t(`providerAccounts.status.${account.status}`);
  const readTime = account.lastSuccessAt === null ? t('providerAccounts.unknown')
    : new Date(account.lastSuccessAt).toLocaleString(i18n.language);
  const remainingText = value === undefined ? undefined : t('providerAccounts.remaining', { value });
  return <article className="accounts-tray-row" aria-label={account.label}>
    <div className="accounts-tray-identity">
      <div className="accounts-tray-heading">
        <span className="accounts-tray-status" data-status={account.status} data-stale={stale} role="img"
          aria-label={status} title={`${status} · ${t('providerAccounts.lastSuccess', { time: readTime })}`} />
        <h2 title={account.label}>{account.label}</h2>
        {quotas.length > 0 && <>
          <span className="accounts-tray-divider" aria-hidden="true">|</span>
          <div className="accounts-tray-periods" role="group" aria-label={t('providerAccounts.tray.period', { account: account.label })}>
            {quotas.map(({ period: option }) => <button key={option} type="button" className="ui-icon-button accounts-tray-period"
              aria-label={t(periodKeys[option])} title={t(periodKeys[option])} aria-pressed={period === option}
              onClick={() => setSelected(option)}>{option}</button>)}
          </div>
        </>}
      </div>
      <p className="accounts-tray-email" title={identity}>{identity}</p>
      {stale && account.lastSuccessAt !== null && <p className="accounts-tray-warning">{t('providerAccounts.tray.lastKnown')}</p>}
      {account.error && <p className="accounts-tray-warning">{t('providerAccounts.status.error')}</p>}
    </div>
    <div className="accounts-tray-quota">
      {account.duplicateOf || account.status === 'duplicate' ? <p className="accounts-tray-warning">
        {t('providerAccounts.duplicate', { account: account.duplicateOf ?? account.label })}</p> : <>
        {quota && <>
          <div className="accounts-tray-quota-heading">
            <div className="accounts-tray-quota-label"><strong>{title}</strong>
              {resetsAt !== null && <span className="accounts-tray-countdown" title={t('providerAccounts.resetsAt', { time: new Date(resetsAt).toLocaleString(i18n.language) })}
                aria-label={resetsAt > now ? t('providerAccounts.resetsIn', { time: reset }) : reset}>
                <RefreshCw aria-hidden="true" />{reset}</span>}
            </div>
            <strong title={remainingText}>{t('providerAccounts.percent', { value })}</strong>
          </div>
          <progress max={100} value={quota.remaining} aria-label={title} aria-valuetext={remainingText} />
        </>}
        {fableRemaining !== null && <>
          <div className="accounts-tray-quota-heading"><strong>{t('providerAccounts.fableWeekly')}</strong>
            <strong>{t('providerAccounts.percent', { value: fableRemaining.toLocaleString(i18n.language, { maximumFractionDigits: 1 }) })}</strong></div>
          <progress max={100} value={fableRemaining} aria-label={t('providerAccounts.fableWeekly')} />
          <p className="accounts-tray-note">{fable?.resetsAt == null ? t('providerAccounts.resetUnknown')
            : fable.resetsAt <= now ? t('providerAccounts.resetAwaitingRefresh')
              : t('providerAccounts.resetsAt', { time: new Date(fable.resetsAt).toLocaleString(i18n.language) })}</p>
        </>}
        <BankedResets account={account} now={now} />
      </>}
    </div>
  </article>;
}

export default function AccountsTrayPopup({ store = useTrayMonitor, windowClient = trayWindowClient }: {
  store?: typeof useTrayMonitor; windowClient?: TrayWindowClient;
}) {
  const { t } = useTranslation();
  const accounts = store((state) => state.accounts);
  const loading = store((state) => state.loading);
  const refreshing = store((state) => state.refreshing);
  const error = store((state) => state.error);
  const [windowError, setWindowError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const content = useRef<HTMLDivElement>(null);
  const desktop = isTauriRuntime();

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    let frame = 0;
    let lastSize = '';
    const reportSize = () => {
      if (disposed || !content.current) return;
      const style = getComputedStyle(document.documentElement);
      const width = parseFloat(style.getPropertyValue('--accounts-tray-width')) || Math.max(1, window.innerWidth);
      const border = parseFloat(style.getPropertyValue('--border-width')) || 0;
      const height = Math.max(1, Math.ceil(content.current.getBoundingClientRect().height + border * 2));
      const size = `${width}:${height}`;
      if (lastSize === size) return;
      lastSize = size;
      void windowClient.ready(width, height).catch(() => { if (!disposed) setWindowError(true); });
    };
    const scheduleSize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reportSize); };
    const opened = () => {
      if (disposed) return;
      setNow(Date.now());
      void loadTrayAppearance().catch(() => { /* Existing app defaults remain usable. */ });
      void store.getState().open();
    };
    const hidden = () => store.getState().close();
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      hidden();
      void windowClient.hide().catch(() => { if (!disposed) setWindowError(true); });
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', hidden);
    window.addEventListener('resize', scheduleSize);
    void windowClient.listenOpened(opened).then((stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      if (typeof ResizeObserver !== 'undefined' && content.current) {
        observer = new ResizeObserver(scheduleSize);
        observer.observe(content.current);
      }
      // A hidden WebView may suspend animation frames. Readiness must not wait
      // for visibility, because native waits for readiness before showing it.
      reportSize();
    }).catch(() => { if (!disposed) setWindowError(true); });
    const clock = window.setInterval(() => { if (store.getState().active) setNow(Date.now()); }, 30000);
    const refresh = window.setInterval(() => { void store.getState().refresh(); }, USAGE_REFRESH_MS);
    return () => {
      disposed = true; unlisten?.(); observer?.disconnect(); cancelAnimationFrame(frame);
      window.clearInterval(clock); window.clearInterval(refresh); hidden();
      window.removeEventListener('keydown', keydown); window.removeEventListener('blur', hidden);
      window.removeEventListener('resize', scheduleSize);
    };
  }, [desktop, store, windowClient]);

  return <section className="accounts-tray" aria-label={t('providerAccounts.title')} aria-busy={loading || refreshing}>
    <div ref={content} className="accounts-tray-content">
      <header className="accounts-tray-header">
        <h1>{t('providerAccounts.title')}</h1>
        <button type="button" className="ui-button" disabled={!desktop || loading || refreshing}
          aria-busy={loading || refreshing} onClick={() => { void store.getState().open(); }}>
          <RefreshCw aria-hidden="true" />{t(loading ? 'providerAccounts.loading'
            : refreshing ? 'providerAccounts.refreshing' : 'providerAccounts.refresh')}
        </button>
      </header>
      {!desktop ? <p className="accounts-tray-note">{t('providerAccounts.desktopOnly')}</p> : <>
        {windowError && <p className="accounts-tray-warning" role="alert">{t('providerAccounts.tray.windowError')}</p>}
        {error && <p className="accounts-tray-warning" role="alert">{t(`providerAccounts.errors.${error}`)}</p>}
        {loading && <p className="accounts-tray-note" role="status">{t('providerAccounts.loading')}</p>}
        {!loading && !error && accounts.length === 0 && <p className="accounts-tray-note">{t('providerAccounts.tray.empty')}</p>}
        <div hidden={loading}>{accounts.map((account) => <TrayAccountRow key={account.id} account={account} now={now} />)}</div>
      </>}
    </div>
  </section>;
}
