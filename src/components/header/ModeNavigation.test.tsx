import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '../../stores/uiStore';
import { useTaskStore } from '../../stores/taskStore';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { ModeNavigation } from './ModeNavigation';

vi.mock('../../services/db', () => ({
  db: { settings: { put: vi.fn().mockResolvedValue(undefined) } },
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../stores/crmStore', () => ({ useCrmStore: { getState: () => ({ setLeadsCenterView: vi.fn() }) } }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  useUIStore.setState(useUIStore.getInitialState());
  useTaskStore.setState(useTaskStore.getInitialState());
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
});
afterEach(cleanup);

describe('ModeNavigation', () => {
  it.each(['navigation.docs', 'navigation.taskList', 'navigation.calendar', 'navigation.clients', 'navigation.projects', 'navigation.notes', 'navigation.memory', 'scripts.title', 'menu.settings'])(
    'opens Accounts independently from %s', (destination) => {
      render(<ModeNavigation />);
      fireEvent.click(screen.getByRole('button', { name: destination }));
      fireEvent.click(screen.getByRole('button', { name: 'navigation.providerAccounts' }));

      expect(useUIStore.getState()).toMatchObject({ activeView: 'providerAccounts', taskMode: false, crmMode: false });
      expect(screen.getByRole('button', { name: 'navigation.providerAccounts' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'navigation.memory' })).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(screen.getByRole('button', { name: 'navigation.memory' }));
      expect(useUIStore.getState().activeView).toBe('memory');
      expect(screen.getByRole('button', { name: 'navigation.memory' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'navigation.providerAccounts' })).toHaveAttribute('aria-pressed', 'false');
    });

  it.each(['notes', 'resources', 'toRead', 'someday'] as const)(
    'restores the selected Memory collection %s after visiting Accounts', (page) => {
      useMemoryNavigationStore.getState().setPage(page);
      useUIStore.getState().setActiveView('memory');
      render(<ModeNavigation />);

      fireEvent.click(screen.getByRole('button', { name: 'navigation.providerAccounts' }));
      fireEvent.click(screen.getByRole('button', { name: 'navigation.memory' }));

      expect(useUIStore.getState().activeView).toBe('memory');
      expect(useMemoryNavigationStore.getState().page).toBe(page);
    });

  it('keeps all controls visible in the requested order across view changes', () => {
    render(<ModeNavigation />);
    const expected = ['left-navbar', 'settings', 'terminal', 'documents', 'tasks', 'calendar', 'notes', 'memory', 'provider-accounts', 'scripts', 'clients', 'projects'];
    expect(Array.from(document.querySelector('.mode-navigation')!.children)
      .filter((element) => element.classList.contains('header-mode') || element.classList.contains('mode-navigation-separator'))
      .map((element) => element.classList.contains('mode-navigation-separator') ? '|' : element.id))
      .toEqual(['|', 'nav-btn-documents', 'nav-btn-tasks', 'nav-btn-calendar', '|', 'nav-btn-notes', 'nav-btn-memory', 'nav-btn-provider-accounts', 'nav-btn-scripts', '|', 'nav-btn-clients', 'nav-btn-projects']);
    for (const name of ['navigation.calendar', 'scripts.title', 'navigation.memory', 'navigation.providerAccounts', 'navigation.notes', 'navigation.projects', 'navigation.memory', 'navigation.taskList', 'navigation.memory', 'navigation.docs', 'navigation.clients']) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(screen.getAllByRole('button').map((button) => button.id)).toEqual(expected.map((id) => `nav-btn-${id}`));
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
      expect(document.querySelectorAll('.header-mode[aria-pressed="true"]')).toHaveLength(1);
    }
  });

  it('enters Clients without changing the selected client and clears project scope', () => {
    useTaskStore.setState({ selectedClientId: 'client-a', selectedProjectId: 'project-a' });
    useUIStore.setState({ activeCRMPage: 'projects', crmMode: true });
    render(<ModeNavigation />);

    fireEvent.click(screen.getByRole('button', { name: 'navigation.clients' }));

    expect(useTaskStore.getState()).toMatchObject({ selectedClientId: 'client-a', selectedProjectId: null });
    expect(useUIStore.getState()).toMatchObject({
      activeCRMPage: 'clients', crmMode: true, contextPanelOpenByMode: { ...useUIStore.getState().contextPanelOpenByMode, crm: true },
    });
    expect(document.querySelectorAll('.header-mode[aria-pressed="true"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'navigation.docs' }));
    expect(useUIStore.getState().crmMode).toBe(false);
    expect(useTaskStore.getState()).toMatchObject({ selectedClientId: 'client-a', selectedProjectId: null });
  });

  it('toggles the left navbar while preserving its resized width', () => {
    useUIStore.setState({ navigationWidth: 245, navigationCollapsed: false });
    render(<ModeNavigation />);

    const toggle = screen.getByRole('button', { name: 'navigation.collapseNavbar' });
    fireEvent.click(toggle);
    expect(useUIStore.getState().navigationCollapsed).toBe(true);
    expect(useUIStore.getState().navigationWidth).toBe(245);

    fireEvent.click(screen.getByRole('button', { name: 'navigation.openNavbar' }));
    expect(useUIStore.getState().navigationCollapsed).toBe(false);
    expect(useUIStore.getState().navigationWidth).toBe(245);
  });

  it('opens the exact page when moving between workspaces', () => {
    render(<ModeNavigation />);
    for (const [name, mode, page] of [
      ['navigation.calendar', 'tasks', 'calendar'],
      ['navigation.projects', 'crm', 'projects'],
      ['navigation.taskList', 'tasks', 'list'],
      ['navigation.clients', 'crm', 'clients'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name }));
      const state = useUIStore.getState();
      expect(state.taskMode).toBe(mode === 'tasks');
      expect(state.crmMode).toBe(mode === 'crm');
      expect(mode === 'tasks' ? state.activeTaskPage : state.activeCRMPage).toBe(page);
    }
  });
});
