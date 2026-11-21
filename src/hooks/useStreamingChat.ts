import { useCallback, useEffect } from 'react';
import type { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import type { Attachment } from '../types';
import { useChatStore } from '../stores/chatStore';
import { isTauriRuntime } from '../services/runtime';
import { boundedContext, captureCodexScope } from '../services/codex/contextBuilder';
import { db } from '../services/db';
import { loadProviderModelVisibility, visibleProviderModels } from '../services/providers/modelVisibility';
import { dispatchOpenCodePrompt } from '../services/openCode/promptDispatch';
import { openCodeClient } from '../services/openCode/desktopClient';
import { openCodeSessionService } from '../services/openCode/sessionService';
import { useOpenCodeStore } from '../stores/openCodeStore';
import type { MemoryChatContext } from '../services/memoryNotes/chatContext';

const CONTEXT_LIMIT = 32_000;

function unsupportedImage(attachment: Attachment): boolean {
  return attachment.kind === 'image' || attachment.kind === undefined || attachment.mimeType.startsWith('image/')
    || attachment.dataUrl?.startsWith('data:image/') === true;
}

/** OpenCode is the only chat engine. TABS still captures bounded business context. */
export function useStreamingChat(
  threadId: string,
  mode: 'writer' | 'task',
  contextWorkspaceId?: string,
  contextTaskId?: string,
  contextSettingsTab?: string,
  editor?: Editor | null,
  memoryContext?: MemoryChatContext,
) {
  const { t } = useTranslation();
  const newChat = useChatStore((state) => state.newChat);

  useEffect(() => {
    if (!threadId || !isTauriRuntime()) return;
    let current = true;
    let started = false;
    void useOpenCodeStore.getState().start().then(() => {
      started = true;
      return openCodeSessionService.reconcileBindings();
    })
      .then(() => db.openCodeChats.get(threadId))
      .then(async (binding) => {
        if (!current || !binding) return;
        const store = useOpenCodeStore.getState();
        store.setSession(binding.sessionID, threadId);
        await store.snapshot(binding.sessionID);
      })
      .catch((error: unknown) => {
        // start() owns its connection error; recovery must not overwrite it.
        if (current && started) useOpenCodeStore.setState({ connection: 'degraded', detail: error instanceof Error ? error.message : 'OpenCode recovery failed.' });
      });
    return () => { current = false; };
  }, [threadId]);

  const sendMessage = useCallback(async (
    userText: string,
    selectedText?: string,
    selectionFrom?: number,
    selectionTo?: number,
    attachments?: Attachment[],
    searchWeb?: boolean,
    replyTo?: { id: string; role: 'user' | 'assistant'; content: string; sender: string },
  ) => {
    if (!isTauriRuntime()) throw new Error(t('openCode.desktopOnly'));
    if (searchWeb) throw new Error(t('openCode.searchUnavailable'));
    if (attachments?.some(unsupportedImage)) {
      throw new Error('Image attachments are not supported by the current OpenCode prompt transport. Remove the image or use a text document.');
    }

    let chatState = useChatStore.getState();
    if (memoryContext && (chatState.currentContext?.memoryId !== memoryContext.id || chatState.contextLoading)) {
      throw new Error('The Memory chat context changed. Open the item and try again.');
    }
    let activeThread = chatState.activeThreadId ?? threadId;
    if (!activeThread) {
      await newChat({ mode, workspaceId: contextWorkspaceId, taskId: contextTaskId, settingsTab: contextSettingsTab,
        memoryId: memoryContext?.id });
      chatState = useChatStore.getState();
      if (memoryContext && (chatState.currentContext?.memoryId !== memoryContext.id || chatState.contextLoading)) {
        throw new Error('The Memory chat context changed. Open the item and try again.');
      }
      activeThread = chatState.activeThreadId ?? '';
    }
    if (!activeThread) throw new Error('Could not create an OpenCode chat.');

    let thread = await db.chatThreads.get(activeThread);
    if (!thread) throw new Error('Could not load the active chat thread.');
    if (memoryContext && (thread.memoryId !== memoryContext.id || thread.workspaceId || thread.taskId || thread.settingsTab)) {
      throw new Error('This chat belongs to a different context.');
    }
    if (thread.origin !== 'openCode') {
      const changed = await useChatStore.getState().setEmptyThreadOpenCode(activeThread);
      if (!changed) throw new Error('This chat uses an older engine. Start a new OpenCode chat to continue.');
      thread = await db.chatThreads.get(activeThread);
      if (!thread) throw new Error('Could not load the OpenCode chat.');
    }

    const status = await openCodeClient.discover();
    if (status.state !== 'connected' && status.state !== 'degraded') throw new Error(status.detail ?? 'OpenCode service is unavailable.');
    const discovered = (await openCodeClient.listModels()).filter((model) => model.enabled);
    if (!discovered.length) throw new Error(t('openCode.noModels'));
    const models = visibleProviderModels(discovered, await loadProviderModelVisibility('openCode'));
    if (!models.length) throw new Error(t('openCode.noVisibleModels'));
    const preferredModelId = (await db.settings.get('openCodeModelId'))?.value;
    const model = models.find((item) => item.id === preferredModelId) ?? models[0];
    if (!model) throw new Error(t('openCode.noModels'));
    const agents = (await openCodeClient.listAgents()).filter((agent) => !agent.hidden);
    const preferredAgentId = (await db.settings.get('openCodeAgentId'))?.value;
    const agent = agents.find((item) => item.id === preferredAgentId) ?? agents[0];
    const existing = await db.openCodeChats.get(activeThread);
    if (memoryContext && existing && existing.memoryId !== memoryContext.id) {
      throw new Error('The OpenCode chat belongs to a different Memory item.');
    }
    const scope = await captureCodexScope({
      appThreadId: activeThread,
      mode,
      workspaceId: contextWorkspaceId,
      taskId: contextTaskId,
      settingsTab: contextSettingsTab,
      memoryContext,
      selectedText,
      selectionFrom,
      selectionTo,
      attachments,
      editor,
      model: model.modelId,
      permissionProfile: 'readOnly',
      fallbackWorkspaceRoot: existing?.directory ?? status.workspace,
    });

    if (replyTo) scope.context = boundedContext([scope.context, `[REPLY TO ${replyTo.role} ${replyTo.id}]\n${replyTo.content}`], CONTEXT_LIMIT);
    const session = existing
      ? await openCodeClient.getSession(existing.sessionID)
      : await openCodeClient.createSession({ threadId: activeThread, title: thread.title,
        model: { id: model.modelId, providerId: model.providerId, variant: null }, agent: agent?.id });
    if (session.threadId !== activeThread || existing && (session.projectId !== existing.projectID || session.directory !== existing.directory)) {
      throw new Error('OpenCode could not verify this TABS session mapping.');
    }
    if (!existing) {
      await db.openCodeChats.put({ id: activeThread, sessionID: session.id, projectID: session.projectId,
        directory: session.directory, ownershipMarker: activeThread, mode: thread.mode, workspaceId: thread.workspaceId,
        taskId: thread.taskId, settingsTab: thread.settingsTab, memoryId: thread.memoryId,
        title: thread.title, createdAt: thread.createdAt, updatedAt: Date.now() });
    } else {
      await openCodeClient.switchModel(session.id, { id: model.modelId, providerId: model.providerId, variant: null });
      if (agent) await openCodeClient.switchAgent(session.id, agent.id);
    }

    const admissionId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const openStore = useOpenCodeStore.getState();
    await openStore.start();
    openStore.setSession(session.id, activeThread);
    openStore.setBusy(true, activeThread);
    try {
      await dispatchOpenCodePrompt({
        threadId: activeThread, sessionId: session.id, admissionId, modelId: model.modelId,
        text: userText, context: scope.context, scope, attachments,
      });
      openStore.addProvisionalUser(admissionId, session.id, userText, activeThread);
    } catch (error) {
      openStore.setBusy(false, activeThread);
      await useOpenCodeStore.getState().snapshot(session.id).catch(() => undefined);
      throw error;
    }
    await useOpenCodeStore.getState().snapshot(session.id);
  }, [threadId, mode, contextWorkspaceId, contextTaskId, contextSettingsTab, editor, memoryContext, newChat, t]);

  const stopStreaming = useCallback(() => {
    const activeThread = useChatStore.getState().activeThreadId ?? threadId;
    void openCodeSessionService.stop(activeThread);
  }, [threadId]);

  return { sendMessage, stopStreaming };
}
