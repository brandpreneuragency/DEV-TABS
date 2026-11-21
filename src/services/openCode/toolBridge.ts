import { isTauriRuntime } from '../runtime';
import { isReadTool, toolsForScope } from '../codex/businessTools';
import { executeToolCall, type ToolCall, type ToolContext } from './toolExecutor';

const contexts = new Map<string, ToolContext>();
const active = new Map<string, { sessionId: string; controller: AbortController }>();
let startup: Promise<() => void> | undefined;
let shutdown: Promise<void> = Promise.resolve();

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriRuntime()) throw new Error('OpenCode tools require the TABS desktop app');
  const { invoke: native } = await import('@tauri-apps/api/core');
  return native<T>(command, args);
}

export async function bindToolContext(context: ToolContext): Promise<void> {
  await startToolBridge();
  const captured = structuredClone(context);
  const previous = contexts.get(context.sessionId);
  if (previous?.admissionId === context.admissionId && JSON.stringify(previous) !== JSON.stringify(captured)) {
    throw new Error('Captured TABS context changed for the same admission');
  }
  const tools = toolsForScope(captured.scope).map(tool => ({ ...tool, readOnly: isReadTool(tool.name) }));
  await invoke('open_code_tool_bind', { sessionId: context.sessionId, admissionId: context.admissionId, tools });
  if (previous?.admissionId !== context.admissionId) cancelToolContext(context.sessionId);
  contexts.set(context.sessionId, captured);
}

export function cancelToolContext(sessionId: string): void {
  contexts.delete(sessionId);
  for (const item of active.values()) {
    if (item.sessionId === sessionId) item.controller.abort();
  }
}

export function startToolBridge(): Promise<() => void> {
  if (!isTauriRuntime()) return Promise.resolve(() => {});
  if (startup) return startup;
  startup = start().catch(error => { startup = undefined; throw error; });
  return startup;
}

async function start(): Promise<() => void> {
  await shutdown;
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<ToolCall>('open_code://tool', ({ payload: call }) => {
    const context = contexts.get(call.sessionId);
    const controller = new AbortController();
    active.set(call.requestId, { sessionId: call.sessionId, controller });
    void (async () => {
      try {
        if (!context) throw new Error('Captured TABS context is unavailable; resend the turn');
        const result = await executeToolCall(context, call, controller.signal,
          () => invoke('open_code_tool_validate', { requestId: call.requestId }));
        await invoke('open_code_tool_complete', { requestId: call.requestId, result });
      } catch {
        await invoke('open_code_tool_complete', { requestId: call.requestId,
          result: { error: 'TABS tool failed, was cancelled, or requires context recovery' } }).catch(() => {});
      } finally { active.delete(call.requestId); }
    })();
  });
  let unlistenEvents: (() => void) | undefined;
  let nativeAttempted = false;
  try {
    unlistenEvents = await listen<{ kind: string; event?: { sessionId: string; kind: string } }>(
      'open_code://event', ({ payload }) => {
        if (payload.event && ['session.execution.interrupted', 'session.execution.failed'].includes(payload.event.kind)) {
          cancelToolContext(payload.event.sessionId);
        }
      });
    for (let attempt = 0; ; attempt += 1) {
      nativeAttempted = true;
      try { await invoke('open_code_tool_start'); break; }
      catch (error) {
        if (attempt === 11) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      unlisten(); unlistenEvents?.();
      for (const item of active.values()) item.controller.abort();
      active.clear(); contexts.clear(); startup = undefined;
      shutdown = invoke<void>('open_code_tool_stop').catch(() => {});
    };
  } catch (error) {
    unlisten(); unlistenEvents?.();
    if (nativeAttempted) {
      shutdown = invoke<void>('open_code_tool_stop').catch(() => {});
      await shutdown;
    }
    throw error;
  }
}
