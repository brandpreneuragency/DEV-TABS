import { beforeEach, describe, expect, it, vi } from 'vitest';
import { selectActiveWorkspaceMode, selectIsContextPanelAvailable, useUIStore } from './uiStore';
import { mergeContextPanelOpenByMode, migrateLayoutStateFromStored } from './uiLayoutState';

vi.mock('../services/db', () => ({ db: { settings: { put: vi.fn().mockResolvedValue(undefined) } } }));
beforeEach(() => useUIStore.setState(useUIStore.getInitialState()));

describe('Scripts workspace routing', () => {
  it('leaves Tasks without opening Terminal or losing the remembered task selection', () => {
    useUIStore.setState({ taskMode: true, activeTaskPage: 'calendar', activeTaskId: 'retained-task',
      primaryWrapperOpen: false, assistantWrapperOpen: true, terminalPanelOpen: false });
    useUIStore.getState().setActiveView('scripts');
    expect(selectActiveWorkspaceMode(useUIStore.getState())).toBe('scripts');
    expect(selectIsContextPanelAvailable(useUIStore.getState())).toBe(false);
    expect(useUIStore.getState()).toMatchObject({ taskMode: false, crmMode: false,
      primaryWrapperOpen: true, assistantWrapperOpen: true, terminalPanelOpen: false,
      activeTaskPage: 'calendar', activeTaskId: 'retained-task' });
    useUIStore.getState().setTaskMode(true);
    expect(selectActiveWorkspaceMode(useUIStore.getState())).toBe('tasks');
    expect(useUIStore.getState().activeTaskPage).toBe('calendar');
  });

  it('adds optional layout state without dropping the owner’s existing preferences', () => {
    expect(mergeContextPanelOpenByMode({ tasks: false, notes: true })).toMatchObject({
      tasks: false, notes: true, scripts: false,
    });
    expect(migrateLayoutStateFromStored({ contextPanelOpenByMode: JSON.stringify({ scripts: false, documents: true }) })
      .contextPanelOpenByMode).toMatchObject({ scripts: false, documents: true });
  });
});
