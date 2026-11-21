import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallBubble } from './ToolCallBubble';
import type { ChatMessage } from '../../types';
import { db } from '../../services/db';
import { useOpenCodeStore } from '../../stores/openCodeStore';
import { openCodeSessionService } from '../../services/openCode/sessionService';
import { OpenCodeRequestPanel } from './OpenCodeRequestPanel';

interface ChatThreadProps {
  workspaceId: string | null;
  taskId?: string | null;
  editor: Editor | null;
  onReplyMessage?: (msg: ChatMessage) => void;
}

export function ChatThread({ taskId, editor, onReplyMessage }: ChatThreadProps) {
  const { t } = useTranslation();
  const [admissionError, setAdmissionError] = useState('');
  const { getActiveThreadMessages, activeThreadId, threads } = useChatStore();
  const openCode = useOpenCodeStore();
  const startOpenCode = useOpenCodeStore((state) => state.start);
  const setOpenCodeSession = useOpenCodeStore((state) => state.setSession);
  const loadOpenCodeSnapshot = useOpenCodeStore((state) => state.snapshot);
  const openCodeRun = activeThreadId ? openCode.runsByThread[activeThreadId] : undefined;
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const isOpenCode = activeThread?.origin === 'openCode';
  useEffect(() => {
    if (!isOpenCode || !activeThreadId) { setOpenCodeSession(null); return; }
    let live = true;
    void startOpenCode().then(() => openCodeSessionService.reconcileBindings()).then(() => db.openCodeChats.get(activeThreadId)).then(async (binding) => {
      if (!live || !binding) return;
      setOpenCodeSession(binding.sessionID, activeThreadId);
      await loadOpenCodeSnapshot(binding.sessionID);
    }).catch((cause: unknown) => {
      if (live) useOpenCodeStore.setState({ connection: 'degraded', detail: cause instanceof Error ? cause.message : 'OpenCode session reconciliation failed.' });
    });
    return () => { live = false; };
  }, [activeThreadId, isOpenCode, startOpenCode, setOpenCodeSession, loadOpenCodeSnapshot]);
  const nativeMessages = useMemo<ChatMessage[]>(() => (openCodeRun?.messages
    ?? (openCode.activeThreadId === activeThreadId ? openCode.messages : [])).map((message) => {
    const toolText = message.parts.filter((part) => part.kind === 'tool' && part.tool)
      .map((part) => `\n\n**${part.tool!.name}** — ${part.tool!.status}${part.tool!.output ? `\n\n${part.tool!.output}` : ''}${part.tool!.error ? `\n\n${part.tool!.error.message}` : ''}`).join('');
    return { id: message.id, threadId: activeThreadId ?? '', mode: activeThread?.mode ?? 'writer', workspaceId: activeThread?.workspaceId, taskId: activeThread?.taskId, settingsTab: activeThread?.settingsTab, agentId: message.agent ?? 'openCode', role: message.kind === 'user' ? 'user' : message.kind === 'assistant' ? 'assistant' : 'system', content: `${message.text ?? ''}${toolText}`, timestamp: message.created };
  }), [openCodeRun?.messages, openCode.activeThreadId, openCode.messages, activeThreadId, activeThread]);
  const messages = isOpenCode ? nativeMessages : getActiveThreadMessages();
  const isStreaming = isOpenCode && (openCodeRun?.busy ?? false);
  const streamingMessageId = isOpenCode
    ? [...messages].reverse().find((message) => message.role === 'assistant')?.id
    : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollRef.current || !bottomRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, isStreaming]);

  if (messages.length === 0 && !isOpenCode) {
    return (
      <div
        id="chat-empty-state"
        className="flex flex-1 h-full"
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 15px',
          verticalAlign: 'middle',
          fontSize: 'var(--fs-sm)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <Sparkles className="chat-empty-state-symbol" aria-hidden="true" />
          <p className="subtle" style={{ fontSize: 'var(--fs-sm)' }}>
            {taskId ? 'Ask about this task...' : t('chat.startConversation')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div id="scroll-ai" ref={scrollRef} className="ai-scroll flex-1 overflow-y-a flex flex-col" style={{ gap: 16 }}>
      {isOpenCode && messages.length === 0 && <div id="chat-empty-state" className="flex flex-1 h-full" style={{ alignItems: 'center', justifyContent: 'center', fontSize: 'var(--fs-sm)' }}><p className="subtle">{taskId ? 'Ask about this task...' : t('chat.startConversation')}</p></div>}
      {messages.map((msg) => (
        msg.role === 'tool_call' ? (
          <ToolCallBubble
            key={msg.id}
            message={msg}
          />
        ) : msg.role === 'user' ? (
          <UserMessage key={msg.id} message={msg} onReplyMessage={onReplyMessage} />
        ) : (
          <AssistantMessage
            key={msg.id}
            message={msg}
            isStreaming={msg.id === streamingMessageId}
            editor={editor}
            onReplyMessage={onReplyMessage}
          />
        )
      ))}
      {isOpenCode && (openCodeRun?.submissions ?? []).map((submission) => (
        <section key={submission.id} className="open-code-request-card" aria-label={t('openCode.admissionUnknown')}>
          <p className="open-code-request-error" role="status">{t('openCode.admissionUnknown')}</p>
          {admissionError && <p className="open-code-request-error" role="alert">{admissionError}</p>}
          <div className="open-code-request-actions">
            <button type="button" className="ui-button ui-button--ghost" onClick={() => {
              setAdmissionError('');
              void openCodeSessionService.reconcile(activeThreadId!).then(() => openCode.snapshot(openCode.activeSessionId!))
                .catch((cause: unknown) => setAdmissionError(cause instanceof Error ? cause.message : 'Reconciliation failed.'));
            }}>{t('openCode.reconcileAdmission')}</button>
            {submission.request && <button type="button" className="ui-button ui-button--primary" onClick={() => {
              setAdmissionError('');
              void openCodeSessionService.retrySubmission(activeThreadId!, submission.id).then(() => openCode.snapshot(openCode.activeSessionId!))
                .catch((cause: unknown) => setAdmissionError(cause instanceof Error ? cause.message : 'Safe retry failed.'));
            }}>{t('openCode.retryAdmission')}</button>}
          </div>
        </section>
      ))}
      {isOpenCode && <OpenCodeRequestPanel forms={openCodeRun?.forms ?? []} permissions={openCodeRun?.permissions ?? []}
        disabled={openCode.connection !== 'connected' && openCode.connection !== 'degraded'}
        onFormSubmit={async (form, answer) => { await openCodeSessionService.replyForm(activeThreadId!, form, answer); await openCode.snapshot(openCode.activeSessionId!); }}
        onPermissionDecision={async (request, decision) => { await openCodeSessionService.replyPermission(activeThreadId!, request, decision); await openCode.snapshot(openCode.activeSessionId!); }}
        onOpenExternal={(url) => {
          try {
            const target = new URL(url);
            if (target.protocol === 'https:' || target.protocol === 'http:') window.open(target.href, '_blank', 'noopener,noreferrer');
          } catch { /* Ignore malformed external links. */ }
        }} />}
      <div ref={bottomRef} />
    </div>
  );
}
