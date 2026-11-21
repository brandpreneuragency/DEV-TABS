// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { db } from '../db';
import { crmFormsDb } from '../../data/crmFormsDb';
import { editorRef } from '../../stores/editorRef';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { executeToolCall, type ToolCall, type ToolContext } from './toolExecutor';

const context = (): ToolContext => ({ sessionId: 'ses_owned', admissionId: 'msg_user', appThreadId: 'thread',
  scope: { appThreadId: 'thread', mode: 'task', taskId: 'project:p', projectId: 'p',
    workspaceRoot: 'C:/synthetic', permissionProfile: 'workspaceWrite', agentId: 'default', context: '', capturedAt: 1 } });
const call = (toolName: string, input: Record<string, unknown> = {}): ToolCall => ({ requestId: 'relay',
  appThreadId: 'thread', sessionId: 'ses_owned', admissionId: 'msg_user', messageId: 'msg_assistant',
  callId: 'call_1', toolName, input, stage: 'prepare' });
const signal = () => new AbortController().signal;

describe('OpenCode business adapter with real isolated business services', () => {
  beforeEach(async () => {
    await Promise.all([db.delete(), crmFormsDb.delete()]);
    await Promise.all([db.open(), crmFormsDb.open()]);
    await db.clients.add({ id: 'c', name: 'Synthetic', color: '#fff', createdAt: 1, order: 0 });
    await db.projects.add({ id: 'p', name: 'Synthetic', clientId: 'c', color: '#fff', createdAt: 1, order: 0 });
  });
  afterEach(() => {
    editorRef.current?.destroy(); editorRef.current = null;
    useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
  });

  it('creates one fixture task and returns its durable receipt on replay', async () => {
    const owner = context(); const request = call('tabs_tasks_create_v1', { title: 'Synthetic task' });
    await executeToolCall(owner, request, signal());
    const applied = await executeToolCall(owner, { ...request, stage: 'execute' }, signal());
    const replay = await executeToolCall(owner, { ...request, stage: 'execute' }, signal());
    expect(replay).toEqual(applied);
    expect(await db.tasks.count()).toBe(1);
    expect(await db.codexOperationReceipts.count()).toBe(1);
  });

  it('persists separate assistant runs for one admission and replays both receipts after reopening', async () => {
    const owner = context();
    const requests = [
      call('tabs_tasks_create_v1', { title: 'First assistant task' }),
      { ...call('tabs_tasks_create_v1', { title: 'Second assistant task' }), messageId: 'msg_assistant_two' },
    ];
    const results = [];
    for (const request of requests) {
      await executeToolCall(owner, request, signal());
      results.push(await executeToolCall(owner, { ...request, stage: 'execute' }, signal()));
    }
    const runs = await db.codexRuns.toArray();
    expect(runs.map(run => run.runId).sort()).toEqual([
      'opencode:ses_owned:msg_assistant', 'opencode:ses_owned:msg_assistant_two',
    ]);
    expect(new Set(runs.map(run => run.clientCommandId)).size).toBe(2);
    expect(await db.codexPendingRequests.count()).toBe(2);
    db.close();
    await db.open();
    for (const [index, request] of requests.entries()) {
      expect(await executeToolCall(owner, { ...request, stage: 'execute' }, signal())).toEqual(results[index]);
    }
    expect((await db.tasks.toArray()).map(task => task.title).sort()).toEqual([
      'First assistant task', 'Second assistant task',
    ]);
    expect(await db.codexOperationReceipts.count()).toBe(2);
  });

  it('does not execute when native call validation rejects or the turn is cancelled', async () => {
    const owner = context(); const request = call('tabs_tasks_create_v1', { title: 'Denied' });
    await executeToolCall(owner, request, signal());
    await expect(executeToolCall(owner, { ...request, stage: 'execute' }, signal(), async () => {
      throw new Error('Native rejected');
    })).rejects.toThrow('Native rejected');
    const controller = new AbortController(); controller.abort();
    await expect(executeToolCall(owner, { ...request, stage: 'execute' }, controller.signal)).rejects.toThrow();
    expect(await db.tasks.count()).toBe(0);
  });

  it('checks cancellation before joining an identical in-flight call', async () => {
    const owner = context(); const request = call('tabs_tasks_create_v1', { title: 'Fixture' });
    const first = executeToolCall(owner, request, signal());
    const controller = new AbortController(); controller.abort();
    try {
      await expect(executeToolCall(owner, request, controller.signal)).rejects.toThrow();
    } finally { await first; }
    expect(await db.tasks.count()).toBe(0);
  });

  it('rejects another session and changed call input', async () => {
    const owner = context(); const request = call('tabs_tasks_create_v1', { title: 'Original' });
    await expect(executeToolCall(owner, { ...request, sessionId: 'ses_foreign' }, signal())).rejects.toThrow('captured');
    await executeToolCall(owner, request, signal());
    await expect(executeToolCall(owner, { ...request, stage: 'execute', input: { title: 'Changed' } }, signal()))
      .rejects.toThrow('contents changed');
    expect(await db.tasks.count()).toBe(0);
  });

  it('preserves local task compare-and-set when the fixture changes after approval', async () => {
    await db.tasks.add({ id: 'task', title: 'Before', content: '', projectId: 'p', status: 'pending',
      importance: 'medium', date: '2026-10-22', assignees: [], order: 0, createdAt: 1, updatedAt: 1 });
    const owner = context(); const request = call('tabs_tasks_update_v1', { taskId: 'task', expectedUpdatedAt: 1, title: 'After' });
    await executeToolCall(owner, request, signal());
    await db.tasks.update('task', { title: 'Concurrent edit', updatedAt: 2 });
    const result = await executeToolCall(owner, { ...request, stage: 'execute' }, signal());
    expect(result.text).toContain('conflict');
    expect((await db.tasks.get('task'))?.title).toBe('Concurrent edit');
  });

  it('edits the captured fixture document once and rejects a stale editor', async () => {
    const editor = new Editor({ extensions: [StarterKit], content: '<p>Hello world</p>' });
    editorRef.current = editor;
    const content = JSON.stringify(editor.getJSON());
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const hash = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const workspace = { id: 'w', name: 'Synthetic', connectedFolders: [], activeFolderId: null,
      currentFile: { path: 'C:/synthetic/a.md', name: 'a.md', content, isDirty: true }, expandedPaths: [],
      selectedTreePath: null, createdAt: 1, updatedAt: 1, order: 0 };
    await db.workspaces.put(workspace);
    useWorkspaceStore.setState({ workspaces: [workspace], activeWorkspaceId: 'w' });
    const owner = context(); Object.assign(owner.scope, { mode: 'writer', workspaceId: 'w', selectedText: 'Hello',
      selectionFrom: 1, selectionTo: 6, document: { path: 'C:/synthetic/a.md', name: 'a.md', content,
        contentHash: hash, contentComplete: true, isDirty: true, workspaceRevision: 1 } });
    const request = call('tabs_document_replace_selection_v1', { expectedContentHash: hash, replacement: 'Goodbye' });
    await executeToolCall(owner, request, signal());
    await executeToolCall(owner, { ...request, stage: 'execute' }, signal());
    await executeToolCall(owner, { ...request, stage: 'execute' }, signal());
    expect(editor.getText()).toBe('Goodbye world');
    const stale = { ...request, callId: 'call_stale' };
    await expect(executeToolCall(owner, stale, signal())).rejects.toThrow('revision changed');
    expect(await db.codexDocumentIntents.count()).toBe(1);
  });
});
