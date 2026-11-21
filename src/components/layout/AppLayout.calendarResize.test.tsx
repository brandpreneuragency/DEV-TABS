import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLayout } from './AppLayout';

const state = vi.hoisted(() => ({
  editorFontSize: 14, navigationWidth: 200, navigationCollapsed: false,
  primaryWrapperOpen: true, assistantWrapperOpen: true, wrappersSwapped: false,
  assistantWrapperWidth: 30, contextPanelWidth: 30,
  contextPanelOpenByMode: { tasks: true }, activeTaskPage: 'calendar',
  taskMode: true, crmMode: false, setContextPanelWidth: vi.fn(),
}));
vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  }),
  selectActiveWorkspaceMode: () => 'tasks',
  selectIsContextPanelAvailable: () => true,
  selectIsContextPanelOpen: () => true,
}));
vi.mock('../../stores/taskStore', () => ({ useTaskStore: () => null }));
vi.mock('../../stores/taskAssistantBinding', () => ({ resolveTaskAssistantBinding: () => null }));
vi.mock('./LeftNarrowSidebar', () => ({ LeftNarrowSidebar: () => null }));
vi.mock('./NavigationResizeHandle', () => ({ NavigationResizeHandle: () => null }));
vi.mock('../fileViewer/FileViewerPanel', () => ({ FileViewerPanel: () => null }));
vi.mock('../sidebar/RightPanelSubheader', () => ({ RightPanelSubheader: () => null }));
vi.mock('../terminal/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../settings/SettingsDocument', () => ({ SettingsDocument: () => null }));
vi.mock('../notes/NotesPage', () => ({ NotesPage: () => null }));
vi.mock('../memoryNotes/MemoryWorkspace', () => ({ MemoryWorkspace: () => null }));
vi.mock('../providerAccounts/ProviderAccountsPage', () => ({ ProviderAccountsPage: () => null }));
vi.mock('./workspace/WorkspaceShell', () => ({
  WorkspaceShell: ({ primary, assistant, assistantWrapperOpen }: { primary: React.ReactNode; assistant: React.ReactNode; assistantWrapperOpen: boolean }) => <>{primary}{assistantWrapperOpen && assistant}</>,
}));

beforeEach(() => { state.activeTaskPage = 'calendar'; vi.clearAllMocks(); });
afterEach(cleanup);

describe.each(['calendar', 'projects'])('%s detail resizing', (page) => {
  beforeEach(() => { state.activeTaskPage = page; });

  it('shows the board and task title/details instead of the assistant', () => {
    render(<AppLayout editor="Details" sidebar="AI" leftPanel={null} taskListPanel="Board" subtasksBar="Task title" modals={null} />);
    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Task title')).toBeInTheDocument();
    expect(screen.queryByText('AI')).not.toBeInTheDocument();
  });
  it('drags past the former list cap and keeps the width on release', () => {
    const { container } = render(<AppLayout editor="Details" sidebar="AI" leftPanel={null} taskListPanel="Calendar" modals={null} />);
    const row = container.querySelector<HTMLElement>('.primary-workspace-content')!;
    const panel = container.querySelector('#task-list-column')!;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
    vi.spyOn(panel, 'getBoundingClientRect').mockImplementation(() => ({
      width: Number.parseFloat(row.style.getPropertyValue('--context-panel-width')),
    } as DOMRect));
    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 1000 }));
    expect(handle.getAttribute('aria-valuenow')).toBe('794');
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 1000 }));
    expect(handle.getAttribute('aria-valuenow')).toBe('794');
    expect(document.documentElement.dataset.resizing).toBeUndefined();
    expect(state.setContextPanelWidth).not.toHaveBeenCalled();
  });

  it('can grow the calendar beyond 420px while reserving 200px for details', () => {
    const { container } = render(<AppLayout editor="Details" sidebar="AI" leftPanel={null} taskListPanel="Calendar" modals={null} />);
    const row = container.querySelector('.primary-workspace-content')!;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
    const handle = screen.getByRole('separator');
    for (let step = 0; step < 30; step++) fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('794');
    expect((row as HTMLElement).style.getPropertyValue('--context-panel-width')).toBe('794px');
    expect(state.setContextPanelWidth).not.toHaveBeenCalled();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('778');
  });

  it('retains the shared list width behavior outside calendar', () => {
    state.activeTaskPage = 'list';
    render(<AppLayout editor="Details" sidebar="AI" leftPanel={null} taskListPanel="Tasks" modals={null} />);
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('aria-valuemax')).toBe('420');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(state.setContextPanelWidth).toHaveBeenCalled();
  });
});
