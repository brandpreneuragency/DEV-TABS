import { useEffect, useState } from 'react';
import { Editor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { db } from '../../../services/db';
import { isOpenCodeAcceptanceRuntime } from '../../../services/runtime';
import { openCodeClient } from '../../../services/openCode/desktopClient';
import { openCodeSessionService } from '../../../services/openCode/sessionService';
import { dispatchOpenCodePrompt } from '../../../services/openCode/promptDispatch';
import { reportOpenCodeAcceptance } from '../../../services/openCode/acceptance';
import { useOpenCodeStore } from '../../../stores/openCodeStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { editorRef } from '../../../stores/editorRef';
import type { CodexScope } from '../../../services/codex/sessionTypes';
import type { OpenCodeSession } from '../../../services/openCode/types';
import { OpenCodeRequestPanel } from '../OpenCodeRequestPanel';

if (!isOpenCodeAcceptanceRuntime()) throw new Error('Isolated native profile required');
const MODEL = { id: 'gpt-6-luna', providerId: 'openai', variant: null };
const MODEL_NAME = 'openai/gpt-6-luna';
let started = false;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 500));
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

export default function OpenCodeAcceptanceApp() {
  const [checks, setChecks] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const state = useOpenCodeStore();

  useEffect(() => {
    if (started) return;
    started = true;
    const passed: string[] = [];
    const sessions: OpenCodeSession[] = [];
    let deltaCount = 0;
    let permissionCount = 0;
    let rejectionCount = 0;
    let stopListener: (() => void) | undefined;
    let fixtureEditor: Editor | undefined;
    const pass = (name: string) => { passed.push(name); setChecks([...passed]); };
    const run = async () => {
      try {
        await db.open();
        const acceptance = '__TABS_OPENCODE_ACCEPTANCE_CONTEXT__' in window ? window.__TABS_OPENCODE_ACCEPTANCE_CONTEXT__ : null;
        if (acceptance && typeof acceptance === 'object' && 'resume' in acceptance && acceptance.resume === true) {
          await useOpenCodeStore.getState().start();
          await openCodeSessionService.reconcileBindings();
          const bindings = await db.openCodeChats.toArray();
          assert(bindings.length >= 2, 'Restart lost the owned session mappings');
          for (const binding of bindings) {
            useOpenCodeStore.getState().setSession(binding.sessionID, binding.id);
            await useOpenCodeStore.getState().snapshot(binding.sessionID);
            assert(useOpenCodeStore.getState().messages.every(message => message.sessionId === binding.sessionID), 'Restart mixed session messages');
          }
          assert(await db.tasks.count() === 1, 'Restart lost or duplicated the fixture task');
          pass('Full native process restart: profile, mappings, owned transcripts and fixture task preserved');
          await reportOpenCodeAcceptance({ passed: true, checks: passed, model: MODEL_NAME, sessions: bindings.map(binding => binding.sessionID) });
          return;
        }
        assert(await db.tasks.count() === 0 && await db.workspaces.count() === 0, 'Acceptance profile must be fresh');
        const status = await openCodeClient.discover();
        assert(status.state === 'connected', 'Local OpenCode service is not connected');
        const models = await openCodeClient.listModels();
        assert(models.some(model => model.providerId === MODEL.providerId && model.modelId === MODEL.id && model.enabled), 'The explicitly selected model is unavailable');
        await useOpenCodeStore.getState().start();
        stopListener = await openCodeClient.listen(event => {
          if (event.kind === 'stream' && sessions.some(session => session.id === event.event.sessionId)
            && event.event.kind === 'session.text.delta') deltaCount += 1;
        });
        pass('Native WebView, isolated database and exact model discovery');
        await reportOpenCodeAcceptance({ passed: false, checks: passed, model: MODEL_NAME, sessions: [] });

        const createSession = async (mode: 'writer' | 'task') => {
          const threadId = `acceptance-${mode}-${crypto.randomUUID()}`;
          const session = await openCodeClient.createSession({ threadId, title: 'TABS synthetic acceptance', model: MODEL });
          sessions.push(session);
          await db.openCodeChats.put({ id: threadId, sessionID: session.id, projectID: session.projectId,
            directory: session.directory, ownershipMarker: threadId, mode, title: 'Synthetic acceptance', createdAt: Date.now(), updatedAt: Date.now() });
          return { session, threadId };
        };
        const waitForReply = async (session: OpenCodeSession, admission: string, allowTool?: string) => {
          const deadline = Date.now() + 120_000;
          const answered = new Set<string>();
          let denied = false;
          while (Date.now() < deadline) {
            await useOpenCodeStore.getState().snapshot(session.id);
            const runState = useOpenCodeStore.getState().runsByThread[session.threadId!];
            for (const permission of runState?.permissions ?? []) {
              if (answered.has(permission.id)) continue;
              // The native fixture has no owner data. Only its named business mutation may be approved.
              const allow = permission.action === 'tabs.mutate' && permission.resources.length === 1 && permission.resources[0] === allowTool;
              answered.add(permission.id);
              await openCodeClient.replyPermission(session.id, permission.id, allow ? 'once' : 'reject');
              if (allow) permissionCount += 1;
              else { rejectionCount += 1; denied = true; }
            }
            const messages = await openCodeClient.getMessages(session.id);
            const userIndex = messages.findIndex(message => message.id === admission);
            const replies = userIndex < 0 ? [] : messages.slice(userIndex + 1).filter(message => message.kind === 'assistant');
            const failure = replies.find(message => message.error);
            if (failure?.error && !denied) throw new Error(`Model execution failed: ${failure.error.kind}`);
            const last = replies.at(-1);
            if (last?.completed && last.finish !== 'tool-calls' && !last.parts.some(part => part.tool?.status === 'running')) return messages;
            await pause();
          }
          throw new Error('Synthetic model turn timed out');
        };
        const send = async (session: OpenCodeSession, scope: CodexScope, text: string, allowTool?: string) => {
          const admission = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
          useOpenCodeStore.getState().setSession(session.id, scope.appThreadId);
          useOpenCodeStore.getState().setBusy(true, scope.appThreadId);
          await dispatchOpenCodePrompt({ threadId: scope.appThreadId, sessionId: session.id, admissionId: admission,
            modelId: MODEL.id, scope, text, context: scope.context });
          return waitForReply(session, admission, allowTool);
        };
        const task = await createSession('task');
        await db.clients.put({ id: 'fixture-client', name: 'Synthetic client', color: '#888888', createdAt: 1, order: 0 });
        await db.projects.put({ id: 'fixture-project', clientId: 'fixture-client', name: 'Synthetic project', color: '#888888', createdAt: 1, order: 0 });
        const taskScope: CodexScope = { appThreadId: task.threadId, mode: 'task', taskId: 'project:fixture-project', projectId: 'fixture-project',
          workspaceRoot: status.workspace, permissionProfile: 'readOnly', agentId: 'acceptance', capturedAt: Date.now(), context: 'Synthetic acceptance only. Use only the named TABS business tool. Do not read files, call shell, network, MCP or other tools.' };
        await send(task.session, taskScope, 'Call tabs_tasks_create_v1 exactly once with title "OpenCode synthetic acceptance task". Then reply TASK_CREATED. Use no other tool.', 'tabs_tasks_create_v1');
        assert((await db.tasks.toArray()).filter(row => row.title === 'OpenCode synthetic acceptance task').length === 1, 'Model did not create exactly one fixture task');
        assert(permissionCount > 0, 'Mutation permission was not observed');
        pass('Real model → plugin permission → native bridge → local fixture task');
        const beforeReject = await db.tasks.count();
        await send(task.session, { ...taskScope, capturedAt: Date.now() },
          'Call tabs_tasks_create_v1 once with title "REJECTED synthetic task". If permission is rejected, do not retry; reply REJECTED. Use no other tool.');
        assert(await db.tasks.count() === beforeReject, 'Rejected permission still created a task');
        assert(rejectionCount > 0, 'The rejected permission was not observed');
        pass('Same-session continuation: rejected mutation created no task');

        fixtureEditor = new Editor({ extensions: [StarterKit], content: '<p>Hello fixture</p>' });
        editorRef.current = fixtureEditor;
        setEditor(fixtureEditor);
        const content = JSON.stringify(fixtureEditor.getJSON());
        const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
        const hash = [...new Uint8Array(hashBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        const workspace = { id: 'fixture-workspace', name: 'Synthetic editor', connectedFolders: [], activeFolderId: null,
          currentFile: { path: 'synthetic.md', name: 'synthetic.md', content, isDirty: true }, expandedPaths: [],
          selectedTreePath: null, createdAt: 1, updatedAt: 1, order: 0 };
        await db.workspaces.put(workspace);
        useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
        const document = await createSession('writer');
        const documentScope: CodexScope = { ...taskScope, appThreadId: document.threadId, mode: 'writer', taskId: undefined, projectId: undefined,
          workspaceId: workspace.id, selectedText: 'Hello', selectionFrom: 1, selectionTo: 6,
          document: { path: 'synthetic.md', name: 'synthetic.md', content, contentHash: hash, contentComplete: true, isDirty: true, workspaceRevision: 1 } };
        await send(document.session, documentScope, `Call tabs_document_replace_selection_v1 exactly once with expectedContentHash "${hash}" and replacement "Verified". Then reply DOCUMENT_CHANGED. Use no other tool.`, 'tabs_document_replace_selection_v1');
        assert(fixtureEditor.getText() === 'Verified fixture', 'Captured editor replacement did not appear');
        pass('Real model → approved document tool → actual WebView editor');
        assert(deltaCount > 0, 'No live text SSE reached the WebView');
        pass('Live assistant text reached the native WebView');

        const { invoke } = await import('@tauri-apps/api/core');
        const form = await invoke<{ data: { id: string } }>('acceptance_form', { sessionId: document.session.id });
        await useOpenCodeStore.getState().snapshot(document.session.id);
        let clicked = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const card = [...window.document.querySelectorAll('.open-code-request-card')]
            .find(element => element.textContent?.includes('Synthetic question'));
          const button = card?.querySelector<HTMLButtonElement>('.open-code-request-actions button');
          if (button && !button.disabled) { button.click(); clicked = true; break; }
          await pause();
        }
        assert(clicked, 'Native question form did not render an enabled answer button');
        let answered = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const detail = await invoke<{ data: { state: { status: string; answer?: { confirm?: boolean } } } }>('acceptance_form', { sessionId: document.session.id, formId: form.data.id });
          if (detail.data.state.status === 'answered') {
            assert(detail.data.state.answer?.confirm === false, 'Boolean false was lost in the question reply');
            answered = true; break;
          }
          await pause();
        }
        assert(answered, 'The question answer was not committed');
        pass('Actual WebView question button → native form reply, required boolean false preserved');

        const stopping = await createSession('writer');
        let stopResult: Promise<boolean> | undefined;
        const stopOnDelta = await openCodeClient.listen(event => {
          if (event.kind === 'stream' && event.event.sessionId === stopping.session.id && event.event.kind === 'session.text.delta') {
            stopResult ??= openCodeSessionService.stop(stopping.threadId);
          }
        });
        try {
          useOpenCodeStore.getState().setSession(stopping.session.id, stopping.threadId);
          const admission = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
          await dispatchOpenCodePrompt({ threadId: stopping.threadId, sessionId: stopping.session.id, admissionId: admission,
            modelId: MODEL.id, scope: { ...taskScope, appThreadId: stopping.threadId, mode: 'writer', taskId: undefined, projectId: undefined },
            context: 'Synthetic stop test. Use no tools.', text: 'Output the integers 1 through 20000, separated by spaces. Use no tools.' });
          const deadline = Date.now() + 60_000;
          while (!stopResult && Date.now() < deadline) await pause();
          assert(stopResult && await stopResult, 'The running owned model turn was not interrupted');
        } finally { stopOnDelta(); }
        pass('Stop cancelled an actual streaming model turn without stopping the shared service');

        await useOpenCodeStore.getState().stop();
        await useOpenCodeStore.getState().start();
        await openCodeSessionService.reconcileBindings();
        await useOpenCodeStore.getState().snapshot(task.session.id);
        useOpenCodeStore.getState().setSession(task.session.id, task.threadId);
        assert(useOpenCodeStore.getState().messages.every(message => message.sessionId === task.session.id), 'Cross-session transcript leakage');
        db.close(); await db.open();
        assert((await db.openCodeChats.get(task.threadId))?.sessionID === task.session.id, 'Mapping did not survive database reopen');
        pass('Subscription reconnect, ownership rebind, context switching and durable mapping reopen');
        await reportOpenCodeAcceptance({ passed: true, checks: passed, model: MODEL_NAME, sessions: sessions.map(session => session.id) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Native acceptance failed';
        setError(message);
        await reportOpenCodeAcceptance({ passed: false, checks: passed, error: message, model: MODEL_NAME, sessions: sessions.map(session => session.id) });
      } finally {
        for (const session of sessions) await openCodeClient.interrupt(session.id).catch(() => false);
        stopListener?.();
        await useOpenCodeStore.getState().stop().catch(() => {});
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('acceptance_quit');
      }
    };
    void run();
  }, []);

  return <main className="ui-page-body">
    <h1>TABS OpenCode — isolated native acceptance</h1>
    <p>Model: {MODEL_NAME}. Synthetic local records only.</p>
    <ol>{checks.map(check => <li key={check}>{check}</li>)}</ol>
    {error && <p role="alert">{error}</p>}
    <EditorContent editor={editor} />
    <section aria-label="Native OpenCode transcript">{state.messages.map(message => <p key={message.id}>{message.text}</p>)}</section>
    <OpenCodeRequestPanel forms={state.forms} permissions={state.permissions}
      onOpenExternal={async () => { throw new Error('External navigation is disabled in the isolated fixture'); }}
      onFormSubmit={async (form, answer) => { await openCodeClient.replyForm(form.sessionID, form.id, answer); }}
      onPermissionDecision={async (request, decision) => { await openCodeClient.replyPermission(request.sessionID, request.id, decision); }} />
  </main>;
}
