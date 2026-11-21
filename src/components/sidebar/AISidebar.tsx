import type { Editor } from '@tiptap/react';
import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChatThread } from './ChatThread';
import { ChatInput } from './ChatInput';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useChatStore } from '../../stores/chatStore';
import type { ChatMessage } from '../../types';
import './aiSidebar.css';
import { useOpenCodeStore } from '../../stores/openCodeStore';
import type { MemoryChatContext } from '../../services/memoryNotes/chatContext';

interface AISidebarProps {
  workspaceId: string | null;
  taskId?: string | null;
  /** Identifier for the Settings sub-tab this sidebar is mounted under. */
  settingsTab?: string | null;
  /** Override the chat context mode. Defaults from taskId when omitted. */
  mode?: 'writer' | 'task';
  editor: Editor | null;
  /** Undefined outside Memory; null when its collection has no open item. */
  memoryContext?: MemoryChatContext | null;
}

export function AISidebar({ workspaceId, taskId, settingsTab, mode: modeOverride, editor, memoryContext }: AISidebarProps) {
  const { t } = useTranslation();
  const {
    activeThreadId,
    threads,
    currentContext,
    contextLoading,
    setActiveContext,
    getActiveThreadMessages,
  } = useChatStore();
  const [confirmClear, setConfirmClear] = useState(false);
  const [replyToMessage, setReplyToMessage] = useState<ChatMessage | null>(null);
  const openCodeMessageCount = useOpenCodeStore((state) => state.runsByThread[activeThreadId ?? '']?.messages.length ?? 0);

  const isSettingsMode = Boolean(settingsTab);
  const isTaskMode = modeOverride === 'task' || (modeOverride !== 'writer' && Boolean(taskId));
  const mode = isTaskMode ? 'task' : 'writer';
  const hasContext = Boolean(workspaceId || taskId || settingsTab || memoryContext);
  const memoryReady = memoryContext
    ? currentContext?.memoryId === memoryContext.id && !contextLoading
    : !currentContext?.memoryId;

  // Auto-swap on context change: when workspaceId/taskId/settingsTab changes,
  // load threads for that context.
  useEffect(() => {
    const context = memoryContext
      ? { memoryId: memoryContext.id }
      : taskId
      ? { taskId }
      : workspaceId
      ? { workspaceId }
      : settingsTab
      ? { settingsTab }
      : null;
    if (context) {
      setActiveContext(context);
    }
  }, [workspaceId, taskId, settingsTab, memoryContext, setActiveContext]);

  // Empty state: no active thread or thread has no messages
  const activeMessages = getActiveThreadMessages();
  const activeOrigin = threads.find((thread) => thread.id === activeThreadId)?.origin;
  const visibleMessageCount = activeOrigin === 'openCode' ? openCodeMessageCount : activeMessages.length;
  const showEmptyState = !activeThreadId || visibleMessageCount === 0;

  const contextLabel = isSettingsMode
    ? 'settings'
    : taskId?.startsWith('client:')
    ? 'client'
    : taskId?.startsWith('project:')
    ? 'project'
    : isTaskMode
    ? 'task'
    : 'document';

  return (
    <>
      {confirmClear && (
        <ConfirmDialog
          message={t('clearChat.confirmMessage')}
          confirmLabel={t('clearChat.confirmLabel')}
          onConfirm={() => {
            setConfirmClear(false);
          }}
          onCancel={() => setConfirmClear(false)}
        />
      )}

      <div id="chat-window-wrapper" className="chat-window-wrapper">
        <div id="chat-window" className="chat-window">
          {!hasContext || !memoryReady ? (
            <div id="chat-empty-state" className="panel-body empty-state chat-empty-state">
              <div className="chat-empty-state-icon">
                <Clock className="ui-icon"  />
              </div>
              <p className="chat-empty-state-title">{memoryContext && !memoryReady ? t('memoryNotes.chatLoading') : 'AI sidebar is ready'}</p>
              <p className="chat-empty-state-subtitle subtle">
                {memoryContext === null ? t('memoryNotes.chatOpenHint') : memoryContext ? '' : 'Open a document or task to start a contextual chat.'}
              </p>
            </div>
          ) : showEmptyState ? (
            <div id="chat-empty-state" className="panel-body empty-state chat-empty-state h-full">
              <div className="chat-empty-state-icon">
                <Clock className="ui-icon"  />
              </div>
              <p className="chat-empty-state-title">Start a conversation</p>
              <p className="chat-empty-state-subtitle subtle">
                {memoryContext ? t('memoryNotes.chatSendHint') : `Send a message to begin chatting about this ${contextLabel}.`}
              </p>
            </div>
          ) : (
            <ChatThread
              workspaceId={workspaceId}
              taskId={taskId}
              editor={editor}
              onReplyMessage={setReplyToMessage}
            />
          )}
        </div>
      </div>

      {hasContext && memoryReady && (
        <div className="ai-sidebar-composer panel-footer">
          <ChatInput
            key={`chat:${workspaceId ?? ''}`}
            mode={mode}
            threadId={activeThreadId ?? ''}
            workspaceId={workspaceId}
            taskId={taskId}
            settingsTab={settingsTab}
            replyToMessage={replyToMessage}
            onClearReply={() => setReplyToMessage(null)}
            editor={editor}
            memoryContext={memoryContext ?? undefined}
          />
        </div>
      )}
    </>
  );
}
