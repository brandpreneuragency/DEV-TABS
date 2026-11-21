import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from './services/db';
import { parseMemoryNote } from './services/memoryNotes/model';
import { useChatStore } from './stores/chatStore';
import { useMemoryNavigationStore } from './stores/memoryNavigationStore';
import { useMemoryNotesStore } from './stores/memoryNotesStore';
import { useUIStore } from './stores/uiStore';
import App from './App';

const mocks = vi.hoisted(() => ({
  load: vi.fn().mockResolvedValue(undefined),
  loadNotes: vi.fn(),
}));

vi.mock('./components/layout/AppLayout', async () => {
  const { MemoryWorkspace } = await import('./components/memoryNotes/MemoryWorkspace');
  return { AppLayout: ({ sidebar }: { sidebar: ReactNode }) => <><MemoryWorkspace />{sidebar}</> };
});
vi.mock('./components/header/AppTitlebar', () => ({ AppTitlebar: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('./components/header/Header', () => ({ Header: () => null }));
vi.mock('./components/header/TaskTitleBar', () => ({ TaskTitleBar: () => null }));
vi.mock('./components/editor/EditorWorkspace', () => ({ EditorWorkspace: () => null }));
vi.mock('./components/taskManager/TaskDetailPanel', () => ({ TaskDetailPanel: () => null }));
vi.mock('./components/taskManager/TaskProjectsKanban', () => ({ TaskProjectsKanban: () => null }));
vi.mock('./components/fileExplorer/FileExplorerPanel', () => ({ FileExplorerPanel: () => null }));
vi.mock('./components/taskManager/TaskListPanel', () => ({ TaskListPanel: () => null }));
vi.mock('./components/modals/AgentEditor', () => ({ AgentEditor: () => null }));
vi.mock('./components/modals/QuickPrompts', () => ({ QuickPrompts: () => null }));
vi.mock('./components/modals/TrashModal', () => ({ TrashModal: () => null }));
vi.mock('./components/ui/Toast', () => ({ ToastContainer: () => null }));
vi.mock('./components/layout/CRMWorkspace', () => ({ CRMWorkspace: () => null }));
vi.mock('./components/crm/CRMListPanel', () => ({ CRMListPanel: () => null }));
vi.mock('./components/forms/FormsListPanel', () => ({ FormsListPanel: () => null }));
vi.mock('./components/clients/ClientsCategoryPanel', () => ({ ClientsCategoryPanel: () => null }));
vi.mock('./components/sidebar/ChatInput', () => ({ ChatInput: ({ memoryContext }: { memoryContext?: { id: string } }) =>
  <div data-testid="memory-composer" data-context={memoryContext?.id} /> }));
vi.mock('./components/sidebar/ChatThread', () => ({ ChatThread: () => null }));
vi.mock('./services/memoryNotes/desktop', () => ({ loadMemoryNotes: mocks.loadNotes }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ i18n: { resolvedLanguage: 'en' },
    t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key }),
}));
vi.mock('./stores/workspaceStore', () => ({ useWorkspaceStore: () => ({
  loadWorkspaces: mocks.load, activeWorkspaceId: null, isLoaded: true, setActiveWorkspace: vi.fn(),
}) }));
vi.mock('./stores/aiStore', () => ({ useAIStore: () => ({ loadAISettings: mocks.load }) }));
vi.mock('./stores/taskStore', () => ({ useTaskStore: () => ({
  loadTasks: mocks.load, isLoaded: true, activeTaskId: null, setActiveTask: vi.fn(), tasks: [],
  selectedClientId: null, selectedProjectId: null,
}) }));
vi.mock('./stores/projectStore', () => ({ useProjectStore: () => ({ loadProjects: mocks.load, isLoaded: true }) }));
vi.mock('./stores/clientStore', () => ({ useClientStore: Object.assign(
  () => ({ loadClients: mocks.load, isLoaded: true }), { getState: () => ({ loadClients: mocks.load }) },
) }));
vi.mock('./stores/crmStore', () => ({ useCrmStore: { getState: () => ({ loadCrm: mocks.load }) } }));
vi.mock('./stores/formsStore', () => ({ useFormsStore: { getState: () => ({ loadForms: mocks.load }) } }));
vi.mock('./stores/themeStore', () => ({ retireLegacyThemeTokens: mocks.load }));
vi.mock('./services/updater', () => ({ runStartupUpdateCheck: mocks.load }));
vi.mock('./services/desktopFileOpen', () => ({ subscribeToDesktopFileOpen: async () => () => {} }));
vi.mock('./services/openCode/toolBridge', () => ({ startToolBridge: mocks.load }));
vi.mock('./services/taskAuthority/service', () => ({ startTaskAuthority: () => () => {} }));
vi.mock('./services/dragMotion', () => ({ installDragMotion: () => () => {} }));

beforeEach(async () => {
  await db.delete();
  await db.open();
  useUIStore.setState({ ...useUIStore.getInitialState(), activeView: 'memory', loadUISettings: mocks.load });
  useChatStore.setState({ threads: [], activeThreadId: null, messagesByThread: {}, currentContext: null,
    contextLoading: false, lastViewedPerContext: {} });
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  useMemoryNotesStore.setState(useMemoryNotesStore.getInitialState());
  mocks.loadNotes.mockReset().mockResolvedValue({ notes: [parseMemoryNote('sample.md', '# Sample\nSynthetic body')], issues: [] });
});

afterEach(cleanup);

it('routes an opened Memory card to the item-scoped assistant from App', async () => {
  render(<App />);
  const card = await screen.findByRole('button', { name: 'memoryNotes.open: Sample' });
  expect(screen.queryByTestId('memory-composer')).toBeNull();

  fireEvent.click(card);
  const composer = await screen.findByTestId('memory-composer');
  const memoryId = JSON.stringify(['notes', 'sample.md']);
  expect(composer).toHaveAttribute('data-context', memoryId);
  expect(useChatStore.getState().currentContext).toEqual({ memoryId });

  fireEvent.click(screen.getByRole('button', { name: 'memoryNotes.back' }));
  expect(screen.queryByTestId('memory-composer')).toBeNull();
});
