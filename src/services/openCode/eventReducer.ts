import type { OpenCodeEvent, OpenCodeMessage } from './types';

/** Deltas are provisional; authoritative context snapshots replace them. */
export interface StreamView { messages: OpenCodeMessage[]; busy: boolean; generation: number; connection: string; detail: string | null }
export const initialStreamView: StreamView = { messages: [], busy: false, generation: 0, connection: 'unavailable', detail: null };
export function reduceOpenCodeEvent(state: StreamView, event: OpenCodeEvent): StreamView {
  if (event.kind === 'lifecycle') return { ...state, generation: event.generation, connection: event.state, detail: event.detail, busy: event.state === 'degraded' ? state.busy : state.busy };
  const item = event.event;
  let messages = state.messages;
  if (item.kind === 'session.text.delta' && item.delta) {
    const id = item.assistantMessageId ?? `stream:${item.sessionId}`;
    const existing = messages.find((message) => message.id === id)
      ?? (id.startsWith('stream:') ? undefined : messages.find((message) => message.id === `stream:${item.sessionId}`));
    const next: OpenCodeMessage = existing
      ? { ...existing, id, text: `${existing.text ?? ''}${item.delta}`, parts: [{ kind: 'text', text: `${existing.text ?? ''}${item.delta}`, tool: null }, ...existing.parts.filter((part) => part.kind !== 'text')] }
      : { id, sessionId: item.sessionId, kind: 'assistant', created: item.created, completed: null, agent: null, model: null, finish: null, text: item.delta, parts: [{ kind: 'text', text: item.delta, tool: null }], error: null, notice: null };
    messages = existing ? [...messages.filter((message) => message.id !== existing.id), next] : [...messages, next];
  } else if (item.kind.includes('tool') && item.tool) {
    const id = item.assistantMessageId ?? `stream:${item.sessionId}`;
    const existing = messages.find((message) => message.id === id);
    const part = { kind: 'tool', text: null, tool: item.tool };
    const next = existing ? { ...existing, parts: [...existing.parts.filter((p) => p.tool?.id !== item.tool?.id), part] }
      : { id, sessionId: item.sessionId, kind: 'assistant', created: item.created, completed: null, agent: null, model: null, finish: null, text: null, parts: [part], error: null, notice: null };
    messages = existing ? messages.map((message) => message.id === id ? next : message) : [...messages, next];
  }
  const settled = item.kind === 'session.status' && item.status === 'idle' || item.kind === 'session.execution.interrupted';
  return { ...state, messages, busy: settled ? false : item.kind === 'session.status' && item.status === 'busy' ? true : state.busy };
}

export function reconcileMessages(local: readonly OpenCodeMessage[], authoritative: readonly OpenCodeMessage[]): OpenCodeMessage[] {
  // Server transcript wins. Retain only an in-flight streamed assistant bubble not yet committed by /context.
  const ids = new Set(authoritative.map((message) => message.id));
  const provisional = local.filter((message) => message.id.startsWith('stream:') || message.completed === null
    || message.kind === 'user' && message.id.startsWith('msg_'))
    .filter((message) => !ids.has(message.id));
  return [...authoritative, ...provisional].sort((a, b) => a.created - b.created);
}
