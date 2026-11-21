import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RightPanelSubheader } from './RightPanelSubheader';

const { setActiveAgent, agents } = vi.hoisted(() => ({
  setActiveAgent: vi.fn(),
  agents: [
    { id: 'former-writer', name: 'Writing assistant', avatarUrl: '', systemPrompt: '', isDefault: false },
    { id: 'former-task', name: 'Planning assistant', avatarUrl: '', systemPrompt: '', isDefault: false },
  ],
}));

vi.mock('../../stores/aiStore', () => ({
  useAIStore: () => ({ agents, getActiveAgent: () => agents[0], setActiveAgent }),
}));
vi.mock('../../stores/chatStore', () => ({
  useChatStore: () => ({ threads: [], newChat: vi.fn(), selectThread: vi.fn(), deleteThread: vi.fn() }),
}));
vi.mock('../../stores/uiStore', () => ({
  useUIStore: () => ({ taskMode: false, activeTaskId: null, contextWindowOpen: false, setContextWindowOpen: vi.fn() }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: null }),
}));
vi.mock('../contextWindow', () => ({
  ContextWindowPanel: () => null,
  ContextWindowSummaryTooltip: () => null,
  ContextWindowRing: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key === 'sidebar.manageAgents' ? '+ Manage Agents' : key }),
}));

beforeEach(() => vi.clearAllMocks());

describe('chat toolbar', () => {
  it.each(['writer', 'task'] as const)('omits the TABS agent picker in %s chats', (mode) => {
    render(<RightPanelSubheader mode={mode} />);
    expect(screen.queryByRole('button', { name: 'Writing assistant' })).not.toBeInTheDocument();
    expect(screen.queryByText('+ Manage Agents')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Context window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chat history' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(setActiveAgent).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
