import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import type { ProviderAccount } from '../../services/providerAccounts/types';
import { BankedResets } from './BankedResets';

afterEach(cleanup);
const now = Date.UTC(2026, 10, 14, 0, 30);
const account: ProviderAccount = { id: 'claude-1', providerId: 'claude', label: 'Claude', status: 'connected',
  duplicateOf: null, identity: null, error: null, lastAttemptAt: now, lastSuccessAt: now,
  usage: { windows: [], resetTokens: 3, resetCredits: { availableCount: 3, observedAt: now - 60000, detailsComplete: false,
    credits: [
      { kind: 'fable', count: 1, expiresAt: now - 1, expiryKnown: true },
      { kind: 'session', count: 1, expiresAt: null, expiryKnown: true },
      { kind: 'unknown', count: 1, expiresAt: null, expiryKnown: false },
    ] } } };

describe('read-only banked resets', () => {
  it('puts the reset count before the short expiry dates in one group', async () => {
    await i18n.changeLanguage('en');
    const expiryDates = [new Date(2026, 10, 30), new Date(2026, 11, 2), new Date(2026, 11, 13)];
    const credits = expiryDates.map((date) => ({ kind: 'session' as const, count: 1, expiresAt: date.getTime(), expiryKnown: true }));
    render(<BankedResets account={{ ...account, usage: { windows: [], resetTokens: 3,
      resetCredits: { availableCount: 3, observedAt: now, detailsComplete: true, credits } } }} now={now} />);
    const count = screen.getByText('3 Resets');
    const dates = screen.getByRole('list');
    expect(count.nextElementSibling).toBe(dates);
    expect(Array.from(dates.querySelectorAll('time'), (date) => date.textContent)).toEqual(['Nov 30', 'Dec 2', 'Dec 13']);
    expect(screen.queryByText('R')).not.toBeInTheDocument();
    expect(screen.getByText('Checked:')).toBeInTheDocument();
  });
  it('distinguishes expired, non-expiring and unknown dates without recalculating the reported count', async () => {
    await i18n.changeLanguage('en');
    render(<BankedResets account={account} now={now} />);
    expect(screen.getByText('3 Resets')).toBeInTheDocument();
    expect(screen.getByText('No expiry')).toBeInTheDocument();
    expect(screen.getByText('Expiry unknown')).toBeInTheDocument();
    const badges = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(badges).toHaveLength(3);
    const expiry = badges[0].querySelector('time[datetime="2026-11-14T00:29:59.999Z"]');
    expect(expiry).toHaveTextContent(new Date(now - 1).toLocaleDateString('en', { month: 'short', day: 'numeric' }));
    expect(expiry).not.toHaveTextContent(/2026|:|GMT/);
    expect(badges[0]).toHaveAttribute('title', expect.stringMatching(/^Fable reset ×1 · Expires:.*999.*GMT.*Expired · awaiting refresh$/));
    expect(within(badges[0]).getByText(/Expired · awaiting refresh/)).toBeInTheDocument();
    expect(badges[0].querySelector('svg')).toBeInTheDocument();
    expect(badges[1].querySelector('svg')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('keeps surface denial unknown and retains last-known inventory on a failed check', async () => {
    await i18n.changeLanguage('en');
    const view = render(<BankedResets account={{ ...account, usage: { windows: [], resetTokens: null, resetCreditsError: 'surface' } }} now={now} />);
    expect(screen.getByText('Claude does not expose reset inventory to this application.')).toBeInTheDocument();
    expect(screen.queryByText('0 Resets')).not.toBeInTheDocument();
    view.rerender(<BankedResets account={{ ...account, usage: { ...account.usage!, resetCreditsError: 'unavailable' } }} now={now} />);
    expect(screen.getByText('3 Resets')).toBeInTheDocument();
    expect(screen.getByText('Last-known reset inventory · not current')).toBeInTheDocument();
  });
  it('hides duplicate inventories and uses Turkish copy', async () => {
    await i18n.changeLanguage('tr');
    const view = render(<BankedResets account={account} now={now} />);
    expect(screen.getByRole('region', { name: 'Birikmiş reset hakları' })).toHaveTextContent('3 reset');
    view.rerender(<BankedResets account={{ ...account, status: 'duplicate', duplicateOf: 'claude-other' }} now={now} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
