import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

async function fixture() {
  const state = { calls: [], tools: new Map(), rpc: undefined, hook: undefined };
  const editor = { add: tool => state.tools.set(tool.name, tool) };
  const ctx = {
    location: { directory: 'C:/synthetic' },
    tool: {
      transform: async callback => { state.transform = callback; callback(editor); return { dispose: async () => {} }; },
      reload: async () => state.transform(editor),
    },
    rpc: { register: async (_, handlers) => { state.rpc = handlers; return { dispose: async () => {} }; } },
    session: {
      get: async () => ({ metadata: { tabsThreadID: 'thread' }, location: { directory: 'C:/synthetic' } }),
      hook: async (_, callback) => { state.hook = callback; return { dispose: async () => {} }; },
    },
    permission: { assert: async input => { state.calls.push('permission'); state.permission = input; } },
  };
  await plugin.setup(ctx);
  await state.rpc.configure({ endpoint: 'http://127.0.0.1:12345/', token: 'synthetic-test-only' });
  const tool = { name: 'tabs_tasks_create_v1', description: 'fixture', inputSchema: { type: 'object' }, readOnly: true };
  await state.rpc.bind({ sessionID: 'ses_owned', admissionID: 'msg_user', tools: [tool] });
  return { state, ctx };
}

describe('TABS plugin approval and cancellation boundary', () => {
  it('requires OpenCode permission between preview and mutation, regardless of supplied readOnly', async () => {
    const { state } = await fixture();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, request) => {
      const body = JSON.parse(request.body);
      state.calls.push(body.stage);
      expect(request.signal).toBeDefined();
      return new Response(JSON.stringify(body.stage === 'prepare' ? { summary: 'Create synthetic task' } : { text: 'receipt' }));
    });
    try {
      const result = await state.tools.get('tabs_tasks_create_v1').execute({ title: 'Fixture' }, {
        sessionID: 'ses_owned', messageID: 'msg_assistant', id: 'call', agent: 'build', signal: new AbortController().signal,
      });
      expect(result).toEqual({ content: 'receipt' });
      expect(state.calls).toEqual(['prepare', 'permission', 'execute']);
      expect(state.permission.action).toBe('tabs.mutate');
      expect(state.permission).not.toHaveProperty('agent');
      expect(state.permission.source).toEqual({ type: 'tool', messageID: 'msg_assistant', id: 'call' });
    } finally { fetcher.mockRestore(); }
  });

  it('propagates permission rejection and never relays a mutation', async () => {
    const { state, ctx } = await fixture();
    ctx.permission.assert = async () => { throw new Error('Permission rejected'); };
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"summary":"fixture"}'));
    try {
      await expect(state.tools.get('tabs_tasks_create_v1').execute({}, { sessionID: 'ses_owned',
        messageID: 'msg_assistant', id: 'call', signal: new AbortController().signal })).rejects.toThrow('Permission rejected');
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { fetcher.mockRestore(); }
  });

  it('removes all TABS tools for foreign sessions and rejects direct foreign execution', async () => {
    const { state } = await fixture();
    const event = { sessionID: 'ses_foreign', tools: { tabs_tasks_create_v1: {}, read: {} } };
    state.hook(event);
    expect(Object.keys(event.tools)).toEqual(['read']);
    await expect(state.tools.get('tabs_tasks_create_v1').execute({}, { sessionID: 'ses_foreign' })).rejects.toThrow('captured');
  });

  it('keeps existing bindings on identical reconnect and passes the cancellation signal unchanged', async () => {
    const { state } = await fixture();
    await state.rpc.configure({ endpoint: 'http://127.0.0.1:12345/', token: 'synthetic-test-only' });
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, request) => {
      expect(request.signal).toBe(controller.signal);
      request.signal.throwIfAborted();
      throw new Error('unreachable');
    });
    try {
      await expect(state.tools.get('tabs_tasks_create_v1').execute({}, { sessionID: 'ses_owned',
        messageID: 'msg_assistant', id: 'call', signal: controller.signal })).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { fetcher.mockRestore(); }
  });
});
