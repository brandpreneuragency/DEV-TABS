import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import AccountsTrayPopup from './AccountsTrayPopup';
import { createTrayMonitor } from '../../services/providerAccounts/trayMonitor';
import type { TrayWindowClient } from '../../services/providerAccounts/trayWindow';
import type { ProviderAccount } from '../../services/providerAccounts/types';

const { desktop } = vi.hoisted(() => ({ desktop: vi.fn(() => true) }));
vi.mock('../../services/runtime', () => ({ isTauriRuntime: desktop }));
vi.mock('../../services/providerAccounts/trayWindow', async (original) => ({
  ...await original<typeof import('../../services/providerAccounts/trayWindow')>(), loadTrayAppearance: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(async () => { desktop.mockReturnValue(true); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function row(id = 'codex-1'): ProviderAccount {
  return { id, providerId: 'openai-codex', label: id === 'codex-1' ? 'Codex 1' : 'Codex 2', status: 'connected', duplicateOf: null,
    identity: { key: id, email: `${id}@example.invalid`, workspaceId: null, plan: null },
    lastSuccessAt: Date.now(), lastAttemptAt: Date.now(), error: null,
    usage: { windows: [
      { id: 'primary', windowMinutes: 300, usedPercent: 20, resetsAt: Date.now() + 3600000 },
      { id: 'secondary', windowMinutes: 10080, usedPercent: 30, resetsAt: Date.now() + 86400000 },
    ], resetTokens: null } };
}
function fixture(rows = [row(), row('codex-2')]) {
  const client = { list: vi.fn().mockResolvedValue(rows), refresh: vi.fn().mockResolvedValue(rows) };
  const store = createTrayMonitor(client, { load: vi.fn().mockResolvedValue({ ids: [], removedIds: [] }) });
  let opened = () => {};
  const stop = vi.fn();
  const windowClient: TrayWindowClient = {
    listenOpened: vi.fn(async (callback) => { opened = callback; return stop; }),
    ready: vi.fn().mockResolvedValue(undefined), hide: vi.fn().mockResolvedValue(undefined),
  };
  const open = async () => { await waitFor(() => expect(windowClient.ready).toHaveBeenCalled()); await act(async () => opened()); };
  return { client, store, windowClient, stop, open };
}

describe('Accounts tray popup', () => {
  it('shows separate Fable quota and read-only banked resets with exact expiry', async () => {
    const claude: ProviderAccount = { ...row(), id: 'claude-1', providerId: 'claude', label: 'Claude 1',
      usage: { windows: [
        { id: 'weeklyFable', windowMinutes: 10080, usedPercent: 40, resetsAt: Date.UTC(2027, 1, 1) },
        { id: 'weekly', windowMinutes: 10080, usedPercent: 20, resetsAt: Date.UTC(2027, 1, 2) },
      ], resetTokens: 2, resetCredits: { availableCount: 2, observedAt: Date.now(), detailsComplete: true,
        credits: [{ kind: 'fable', count: 2, expiresAt: Date.UTC(2027, 1, 3, 9, 17, 23), expiryKnown: true }] } } };
    const f = fixture([claude]);
    render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    const card = await screen.findByRole('article', { name: 'Claude 1' });
    expect(within(card).getByRole('progressbar', { name: 'Fable · weekly' })).toHaveAttribute('value', '60');
    await userEvent.click(within(card).getByRole('button', { name: 'Weekly' }));
    expect(within(card).getByRole('progressbar', { name: 'Weekly' })).toHaveAttribute('value', '80');
    const banked = within(card).getByRole('region', { name: 'Banked resets' });
    expect(banked).toHaveTextContent('2 Resets');
    const expiry = banked.querySelector('time[datetime="2027-02-03T09:17:23.000Z"]');
    expect(expiry).not.toHaveTextContent(/:|GMT/);
    expect(expiry?.closest('li')).toHaveAttribute('title', expect.stringMatching(/Fable reset ×2.*:23\b.*GMT/));
    expect(within(banked).queryByRole('button')).not.toBeInTheDocument();
  });
  it('labels Claude quota as five-hour and shows reported weekly quota', async () => {
    const claude = { ...row(), id: 'claude-1', providerId: 'claude', label: 'Claude 1' };
    const f = fixture([claude]);
    render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    const card = await screen.findByRole('article', { name: 'Claude 1' });
    expect(within(card).getByRole('progressbar', { name: '5-hour' })).toHaveAttribute('value', '80');
    await userEvent.click(within(card).getByRole('button', { name: 'Weekly' }));
    expect(within(card).getByRole('progressbar', { name: 'Weekly' })).toHaveAttribute('value', '70');
    expect(within(card).queryByText(i18n.t('providerAccounts.fableWeekly'))).not.toBeInTheDocument();
  });
  it('refreshes from the header and prevents repeated requests until completion', async () => {
    const f = fixture([row()]); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(i18n.t('providerAccounts.title'));
    await waitFor(() => expect(f.store.getState().refreshing).toBe(false));
    f.client.refresh.mockClear();
    let finish!: (rows: ProviderAccount[]) => void;
    f.client.refresh.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await userEvent.click(screen.getByRole('button', { name: i18n.t('providerAccounts.refresh') }));
    const busy = screen.getByRole('button', { name: i18n.t('providerAccounts.refreshing') });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    expect(f.client.refresh).toHaveBeenCalledExactlyOnceWith('codex-1');
    await act(async () => { finish([row()]); });
    expect(screen.getByRole('button', { name: i18n.t('providerAccounts.refresh') })).toBeEnabled();
  });

  it('retries a failed initial load from the header', async () => {
    const f = fixture([row()]); f.client.list.mockRejectedValueOnce(new Error('unavailable'));
    render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: i18n.t('providerAccounts.refresh') }));
    expect(await screen.findByRole('article', { name: 'Codex 1' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('signals initial readiness even when the hidden webview does not run animation frames', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
    const f = fixture(); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />);
    await waitFor(() => expect(f.windowClient.ready).toHaveBeenCalled());
  });

  it('selects reported periods separately without showing unavailable periods or login controls', async () => {
    const f = fixture(); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    const first = await screen.findByRole('article', { name: 'Codex 1' });
    const second = screen.getByRole('article', { name: 'Codex 2' });
    expect(within(first).getByText('codex-1@example.invalid')).toBeInTheDocument();
    expect(within(first).getByRole('progressbar', { name: '5-hour' })).toHaveAttribute('value', '80');
    await userEvent.click(within(first).getByRole('button', { name: 'Weekly' }));
    expect(within(first).getByRole('progressbar', { name: 'Weekly' })).toHaveAttribute('value', '70');
    expect(within(second).getByRole('button', { name: 'Hourly' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(second).getByRole('progressbar', { name: '5-hour' })).toHaveAttribute('value', '80');
    expect(within(first).queryByRole('button', { name: 'Monthly' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in|connect account|add account/i })).not.toBeInTheDocument();
  });

  it('falls back to a reported quota when the selected period becomes unavailable', async () => {
    const account = row();
    const f = fixture([account]);
    render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    const card = await screen.findByRole('article', { name: 'Codex 1' });
    await userEvent.click(within(card).getByRole('button', { name: 'Hourly' }));

    act(() => f.store.setState({ accounts: [{ ...account, usage: { windows: [
      { id: 'primary', windowMinutes: 300, usedPercent: null, resetsAt: Date.now() + 3600000 },
      { id: 'secondary', windowMinutes: 10080, usedPercent: 100, resetsAt: null },
    ], resetTokens: null } }] }));

    expect(within(card).queryByRole('button', { name: 'Hourly' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card).getByRole('progressbar', { name: 'Weekly' })).toHaveAttribute('value', '0');
    expect(within(card).queryByText('5-hour')).not.toBeInTheDocument();
  });

  it('supports keyboard selection and Escape hides without opening the main window', async () => {
    const f = fixture([row()]); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    const weekly = await screen.findByRole('button', { name: 'Weekly' });
    weekly.focus(); await userEvent.keyboard('{Enter}');
    expect(weekly).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Escape}');
    expect(f.windowClient.hide).toHaveBeenCalledExactlyOnceWith();
    expect(f.store.getState().active).toBe(false);
  });

  it('stops on focus loss and reloads when opened again while keeping the row period', async () => {
    const f = fixture([row()]); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    await userEvent.click(await screen.findByRole('button', { name: 'Weekly' }));
    await waitFor(() => expect(f.store.getState().refreshing).toBe(false));
    fireEvent.blur(window); expect(f.store.getState().active).toBe(false);
    f.client.list.mockClear(); await f.open();
    await waitFor(() => expect(f.client.list).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves stale, unknown and duplicate states without manufacturing quota', async () => {
    const original = row();
    const old = { ...original, lastSuccessAt: 1000, status: 'error' as const, error: 'refreshFailed' };
    const duplicate = { ...row('codex-2'), status: 'duplicate' as const, duplicateOf: 'codex-1' };
    const f = fixture([old, duplicate]); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    const first = await screen.findByRole('article', { name: 'Codex 1' });
    expect(within(first).getByText('Last-known quota · not current')).toBeInTheDocument();
    expect(within(first).getByRole('img', { name: 'Check failed' })).toBeInTheDocument();
    const second = screen.getByRole('article', { name: 'Codex 2' });
    expect(within(second).getByText('Same account as codex-1; this is not a separate quota.')).toBeInTheDocument();
    expect(within(second).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows a useful empty state and localized period controls', async () => {
    await i18n.changeLanguage('tr');
    const f = fixture([]); render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    expect(await screen.findByText(/Eklenmiş hesap yok/)).toBeInTheDocument();
    f.client.list.mockResolvedValue([row()]); await f.open();
    expect(await screen.findByRole('button', { name: 'Haftalık' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aylık' })).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '5 saat' })).toHaveAttribute('value', '80');
  });

  it('displays native load failure, and browser preview never invokes the desktop bridge', async () => {
    const f = fixture(); f.client.list.mockRejectedValue(new Error('fixture unavailable'));
    const view = render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />); await f.open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the local account registry');
    view.unmount(); desktop.mockReturnValue(false); vi.mocked(f.windowClient.ready).mockClear();
    render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />);
    expect(screen.getByText(/Open the TABS desktop app/)).toBeInTheDocument();
    expect(f.windowClient.ready).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: i18n.t('providerAccounts.refresh') })).toBeDisabled();
  });

  it('disposes a late listener registration without showing an abandoned window', async () => {
    const f = fixture(); let resolve!: (stop: () => void) => void;
    vi.mocked(f.windowClient.listenOpened).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<AccountsTrayPopup store={f.store} windowClient={f.windowClient} />);
    view.unmount(); await act(async () => { resolve(f.stop); });
    expect(f.stop).toHaveBeenCalledExactlyOnceWith();
    expect(f.windowClient.ready).not.toHaveBeenCalled();
  });
});
