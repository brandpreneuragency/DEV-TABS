import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderAccountsPage } from './ProviderAccountsPage';
import { ProviderAccountsNavigation } from './ProviderAccountsNavigation';
import { createProviderAccountsStore } from '../../services/providerAccounts/store';
import { ACCOUNT_PROVIDERS, type ProviderAccount, type ProviderAccountsClient } from '../../services/providerAccounts/types';
import { isTauriRuntime } from '../../services/runtime';

vi.mock('../../services/runtime', () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock('../layout/workspace/AssistantToggle', () => ({ AssistantToggle: () => null }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({
  t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`,
  i18n: { language: 'en' },
}) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(isTauriRuntime).mockReturnValue(true); });

const account: ProviderAccount = {
  id: 'codex-1', providerId: 'openai-codex', label: 'Codex 1', status: 'connected', duplicateOf: null,
  identity: { key: 'synthetic-a', email: 'synthetic@example.invalid', workspaceId: 'workspace-a', plan: 'pro' },
  lastAttemptAt: 1000, lastSuccessAt: 1000, error: null,
  usage: { windows: [{ id: 'fiveHour', windowMinutes: 300, usedPercent: 20, resetsAt: 5000 }], resetTokens: 3 },
};
function fixture(row = account) {
  const api: ProviderAccountsClient = {
    list: vi.fn().mockResolvedValue([row]), refresh: vi.fn().mockResolvedValue([row]),
    connections: vi.fn().mockResolvedValue([{ id: 'hermes-mother', providerId: 'openai-codex',
      identity: row.identity, evidence: 'configured', observedAt: 1000, error: null }]),
    beginLogin: vi.fn(), openLogin: vi.fn(), pollLogin: vi.fn(), cancelLogin: vi.fn(), openUsage: vi.fn(),
    connectApiKey: vi.fn(),
  };
  return { api, store: createProviderAccountsStore(api, {
    load: vi.fn().mockResolvedValue({ ids: [], removedIds: [] }), save: vi.fn().mockResolvedValue(undefined),
  }) };
}

function renderWithSidebar(store: ReturnType<typeof createProviderAccountsStore>) {
  render(<>
    <nav aria-label="navigation.providerAccounts"><ProviderAccountsNavigation store={store} /></nav>
    <ProviderAccountsPage store={store} />
  </>);
  return within(screen.getByRole('navigation', { name: 'navigation.providerAccounts' }));
}

describe('provider accounts dashboard', () => {
  it('shows banked reset counts and exact expiries for any provider without adding a redeem action', async () => {
    const expiresAt = Date.UTC(2027, 2, 9, 7, 59);
    const { store } = fixture({ ...account, id: 'grok-1', providerId: 'grok', label: 'Grok 1',
      usage: { windows: [], resetTokens: 3, resetCredits: {
        availableCount: 3, observedAt: Date.now(), detailsComplete: false,
        credits: [{ kind: 'weekly', count: 2, expiresAt, expiryKnown: true }],
      } } });
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Grok 1' });
    const inventory = within(card).getByRole('region', { name: 'providerAccounts.banked.title' });
    expect(within(inventory).getByText('providerAccounts.banked.count 3')).toBeInTheDocument();
    expect(within(inventory).getByText('providerAccounts.banked.partial')).toBeInTheDocument();
    expect(inventory.querySelector(`time[datetime="${new Date(expiresAt).toISOString()}"]`)).toBeInTheDocument();
    expect(within(inventory).queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps unreported banked resets unknown instead of zero and preserves reported zero', async () => {
    const { api, store } = fixture();
    const unknown: ProviderAccount = { ...account, id: 'commandcode-1', providerId: 'commandCode', label: 'CommandCode 1', usage: null };
    const zero: ProviderAccount = { ...account, usage: { windows: [], resetTokens: 0 } };
    vi.mocked(api.list).mockResolvedValue([unknown, zero]); vi.mocked(api.refresh).mockResolvedValue([unknown, zero]);
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'CommandCode 1' });
    expect(within(card).getByText('providerAccounts.banked.unavailable')).toBeInTheDocument();
    expect(within(await screen.findByRole('article', { name: 'Codex 1' })).getByText('providerAccounts.banked.count 0')).toBeInTheDocument();
  });
  it('shows Fable quota separately without substituting it for the all-model weekly quota', async () => {
    const { store } = fixture({ ...account, id: 'claude-1', providerId: 'claude', label: 'Claude 1',
      usage: { windows: [
        { id: 'weeklyFable', windowMinutes: 10080, usedPercent: 45, resetsAt: 9000 },
        { id: 'weekly', windowMinutes: 10080, usedPercent: 20, resetsAt: 8000 },
      ], resetTokens: null } });
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Claude 1' });
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.fableWeekly' })).toHaveAttribute('value', '55');
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.weekly' })).toHaveAttribute('value', '80');
    expect(within(card).queryByText('providerAccounts.fiveHour')).not.toBeInTheDocument();
  });
  it('refreshes usage while connection observation is pending and allows retry after failure', async () => {
    const { api, store } = fixture();
    vi.mocked(api.connections).mockReturnValue(new Promise(() => {}));
    void store.getState().refreshConnections();
    render(<ProviderAccountsPage store={store} />);
    const button = await screen.findByRole('button', { name: 'providerAccounts.refresh' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(store.getState().observing).toBe(true);
    let fail!: (error: Error) => void;
    vi.mocked(api.refresh).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    const calls = vi.mocked(api.refresh).mock.calls.length;
    await userEvent.click(button);
    expect(api.refresh).toHaveBeenCalledTimes(calls + 1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('providerAccounts.refreshing');
    fail(new Error('fixture unavailable'));
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent('providerAccounts.errors.refreshFailed');
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(api.refresh).toHaveBeenCalledTimes(calls + 2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains why refresh is unavailable in the browser preview', () => {
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    const { api, store } = fixture();
    render(<ProviderAccountsPage store={store} />);
    expect(screen.getByRole('button', { name: 'providerAccounts.refresh' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('providerAccounts.desktopOnly');
    expect(api.list).not.toHaveBeenCalled();
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('adds Inception with published tier limits, unknown balance and an exact Billing action', async () => {
    const row: ProviderAccount = { ...account, id: 'inception-1', providerId: 'inception', label: 'Inception Labs 1',
      status: 'disconnected', identity: null, usage: null, lastSuccessAt: null, lastAttemptAt: null };
    const { api, store } = fixture(row);
    const sidebar = renderWithSidebar(store);
    const add = sidebar.getByRole('button', { name: 'providerAccounts.addAccount' });
    await waitFor(() => expect(add).toBeEnabled()); await userEvent.click(add);
    const form = screen.getByRole('form', { name: 'providerAccounts.addAccount' });
    await userEvent.selectOptions(within(form).getByRole('combobox'), 'inception');
    await userEvent.click(within(form).getByRole('button', { name: 'providerAccounts.addAccount' }));
    const card = await screen.findByRole('article', { name: 'Inception Labs 1' });
    const table = within(card).getByRole('table', { name: 'providerAccounts.inception.publishedLimits' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    for (const value of ['1,000', '3,000', '1,000,000', '3,000,000', '100,000', '300,000']) {
      expect(within(table).getByText(value)).toBeInTheDocument();
    }
    expect(within(card).getByText('100,000,000')).toBeInTheDocument();
    expect(within(card).getByText('providerAccounts.inception.balanceUnavailable')).toBeInTheDocument();
    expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(card).queryByText('providerAccounts.usageWebsiteHint')).not.toBeInTheDocument();
    expect(within(card).queryByText('providerAccounts.configuredHint')).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'providerAccounts.inception.openBilling' }));
    expect(api.openUsage).toHaveBeenCalledExactlyOnceWith('inception-1');
    expect(api.beginLogin).not.toHaveBeenCalled();
  });

  it('clears the masked API key immediately and verifies without starting an OAuth login', async () => {
    const row: ProviderAccount = { ...account, id: 'inception-1', providerId: 'inception', label: 'Inception Labs 1',
      status: 'connected', identity: null, usage: null };
    const { api, store } = fixture(row);
    let finish!: (value: ProviderAccount) => void;
    vi.mocked(api.connectApiKey).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Inception Labs 1' });
    await userEvent.click(within(card).getByRole('button', { name: 'providerAccounts.inception.manageKey' }));
    const input = within(card).getByLabelText('providerAccounts.inception.apiKey');
    expect(input).toHaveAttribute('type', 'password'); expect(input).toHaveFocus();
    await userEvent.type(input, 'synthetic-unusable-key');
    await userEvent.click(within(card).getByRole('button', { name: 'providerAccounts.inception.verifyKey' }));
    expect(input).toHaveValue('');
    expect(api.connectApiKey).toHaveBeenCalledExactlyOnceWith('inception-1', 'synthetic-unusable-key');
    expect(api.beginLogin).not.toHaveBeenCalled();
    finish({ ...row, lastSuccessAt: Date.now() });
    await waitFor(() => expect(within(card).queryByLabelText('providerAccounts.inception.apiKey')).not.toBeInTheDocument());
    expect(within(card).getByRole('img', { name: 'providerAccounts.status.connected' })).toBeInTheDocument();
  });

  it('renders the last read before the connected status', async () => {
    const now = Date.UTC(2026, 9, 25, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { api, store } = fixture({ ...account, lastAttemptAt: now, lastSuccessAt: now - 60000,
      usage: { windows: [
        { id: 'fiveHour', windowMinutes: 300, usedPercent: 20, resetsAt: now + (3 * 60 + 42) * 60000 },
        { id: 'weekly', windowMinutes: 10080, usedPercent: 30, resetsAt: now + ((3 * 24 + 23) * 60 + 49) * 60000 },
      ], resetTokens: 3 } });
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Codex 1' });
    expect(within(card).getByRole('heading', { name: 'Codex 1' })).toBeInTheDocument();
    expect(within(card).getByText('synthetic@example.invalid')).toBeInTheDocument();
    const status = within(card).getByRole('img', { name: 'providerAccounts.status.connected' });
    expect(status).toHaveAttribute('title', 'providerAccounts.status.connected');
    expect(status).toBeEmptyDOMElement();
    expect(within(card).getByText('providerAccounts.percent 80')).toBeInTheDocument();
    expect(within(card).getByText('providerAccounts.resetHoursMinutes 3 42').parentElement)
      .toHaveTextContent('providerAccounts.fiveHour');
    expect(within(card).getByText('providerAccounts.resetDaysHoursMinutes 3 23 49').parentElement)
      .toHaveTextContent('providerAccounts.weekly');
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.fiveHour' })).toHaveAttribute('value', '80');
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.weekly' })).toHaveAttribute('value', '70');
    expect(within(card).queryByText(/providerAccounts\.(plan|resetTokens|lastAttempt|lastSuccess|evidence)/)).not.toBeInTheDocument();
    const read = within(card).getByText(/^providerAccounts\.lastRead /);
    expect(read).toHaveAttribute('title', new Date(now - 60000).toLocaleString('en'));
    expect(read.nextElementSibling).toBe(status);
    expect(card.querySelector('footer')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'providerAccounts.reconnect' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'providerAccounts.refreshAccount Codex 1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(api.connections).not.toHaveBeenCalled();
  });

  it('filters mixed provider cards from the sidebar and returns to the full dashboard', async () => {
    const { api, store } = fixture();
    const claude: ProviderAccount = { ...account, id: 'claude-1', providerId: 'claude', label: 'Claude 1' };
    vi.mocked(api.list).mockResolvedValue([account, claude]);
    vi.mocked(api.refresh).mockResolvedValue([account, claude]);
    const sidebar = renderWithSidebar(store);
    await screen.findByRole('article', { name: 'Codex 1' });
    const card = await screen.findByRole('article', { name: 'Claude 1' });
    expect(screen.getByRole('article', { name: 'Codex 1' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'providerAccounts.provider' })).not.toBeInTheDocument();
    const center = within(screen.getByRole('region', { name: 'providerAccounts.title' }));
    expect(center.queryByRole('button', { name: 'providerAccounts.addAccount' })).not.toBeInTheDocument();
    expect(within(card).queryByText('providerAccounts.usageUnavailable')).not.toBeInTheDocument();
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.fiveHour' })).toHaveAttribute('value', '80');
    expect(within(card).queryByText('providerAccounts.claudeQuotaHint')).not.toBeInTheDocument();
    expect(within(card).queryByText('providerAccounts.usageWebsiteHint')).not.toBeInTheDocument();
    expect(within(card).queryByText('providerAccounts.resetTokens')).not.toBeInTheDocument();
    const dashboard = sidebar.getByRole('button', { name: 'providerAccounts.dashboard' });
    const claudeFilter = sidebar.getByRole('button', { name: 'Claude' });
    expect(sidebar.getAllByRole('button')).toEqual([
      sidebar.getByRole('button', { name: 'providerAccounts.addAccount' }),
      dashboard,
      ...ACCOUNT_PROVIDERS.map(({ name }) => sidebar.getByRole('button', { name })),
    ]);
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    await userEvent.click(claudeFilter);
    expect(claudeFilter).toHaveAttribute('aria-current', 'page');
    expect(dashboard).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('article', { name: 'Codex 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Claude 1' })).toBeInTheDocument();
    await userEvent.click(sidebar.getByRole('button', { name: 'Grok' }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(center.getByRole('status')).toHaveTextContent('providerAccounts.emptyProvider Grok');
    await userEvent.click(dashboard);
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('article', { name: 'Codex 1' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Claude 1' })).toBeInTheDocument();
    expect(api.beginLogin).not.toHaveBeenCalled();
  });

  it('shows Claude auth and rate-limit errors without hiding the last-known quota', async () => {
    const { store } = fixture({ ...account, id: 'claude-1', providerId: 'claude', label: 'Claude 1',
      status: 'error', error: 'claudeRateLimited' });
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Claude 1' });
    expect(within(card).getByRole('status')).toHaveTextContent('providerAccounts.externalErrors.claudeRateLimited');
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.fiveHour' })).toHaveAttribute('value', '80');
    expect(within(card).getByText('providerAccounts.stale')).toBeInTheDocument();
  });

  it('starts empty and adds cards one by one without opening a sign-in flow', async () => {
    const empty = (id: string, providerId: string, label: string): ProviderAccount => ({
      ...account, id, providerId, label, identity: null, status: 'disconnected',
      usage: null, lastAttemptAt: null, lastSuccessAt: null,
    });
    const rows = [empty('codex-1', 'openai-codex', 'Codex 1'), empty('claude-1', 'claude', 'Claude 1')];
    const { api, store } = fixture();
    vi.mocked(api.list).mockResolvedValue(rows); vi.mocked(api.refresh).mockResolvedValue(rows);
    const sidebar = renderWithSidebar(store);
    const openAdd = sidebar.getByRole('button', { name: 'providerAccounts.addAccount' });
    await waitFor(() => expect(openAdd).toBeEnabled());
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByText('providerAccounts.empty')).toBeInTheDocument();
    await userEvent.click(sidebar.getByRole('button', { name: 'Claude' }));
    await userEvent.click(openAdd);
    let form = screen.getByRole('form', { name: 'providerAccounts.addAccount' });
    const provider = within(form).getByRole('combobox', { name: 'providerAccounts.provider' });
    expect(provider).toHaveFocus();
    expect(provider).toHaveValue('claude');
    await userEvent.click(within(form).getByRole('button', { name: 'providerAccounts.addAccount' }));
    await screen.findByRole('article', { name: 'Claude 1' });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(openAdd).toHaveFocus();
    await userEvent.click(openAdd);
    form = screen.getByRole('form', { name: 'providerAccounts.addAccount' });
    expect(within(form).getByRole('option', { name: 'Claude' })).toBeDisabled();
    await userEvent.selectOptions(within(form).getByRole('combobox'), 'openai-codex');
    await userEvent.click(within(form).getByRole('button', { name: 'providerAccounts.addAccount' }));
    await screen.findByRole('article', { name: 'Codex 1' });
    expect(sidebar.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('article', { name: 'Claude 1' })).not.toBeInTheDocument();
    await userEvent.click(sidebar.getByRole('button', { name: 'providerAccounts.dashboard' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('article', { name: 'Claude 1' })).toBeInTheDocument();
    expect(api.beginLogin).not.toHaveBeenCalled();
    expect(api.openLogin).not.toHaveBeenCalled();
  });

  it('removes the chosen connected card by keyboard and lets the owner add it again', async () => {
    const { api, store } = fixture();
    const other = { ...account, id: 'codex-2', label: 'Codex 2' };
    vi.mocked(api.list).mockResolvedValue([account, other]);
    vi.mocked(api.refresh).mockResolvedValue([account, other]);
    const sidebar = renderWithSidebar(store);
    const remove = await screen.findByRole('button', { name: 'providerAccounts.removeAccount Codex 1' });
    expect(remove).toHaveTextContent(/^providerAccounts\.remove$/);
    remove.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Codex 1' })).not.toBeInTheDocument());
    expect(screen.getByRole('article', { name: 'Codex 2' })).toBeInTheDocument();
    const add = sidebar.getByRole('button', { name: 'providerAccounts.addAccount' });
    expect(add).toHaveFocus();
    await userEvent.click(add);
    const form = screen.getByRole('form', { name: 'providerAccounts.addAccount' });
    await userEvent.click(within(form).getByRole('button', { name: 'providerAccounts.addAccount' }));
    expect(await screen.findByRole('article', { name: 'Codex 1' })).toBeInTheDocument();
    expect(api.beginLogin).not.toHaveBeenCalled();
  });

  it('cancels provider selection without creating a card and restores button focus', async () => {
    const { store } = fixture();
    const sidebar = renderWithSidebar(store);
    const button = sidebar.getByRole('button', { name: 'providerAccounts.addAccount' });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'providerAccounts.addAccount' })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('hides a limit with unknown usage and keeps a reported zero balance visible', async () => {
    const { api, store } = fixture({ ...account, usage: { windows: [
      { id: 'fiveHour', windowMinutes: 300, usedPercent: 100, resetsAt: 5000 },
      { id: 'weekly', windowMinutes: 10080, usedPercent: null, resetsAt: 9000 },
    ], resetTokens: 3 } });
    render(<ProviderAccountsPage store={store} />);
    await screen.findByRole('article', { name: 'Codex 1' });
    expect(screen.getByRole('progressbar', { name: 'providerAccounts.fiveHour' })).toHaveAttribute('value', '0');
    expect(screen.queryByText('providerAccounts.weekly')).not.toBeInTheDocument();
    expect(api.beginLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('providerAccounts.resetAwaitingRefresh')).toBeInTheDocument();
  });

  it('shows Grok allowance and purchased USD credits without treating them as Codex reset tokens', async () => {
    const { api, store } = fixture({ ...account, id: 'grok-1', providerId: 'grok', label: 'Grok 1',
      usage: { windows: [], resetTokens: null, billing: { usedPercent: 25, period: 'weekly',
        resetsAt: '2099-01-01T00:00:00Z', prepaidBalanceCents: 1250 } } });
    render(<ProviderAccountsPage store={store} />);
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    await screen.findByRole('article', { name: 'Grok 1' });
    expect(screen.getByText('providerAccounts.percent 75')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'providerAccounts.weekly' })).toHaveAttribute('value', '75');
    expect(screen.queryByText('providerAccounts.fiveHour')).not.toBeInTheDocument();
    expect(screen.queryByText('providerAccounts.resetTokens')).not.toBeInTheDocument();
  });

  it('labels CommandCode as configured only and opens usage for that exact account', async () => {
    const { api, store } = fixture({ ...account, id: 'commandcode-1', providerId: 'commandCode', label: 'CommandCode 1',
      status: 'configured', usage: null });
    render(<ProviderAccountsPage store={store} />);
    await screen.findByRole('article', { name: 'CommandCode 1' });
    expect(screen.getByRole('img', { name: 'providerAccounts.status.configured' })).toBeInTheDocument();
    expect(screen.getByText('providerAccounts.configuredHint')).toBeInTheDocument();
    expect(screen.queryByText('providerAccounts.usageWebsiteHint')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'providerAccounts.openUsage' }));
    expect(api.openUsage).toHaveBeenCalledExactlyOnceWith('commandcode-1');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('providerAccounts.status.connected')).not.toBeInTheDocument();
  });

  it('does not render a duplicate account as another quota pool', async () => {
    const { store } = fixture({ ...account, status: 'duplicate', duplicateOf: 'codex-2' });
    render(<ProviderAccountsPage store={store} />);
    await screen.findByText('providerAccounts.duplicate codex-2');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('shows sign-in for a disconnected account and keeps pending controls', async () => {
    const { api, store } = fixture({ ...account, status: 'disconnected', identity: null,
      usage: null, lastAttemptAt: null, lastSuccessAt: null });
    vi.mocked(api.beginLogin).mockResolvedValue({ accountId: account.id, loginId: 'synthetic-login', authUrl: 'https://example.invalid/login' });
    store.setState({ cardIds: [account.id] });
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Codex 1' });
    expect(within(card).getByText('providerAccounts.lastRead providerAccounts.unknown')).toBeInTheDocument();
    expect(within(card).queryByRole('img', { name: 'providerAccounts.status.disconnected' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'providerAccounts.connect' }));
    expect(api.beginLogin).toHaveBeenCalledExactlyOnceWith(account.id);
    expect(api.openLogin).toHaveBeenCalledExactlyOnceWith(account.id, 'synthetic-login');
    expect(within(card).getByText(/providerAccounts\.loginPending/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'providerAccounts.removeAccount Codex 1' })).toBeDisabled();
    expect(within(card).queryByRole('button', { name: 'providerAccounts.refreshAccount Codex 1' })).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'providerAccounts.openBrowser' }));
    expect(api.openLogin).toHaveBeenCalledTimes(2);
    await userEvent.click(within(card).getByRole('button', { name: 'providerAccounts.cancelLogin' }));
    expect(api.cancelLogin).toHaveBeenCalledExactlyOnceWith(account.id, 'synthetic-login');
    expect(within(card).getByRole('button', { name: 'providerAccounts.connect' })).toBeInTheDocument();
  });

  it('keeps stale and failed-read warnings with the last successful read and quota', async () => {
    const { store } = fixture({ ...account, status: 'error', error: 'refreshFailed', lastAttemptAt: 9000 });
    render(<ProviderAccountsPage store={store} />);
    const card = await screen.findByRole('article', { name: 'Codex 1' });
    expect(within(card).queryByRole('img', { name: 'providerAccounts.status.error' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'providerAccounts.reconnect' })).toBeInTheDocument();
    expect(within(card).getByText('providerAccounts.stale')).toBeInTheDocument();
    expect(within(card).getByText('providerAccounts.accountError')).toBeInTheDocument();
    expect(within(card).getByText(/^providerAccounts\.lastRead /)).toHaveAttribute('title', new Date(1000).toLocaleString('en'));
    expect(within(card).getByRole('progressbar', { name: 'providerAccounts.fiveHour' })).toHaveAttribute('value', '80');
  });

  it('retains the dashboard and honest error state when native loading fails', async () => {
    const { api, store } = fixture(); vi.mocked(api.list).mockRejectedValue(new Error('fixture unavailable'));
    const sidebar = renderWithSidebar(store);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('providerAccounts.errors.loadFailed'));
    expect(sidebar.getByRole('button', { name: 'providerAccounts.addAccount' })).toBeDisabled();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
