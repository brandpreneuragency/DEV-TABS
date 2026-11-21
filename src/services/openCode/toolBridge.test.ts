import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from './toolExecutor';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), unlisten: vi.fn() }));
vi.mock('../runtime', () => ({ isTauriRuntime: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
vi.mock('../codex/businessTools', () => ({ toolsForScope: () => [], isReadTool: () => true }));
vi.mock('./toolExecutor', () => ({ executeToolCall: vi.fn() }));

function fixture(): ToolContext {
  return { sessionId: 'ses_fixture', appThreadId: 'thread', admissionId: 'msg_one', scope: {
    appThreadId: 'thread', mode: 'task', taskId: 'project:p', projectId: 'p', workspaceRoot: 'C:/synthetic',
    permissionProfile: 'readOnly', agentId: 'default', context: '', capturedAt: 1,
  } };
}

describe('OpenCode tool bridge application lifetime', () => {
  beforeEach(() => {
    vi.resetModules();
    native.invoke.mockReset().mockResolvedValue(undefined);
    native.listen.mockReset().mockResolvedValue(native.unlisten);
    native.unlisten.mockReset();
  });

  it('shares StrictMode startup and makes old disposers harmless after a restart', async () => {
    const bridge = await import('./toolBridge');
    const first = bridge.startToolBridge();
    expect(bridge.startToolBridge()).toBe(first);
    const stop = await first;
    expect(native.invoke.mock.calls.filter(([command]) => command === 'open_code_tool_start')).toHaveLength(1);
    stop(); stop();
    expect(native.unlisten).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(native.invoke.mock.calls.filter(([command]) => command === 'open_code_tool_stop')).toHaveLength(1));
    const nextStop = await bridge.startToolBridge();
    stop();
    expect(native.invoke.mock.calls.filter(([command]) => command === 'open_code_tool_stop')).toHaveLength(1);
    nextStop();
  });

  it('preserves an identical captured turn and rejects same-admission scope changes', async () => {
    const bridge = await import('./toolBridge');
    const context = fixture();
    await bridge.bindToolContext(context);
    await bridge.bindToolContext(structuredClone(context));
    await expect(bridge.bindToolContext({ ...context, scope: { ...context.scope, projectId: 'foreign' } }))
      .rejects.toThrow('same admission');
    expect(native.invoke.mock.calls.filter(([command]) => command === 'open_code_tool_bind')).toHaveLength(2);
    await bridge.bindToolContext({ ...context, admissionId: 'msg_two' });
    (await bridge.startToolBridge())();
  });

  it('releases the first listener when the second listener cannot start', async () => {
    const bridge = await import('./toolBridge');
    native.listen.mockResolvedValueOnce(native.unlisten).mockRejectedValueOnce(new Error('Listener unavailable'));
    await expect(bridge.startToolBridge()).rejects.toThrow('Listener unavailable');
    expect(native.unlisten).toHaveBeenCalledTimes(1);
    const stop = await bridge.startToolBridge();
    stop();
  });

  it('stops the native listener when all activation retries fail', async () => {
    vi.useFakeTimers();
    try {
      const bridge = await import('./toolBridge');
      native.invoke.mockImplementation(async command => {
        if (command === 'open_code_tool_start') throw new Error('Plugin unavailable');
      });
      const failed = expect(bridge.startToolBridge()).rejects.toThrow('Plugin unavailable');
      await vi.runAllTimersAsync();
      await failed;
      expect(native.unlisten).toHaveBeenCalledTimes(2);
      expect(native.invoke.mock.calls.filter(([command]) => command === 'open_code_tool_stop')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});
