import { beforeEach, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ order: [] as string[], bind: vi.fn(), send: vi.fn() }));
vi.mock('./toolBridge', () => ({ bindToolContext: calls.bind }));
vi.mock('./sessionService', () => ({ openCodeSessionService: { send: calls.send } }));

import { dispatchOpenCodePrompt } from './promptDispatch';

beforeEach(() => { calls.order.length = 0; calls.bind.mockReset().mockImplementation(async () => { calls.order.push('bind'); }); calls.send.mockReset().mockImplementation(async () => { calls.order.push('send'); }); });

it('binds the captured context before sending with the same stable admission ID', async () => {
  await dispatchOpenCodePrompt({
    threadId: 'tabs-thread', sessionId: 'oc-session', admissionId: 'msg_stable', modelId: 'provider:model',
    text: 'Please review', context: '[REPLY TO user msg_1]\nDocument context',
    scope: {
      appThreadId: 'tabs-thread', mode: 'writer', workspaceRoot: 'C:/workspace', hasConnectedFolder: false,
      permissionProfile: 'readOnly', agentId: 'writer-persona', context: '[REPLY TO user msg_1]\nDocument context',
      attachments: [{ name: 'secret.txt', mimeType: 'text/plain', kind: 'file', dataUrl: 'data:text/plain;base64,QQ==' }], capturedAt: 1,
    },
    attachments: [{ name: 'secret.txt', mimeType: 'text/plain', kind: 'file', dataUrl: 'data:text/plain;base64,QQ==' }],
  });

  expect(calls.order).toEqual(['bind', 'send']);
  expect(calls.bind).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: 'oc-session', appThreadId: 'tabs-thread', admissionId: 'msg_stable', modelId: 'provider:model',
    scope: expect.objectContaining({ context: '[REPLY TO user msg_1]\nDocument context', attachments: undefined }),
  }));
  expect(calls.send).toHaveBeenCalledWith('tabs-thread', expect.stringContaining('[REPLY TO user msg_1]'), 'msg_stable');
});
