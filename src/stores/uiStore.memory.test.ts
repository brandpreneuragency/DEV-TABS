import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../services/db';
import { selectActiveWorkspaceMode, selectIsContextPanelAvailable, useUIStore } from './uiStore';

vi.mock('../services/db', () => ({ db: { settings: { put: vi.fn().mockResolvedValue(undefined) } } }));
beforeEach(() => {
  useUIStore.setState(useUIStore.getInitialState());
  vi.clearAllMocks();
});

describe('Memory workspace routing', () => {
  it.each([{ taskMode: true }, { crmMode: true }])('enters Memory independently from %j', (mode) => {
    useUIStore.setState({ ...mode, activeTaskPage: 'calendar', activeCRMPage: 'projects', activeTaskId: 'task-a', primaryWrapperOpen: false, assistantWrapperOpen: true, wrappersSwapped: true });
    useUIStore.getState().setActiveView('memory');
    expect(selectActiveWorkspaceMode(useUIStore.getState())).toBe('memory');
    expect(selectIsContextPanelAvailable(useUIStore.getState())).toBe(false);
    expect(useUIStore.getState()).toMatchObject({ taskMode: false, crmMode: false, primaryWrapperOpen: true, assistantWrapperOpen: true, wrappersSwapped: true, activeTaskPage: 'calendar', activeCRMPage: 'projects', activeTaskId: 'task-a' });
    expect(db.settings.put).toHaveBeenCalledWith({ key: 'taskMode', value: false });
    expect(db.settings.put).toHaveBeenCalledWith({ key: 'crmMode', value: false });
  });

  it('leaves Memory for every existing workspace without changing remembered pages', () => {
    const ui = useUIStore.getState();
    const destinations = [
      { enter: () => ui.setTaskMode(false), mode: 'documents' },
      { enter: () => ui.setTaskMode(true), mode: 'tasks' },
      { enter: () => ui.setCrmMode(true), mode: 'crm' },
      { enter: () => ui.openSettings(), mode: 'settings' },
      { enter: () => ui.setActiveView('notes'), mode: 'notes' },
      { enter: () => ui.setActiveView('providerAccounts'), mode: 'providerAccounts' },
    ];
    for (const destination of destinations) {
      ui.setActiveView('memory');
      expect(selectActiveWorkspaceMode(useUIStore.getState())).toBe('memory');
      destination.enter();
      expect(selectActiveWorkspaceMode(useUIStore.getState())).toBe(destination.mode);
    }
  });
});
