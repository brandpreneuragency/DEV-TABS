import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from './uiStore';
import { SETTINGS_HEADER_TABS } from '../components/header/moduleNav';

vi.mock('../services/db', () => ({ db: { settings: { put: vi.fn().mockResolvedValue(undefined) } } }));

beforeEach(() => useUIStore.setState(useUIStore.getInitialState()));

describe('retired TABS agents settings', () => {
  it('omits Agents from settings navigation', () => {
    expect(SETTINGS_HEADER_TABS.map((tab) => tab.key)).toEqual(['tools', 'actions', 'appearance']);
  });

  it('redirects legacy Agents links to Tools', () => {
    useUIStore.getState().openSettings('agents');
    expect(useUIStore.getState()).toMatchObject({ activeView: 'settings', activeSettingsSubTab: 'tools' });
    useUIStore.getState().setActiveSettingsSubTab('appearance');
    useUIStore.getState().setActiveSettingsSubTab('agents');
    expect(useUIStore.getState().activeSettingsSubTab).toBe('tools');
  });
});
