import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBinding: vi.fn(),
  getSubmission: vi.fn(),
  listBindings: vi.fn(),
  pendingSubmissions: vi.fn(),
  saveBinding: vi.fn(),
  saveSubmission: vi.fn(),
  submissionsForChat: vi.fn(),
  updateSubmission: vi.fn(),
  getMessages: vi.fn(),
  getSession: vi.fn(),
  prompt: vi.fn(),
  listForms: vi.fn(),
  interrupt: vi.fn(),
  cancelToolContext: vi.fn(),
}));

vi.mock('./desktopClient', () => ({ openCodeClient: {
  status: vi.fn(), discover: vi.fn(), listModels: vi.fn(), listAgents: vi.fn(),
  createSession: vi.fn(), rebindSessions: vi.fn(), getSession: mocks.getSession, getMessages: mocks.getMessages,
  prompt: mocks.prompt, interrupt: mocks.interrupt, switchModel: vi.fn(), switchAgent: vi.fn(),
  listForms: mocks.listForms, replyForm: vi.fn(), listPermissions: vi.fn(), replyPermission: vi.fn(),
  deleteSession: vi.fn(), listen: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
} }));
vi.mock('./persistence', () => ({
  getBinding: mocks.getBinding, getSubmission: mocks.getSubmission, listBindings: mocks.listBindings,
  pendingSubmissions: mocks.pendingSubmissions, saveBinding: mocks.saveBinding, saveSubmission: mocks.saveSubmission,
  submissionsForChat: mocks.submissionsForChat, updateSubmission: mocks.updateSubmission,
}));
vi.mock('./toolBridge', () => ({ cancelToolContext: mocks.cancelToolContext }));

import { OpenCodeSessionService, normalizeFormField } from './sessionService';

const binding = { id: 'thread-a', sessionID: 'session-a', projectID: 'project-a', directory: 'C:/work', ownershipMarker: 'thread-a', mode: 'writer' as const, title: 'Chat', createdAt: 1, updatedAt: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBinding.mockResolvedValue(binding);
  mocks.pendingSubmissions.mockResolvedValue([]);
  mocks.getMessages.mockResolvedValue([]);
  mocks.getSession.mockResolvedValue({ threadId: 'thread-a', projectId: 'project-a', directory: 'C:/work' });
  mocks.prompt.mockResolvedValue(undefined);
});

describe('OpenCode session service', () => {
  it('reconciles only exact admission IDs against a verified session mapping', async () => {
    mocks.pendingSubmissions.mockResolvedValue([{ id: 'msg_123', chatId: 'thread-a', sessionID: 'session-a', status: 'ambiguous', createdAt: 1, attempts: 1 }]);
    mocks.getMessages.mockResolvedValue([{ id: '123', kind: 'user' }, { id: 'msg_123', kind: 'user' }]);

    await new OpenCodeSessionService().reconcile('thread-a');

    expect(mocks.getSession).toHaveBeenCalledWith('session-a');
    expect(mocks.updateSubmission).toHaveBeenCalledWith('msg_123', expect.objectContaining({ status: 'accepted', request: undefined }));
  });

  it('refuses a session mapping that belongs to another TABS thread', async () => {
    mocks.getSession.mockResolvedValue({ threadId: 'other-thread', projectId: 'project-a', directory: 'C:/work' });
    await expect(new OpenCodeSessionService().reconcile('thread-a')).rejects.toThrow('ownership changed');
    expect(mocks.updateSubmission).not.toHaveBeenCalled();
  });

  it('persists the stable admission receipt before sending and uses the same ID', async () => {
    await new OpenCodeSessionService().send('thread-a', 'hello', 'msg_stable');
    expect(mocks.saveSubmission).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg_stable', status: 'pending' }));
    expect(mocks.prompt).toHaveBeenCalledWith('session-a', 'msg_stable', 'hello');
    expect(mocks.updateSubmission).toHaveBeenCalledWith('msg_stable', expect.objectContaining({ status: 'accepted' }));
  });

  it('cancels renderer tool work before interrupting the owned OpenCode session', async () => {
    const service = new OpenCodeSessionService();
    mocks.interrupt.mockImplementation(async () => {
      expect(mocks.cancelToolContext).toHaveBeenCalledWith('session-a');
      return true;
    });

    await expect(service.stop('thread-a')).resolves.toBe(true);
    expect(mocks.interrupt).toHaveBeenCalledWith('session-a');
  });

  it('preserves bounded native form constraints and defaults', () => {
    const field = normalizeFormField({
      key: 'name', kind: 'string', title: null, description: null, required: false, hidden: false,
      options: [], url: null,
      schema: { type: 'string', default: 'Ada', minLength: 2, maxLength: 40, pattern: '^[A-Z]',
        when: [{ key: 'mode', op: 'eq', value: 'custom' }] },
    });
    expect(field).toMatchObject({ type: 'string', default: 'Ada', minLength: 2, maxLength: 40, pattern: '^[A-Z]', when: [{ key: 'mode', op: 'eq', value: 'custom' }] });
  });
});
