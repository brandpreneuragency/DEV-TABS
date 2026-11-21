import { create } from 'zustand';
import i18n from '../i18n';
import { isTauriRuntime } from '../services/runtime';
import { openCodeClient } from '../services/openCode/desktopClient';
import { initialStreamView, reconcileMessages, reduceOpenCodeEvent, type StreamView } from '../services/openCode/eventReducer';
import type { OpenCodeMessage, OpenCodeModel, OpenCodeAgent } from '../services/openCode/types';
import { openCodeSessionService } from '../services/openCode/sessionService';
import { listBindings } from '../services/openCode/persistence';
import { toFormInfo } from '../services/openCode/sessionService';
import type { FormInfo, PermissionRequest } from '../services/openCode/forms';
import type { OpenCodeSubmissionRecord } from '../services/openCode/schema';

interface ThreadRun extends StreamView {
  sessionId: string;
  forms: FormInfo[];
  permissions: PermissionRequest[];
  submissions: OpenCodeSubmissionRecord[];
}
interface OpenCodeState extends StreamView {
  models: OpenCodeModel[];
  agents: OpenCodeAgent[];
  activeSessionId: string | null;
  activeThreadId: string | null;
  runsByThread: Record<string, ThreadRun>;
  threadBySession: Record<string, string>;
  forms: FormInfo[];
  permissions: PermissionRequest[];
  submissions: OpenCodeSubmissionRecord[];
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
  setSession: (sessionId: string | null, threadId?: string | null) => void;
  snapshot: (sessionId: string) => Promise<void>;
  setBusy: (busy: boolean, threadId?: string) => void;
  isBusy: (threadId: string) => boolean;
  addProvisionalUser: (id: string, sessionId: string, text: string, threadId: string) => void;
}

let stopEvents: (() => void) | null = null;
let generationToken = 0;
let startPending: Promise<void> | null = null;
let pendingRequestsTimer: ReturnType<typeof setInterval> | null = null;
const pendingSnapshots = new Set<string>();

function connectionFailure(cause: unknown): Pick<StreamView, 'connection' | 'detail'> {
  if (!isTauriRuntime()) return { connection: 'unavailable', detail: null };
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;
  const connection = code === 'unauthorized' || code === 'versionMismatch' || code === 'incompatible'
    ? code : 'unavailable';
  const message = typeof cause === 'object' && cause !== null && 'message' in cause ? cause.message : null;
  return { connection, detail: typeof message === 'string' ? message : i18n.t('openCode.requestFailed') };
}

function runFor(sessionId: string, previous?: ThreadRun): ThreadRun {
  return previous ?? { ...initialStreamView, sessionId, forms: [], permissions: [], submissions: [] };
}

export const useOpenCodeStore = create<OpenCodeState>((set, get) => ({
  ...initialStreamView,
  models: [], agents: [], activeSessionId: null, activeThreadId: null, runsByThread: {}, threadBySession: {}, forms: [], permissions: [], submissions: [],
  start: async () => {
    if (stopEvents) return;
    if (startPending) return startPending;
    startPending = (async () => {
      const token = ++generationToken;
      const [status, models, agents] = await Promise.all([openCodeClient.discover(), openCodeClient.listModels(), openCodeClient.listAgents()]);
      set({ connection: status.state, generation: status.generation, detail: status.detail, models, agents });
      stopEvents = await openCodeClient.listen((event) => {
        if (token !== generationToken) return;
        const previousGeneration = get().generation;
        const previousConnection = get().connection;
        if (event.kind === 'lifecycle') {
          set({ connection: event.state, generation: event.generation, detail: event.detail });
          if (event.generation !== previousGeneration || event.state === 'connected' && previousConnection !== 'connected') {
            void get().refresh().catch(() => undefined);
            const sessionId = get().activeSessionId;
            if (sessionId) void openCodeClient.rebindSessions([sessionId]).then(async (outcomes) => {
              if (!outcomes[0]?.owned) {
                set({ detail: outcomes[0]?.reason ?? 'OpenCode could not verify this TABS session.' });
                return;
              }
              await get().snapshot(sessionId);
            }).catch((cause: unknown) => set({ detail: cause instanceof Error ? cause.message : 'OpenCode reconnect failed.' }));
          }
          return;
        }
        const item = event.event;
        const threadId = get().threadBySession[item.sessionId];
        if (!threadId) return;
        const currentRun = runFor(item.sessionId, get().runsByThread[threadId]);
        const reduced = reduceOpenCodeEvent(currentRun, event);
        const run = { ...currentRun, ...reduced };
        const isActive = get().activeThreadId === threadId;
        set((state) => ({
          runsByThread: { ...state.runsByThread, [threadId]: run },
          ...(isActive ? { messages: run.messages, busy: run.busy, activeSessionId: item.sessionId, forms: run.forms, permissions: run.permissions, submissions: run.submissions } : {}),
        }));
        if (item.kind === 'session.status' && item.status === 'idle' || item.kind === 'session.execution.interrupted') {
          void get().snapshot(item.sessionId).catch(() => undefined);
        }
      });
      await openCodeClient.subscribe();
      // Pending questions/permissions can arrive between tool/status events.
      // Reconcile busy owned sessions even when the SSE DTO has no request body.
      pendingRequestsTimer = setInterval(() => {
        for (const run of Object.values(get().runsByThread)) {
          if (!run.busy || pendingSnapshots.has(run.sessionId)) continue;
          pendingSnapshots.add(run.sessionId);
          void get().snapshot(run.sessionId).catch(() => undefined)
            .finally(() => pendingSnapshots.delete(run.sessionId));
        }
      }, 1500);
    })();
    try { await startPending; }
    catch (cause) { set(connectionFailure(cause)); throw cause; }
    finally { startPending = null; }
  },
  refresh: async () => {
    try {
      const [status, models, agents] = await Promise.all([openCodeClient.discover(), openCodeClient.listModels(), openCodeClient.listAgents()]);
      set({ connection: status.state, generation: status.generation, detail: status.detail, models, agents });
    } catch (cause) { set(connectionFailure(cause)); }
  },
  stop: async () => {
    generationToken += 1; stopEvents?.(); stopEvents = null;
    if (pendingRequestsTimer) clearInterval(pendingRequestsTimer);
    pendingRequestsTimer = null;
    await openCodeClient.unsubscribe();
  },
  setSession: (sessionId, threadId) => {
    const activeThreadId = threadId ?? null;
    if (!activeThreadId || !sessionId) {
      set({ activeSessionId: null, activeThreadId, messages: [], busy: false, forms: [], permissions: [], submissions: [] });
      return;
    }
    const run = runFor(sessionId, get().runsByThread[activeThreadId]);
    set((state) => ({
      activeSessionId: sessionId, activeThreadId, threadBySession: { ...state.threadBySession, [sessionId]: activeThreadId },
      runsByThread: { ...state.runsByThread, [activeThreadId]: run },
      messages: run.messages, busy: run.busy, connection: state.connection,
      generation: state.generation, detail: state.detail, forms: run.forms, permissions: run.permissions, submissions: run.submissions,
    }));
  },
  snapshot: async (sessionId) => {
    const binding = (await listBindings()).find((row) => row.sessionID === sessionId);
    const [messages, forms, permissions, submissions] = await Promise.all([
      binding ? openCodeSessionService.reconcile(binding.id) : openCodeClient.getMessages(sessionId),
      openCodeClient.listForms(sessionId), openCodeClient.listPermissions(sessionId),
      binding ? openCodeSessionService.submissions(binding.id) : Promise.resolve([]),
    ]);
    const threadId = binding?.id ?? get().threadBySession[sessionId];
    if (!threadId) return;
    const currentRun = runFor(sessionId, get().runsByThread[threadId]);
    const latestAssistant = messages.at(-1);
    const run: ThreadRun = {
      ...currentRun,
      messages: reconcileMessages(currentRun.messages, messages),
      busy: currentRun.busy && !(latestAssistant?.kind === 'assistant' && latestAssistant.completed !== null),
      forms: forms.map(toFormInfo),
      permissions: permissions.map((request) => ({ id: request.id, sessionID: request.sessionId, action: request.action, resources: request.resources, message: request.message ?? undefined })),
      submissions,
    };
    const isActive = get().activeThreadId === threadId;
    set((state) => ({
      runsByThread: { ...state.runsByThread, [threadId]: run },
      threadBySession: { ...state.threadBySession, [sessionId]: threadId },
      ...(isActive ? { messages: run.messages, busy: run.busy, forms: run.forms, permissions: run.permissions, submissions: run.submissions, activeSessionId: sessionId, activeThreadId: threadId } : {}),
    }));
  },
  setBusy: (busy, threadId = get().activeThreadId ?? '') => {
    if (!threadId) return;
    const run = get().runsByThread[threadId];
    if (!run) return;
    const next = { ...run, busy };
    set((state) => ({ runsByThread: { ...state.runsByThread, [threadId]: next }, ...(state.activeThreadId === threadId ? { busy } : {}) }));
  },
  isBusy: (threadId) => get().runsByThread[threadId]?.busy ?? false,
  addProvisionalUser: (id, sessionId, text, threadId) => {
    const run = runFor(sessionId, get().runsByThread[threadId]);
    const next = { ...run, messages: [...run.messages.filter((message) => message.id !== id), {
      id, sessionId, kind: 'user', created: Date.now(), completed: Date.now(), agent: null, model: null, finish: null,
      text, parts: [{ kind: 'text', text, tool: null }], error: null, notice: null,
    }] };
    set((state) => ({ runsByThread: { ...state.runsByThread, [threadId]: next }, ...(state.activeThreadId === threadId ? { messages: next.messages } : {}) }));
  },
}));
export type OpenCodeViewMessage = OpenCodeMessage;
