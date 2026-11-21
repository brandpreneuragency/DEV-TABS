import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChatModelControls } from './ChatModelControls';
import { useOpenCodeStore } from '../../stores/openCodeStore';

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  put: vi.fn(async () => undefined),
  start: vi.fn(async () => undefined),
  setModel: vi.fn(async () => undefined),
  setAgent: vi.fn(async () => undefined),
  models: [
    { id: 'p:m1', providerId: 'p', modelId: 'm1', name: 'Model One', family: null, enabled: true, tools: true, contextLimit: 8192, outputLimit: null },
    { id: 'p:m2', providerId: 'p', modelId: 'm2', name: 'Model Two', family: null, enabled: true, tools: true, contextLimit: null, outputLimit: null },
  ],
  agents: [{ id: 'build', name: 'Build', mode: 'primary' as const, description: null, hidden: false, model: null }],
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../services/db', () => ({ db: { settings: {
  get: async (key: string) => mocks.settings.has(key) ? { key, value: mocks.settings.get(key) } : undefined,
  put: mocks.put,
} } }));
vi.mock('../../services/providers/modelVisibility', () => ({
  useProviderModelVisibility: () => ({ allHidden: false, hiddenModelIds: [] }),
  visibleProviderModels: <T extends { id: string }>(models: T[]) => models,
}));
vi.mock('../../services/openCode/sessionService', () => ({ openCodeSessionService: { setModel: mocks.setModel, setAgent: mocks.setAgent } }));

beforeEach(() => {
  mocks.settings = new Map(); mocks.put.mockClear(); mocks.start.mockClear(); mocks.setModel.mockClear(); mocks.setAgent.mockClear();
  useOpenCodeStore.setState({ models: mocks.models, agents: mocks.agents, connection: 'connected', start: mocks.start });
});

it('discovers and switches OpenCode models and agents only', async () => {
  render(<ChatModelControls threadId="thread-1" />);
  expect(await screen.findByRole('combobox', { name: 'openCode.model' })).toHaveValue('p:m1');
  expect(screen.getByRole('option', { name: 'Model One' })).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'openCode.model' }), { target: { value: 'p:m1' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'openCode.agent' }), { target: { value: 'build' } });
  expect(mocks.put).toHaveBeenCalledWith({ key: 'openCodeModelId', value: 'p:m1' });
  expect(mocks.setModel).toHaveBeenCalledWith('thread-1', { id: 'm1', providerId: 'p' });
  expect(mocks.setAgent).toHaveBeenCalledWith('thread-1', 'build');
  expect(mocks.start).toHaveBeenCalledOnce();
});

it('locks both selectors while the chat is sending', () => {
  render(<ChatModelControls threadId="thread-1" locked />);
  expect(screen.getByRole('combobox', { name: 'openCode.model' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'openCode.agent' })).toBeDisabled();
});

it('renders empty discovery and updates when visible models and agents arrive', () => {
  useOpenCodeStore.setState({ models: [], agents: [], connection: 'disconnected' });
  render(<ChatModelControls threadId="thread-1" />);
  expect(screen.getByRole('combobox', { name: 'openCode.model' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'openCode.agent' })).toBeDisabled();

  act(() => useOpenCodeStore.setState({
    connection: 'connected',
    models: [...mocks.models, { ...mocks.models[0], id: 'p:disabled', name: 'Disabled Model', enabled: false }],
    agents: [...mocks.agents, { ...mocks.agents[0], id: 'hidden', name: 'Hidden Agent', hidden: true }],
  }));

  expect(screen.getByRole('combobox', { name: 'openCode.model' })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'openCode.agent' })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'Model One' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Build' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Disabled Model' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Hidden Agent' })).not.toBeInTheDocument();
});
