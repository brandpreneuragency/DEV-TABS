import { Clock, Plus, X } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { ContextWindowPanel, ContextWindowSummaryTooltip, ContextWindowRing } from '../contextWindow';
import { db } from '../../services/db';
import type { ChatThreadMeta } from '../../types';

interface RightPanelSubheaderProps {
  /**
   * Optional override for the chat mode. When `undefined`, the subheader
   * derives the mode from the global UI store (task mode -> 'task',
   * otherwise 'writer'). Settings sub-tabs should pass `mode: 'writer'`.
   */
  mode?: 'writer' | 'task';
  /** Optional override for the workspace context (when not in task mode). */
  workspaceId?: string | null;
  /** Optional override for the task context (task mode). */
  taskId?: string | null;
  /** Optional Settings sub-tab id — when set, threads are scoped per tab. */
  settingsTab?: string | null;
  /** Undefined outside Memory; null if no Memory item is open. */
  memoryId?: string | null;
}

/**
 * Assistant chat chrome: context window + history + new chat.
 * Shell swap lives in the global Header (not here).
 */
export function RightPanelSubheader({
  mode: modeOverride,
  workspaceId: workspaceIdOverride,
  taskId: taskIdOverride,
  settingsTab,
  memoryId,
}: RightPanelSubheaderProps = {}) {
  const { threads, newChat, selectThread, deleteThread, activeThreadId, currentContext, contextLoading } = useChatStore();
  const {
    taskMode,
    activeTaskId,
    contextWindowOpen,
    setContextWindowOpen,
  } = useUIStore();
  const { activeWorkspaceId } = useWorkspaceStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [legacyThreads, setLegacyThreads] = useState<ChatThreadMeta[]>([]);
  const [contextSummaryOpen, setContextSummaryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const contextWindowRef = useRef<HTMLDivElement>(null);

  // Resolve the active chat context. Props take precedence so this
  // subheader can be mounted under a Settings sub-tab without the global
  // uiStore knowing about the settings context.
  const mode: 'writer' | 'task' = modeOverride ?? (taskMode ? 'task' : 'writer');
  const contextDocId = taskIdOverride
    ? null
    : workspaceIdOverride !== undefined
    ? workspaceIdOverride
    : taskMode
    ? null
    : activeWorkspaceId;
  const contextTaskId = taskIdOverride !== undefined
    ? taskIdOverride
    : taskMode
    ? activeTaskId
    : null;
  const memoryMode = memoryId !== undefined;
  const memoryReady = memoryMode
    ? Boolean(memoryId && currentContext?.memoryId === memoryId && !contextLoading)
    : !currentContext?.memoryId;
  const visibleThreads = memoryMode ? (memoryReady ? threads.filter((thread) => thread.memoryId === memoryId) : []) : threads;

  useEffect(() => {
    if (!historyOpen || memoryMode) return;
    let cancelled = false;
    void db.chatThreads.where('origin').equals('legacy_api').reverse().toArray()
      .then((rows) => { if (!cancelled) setLegacyThreads(rows); });
    return () => { cancelled = true; };
  }, [historyOpen, memoryMode]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
      if (contextWindowRef.current && !contextWindowRef.current.contains(e.target as Node)) {
        setContextSummaryOpen(false);
        setContextWindowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [setContextWindowOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHistoryOpen(false);
        setContextSummaryOpen(false);
        setContextWindowOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setContextWindowOpen]);

  const handleNewChat = async () => {
    if (!memoryReady) return;
    await newChat({
      mode,
      workspaceId: contextDocId || undefined,
      taskId: contextTaskId || undefined,
      settingsTab: settingsTab || undefined,
      memoryId: memoryId || undefined,
    });
    setHistoryOpen(false);
  };

  const handleSelectThread = async (threadId: string) => {
    if (memoryMode && !visibleThreads.some((thread) => thread.id === threadId)) return;
    await selectThread(threadId);
    setHistoryOpen(false);
  };

  const toggleContextWindow = () => {
    setHistoryOpen(false);
    setContextSummaryOpen(false);
    setContextWindowOpen(!contextWindowOpen);
  };

  return (
    <div id="right-panel-subheader" className="right-panel-subheader">
      <div className="editor-topbar-col justify-start">
        <div
          ref={contextWindowRef}
          className="context-window-trigger"
          data-align="left"
          onMouseEnter={() => {
            if (!contextWindowOpen) {
              setContextSummaryOpen(true);
            }
          }}
          onMouseLeave={() => setContextSummaryOpen(false)}
        >
          <button
            type="button"
            className={"ui-icon-button " + (`tbar-btn ${contextWindowOpen ? 'tbar-btn--on' : ''}`)}
            onClick={toggleContextWindow}
            title="Context window"
            aria-label="Context window"
            aria-haspopup="dialog"
            aria-expanded={contextWindowOpen ? 'true' : 'false'}
            disabled={!memoryReady}
          >
            <ContextWindowRing size={18} />
          </button>
          {memoryReady && contextSummaryOpen && !contextWindowOpen && <ContextWindowSummaryTooltip />}
          {memoryReady && contextWindowOpen && (
            <div className="context-window-dropdown" role="dialog" aria-label="Context window">
              <ContextWindowPanel />
            </div>
          )}
        </div>
      </div>
      <div className="editor-topbar-col justify-end">
        <div
          ref={historyRef}
          className="right-panel-subheader-actions"
          data-align="right"
        >
          <button
            type="button"
            className="ui-icon-button tbar-btn"
            onClick={() => {
              setContextSummaryOpen(false);
              setContextWindowOpen(false);
              setHistoryOpen((v) => !v);
            }}
            title="Chat history"
            disabled={!memoryReady}
          >
            <Clock className="ui-icon"  />
          </button>
          <button
            type="button"
            className="ui-icon-button tbar-btn"
            onClick={handleNewChat}
            title="New chat"
            disabled={!memoryReady}
          >
            <Plus className="ui-icon"  />
          </button>
          {historyOpen && memoryReady && (
            <div className="chat-history-dropdown">
              {historyError && <p className="open-code-request-error" role="alert">{historyError}</p>}
              {visibleThreads.length === 0 && (memoryMode || legacyThreads.length === 0) && (
                <div className="chat-history-empty subtle">No chats yet</div>
              )}
              {visibleThreads.map((thread) => (
                <div
                  key={thread.id}
                  className={`chat-history-item ${thread.id === activeThreadId ? 'active' : ''}`}
                  onClick={() => handleSelectThread(thread.id)}
                >
                  <span className="trunc">{thread.title}</span>
                  <button
                    type="button"
                    className="ui-icon-button chat-history-delete"
                    title="Delete chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHistoryError('');
                      void deleteThread(thread.id).catch((cause: unknown) => setHistoryError(cause instanceof Error ? cause.message : 'Could not delete this chat.'));
                    }}
                  >
                    <X className="ui-icon"  />
                  </button>
                </div>
              ))}
              {!memoryMode && legacyThreads.some((thread) => !threads.some((current) => current.id === thread.id)) && (
                <div className="chat-history-empty subtle">{t('openCode.legacyHistory')}</div>
              )}
              {!memoryMode && legacyThreads.filter((thread) => !threads.some((current) => current.id === thread.id))
                .map((thread) => (
                  <button type="button" key={thread.id}
                    className={`chat-history-item ${thread.id === activeThreadId ? 'active' : ''}`}
                    onClick={() => void handleSelectThread(thread.id)}>
                    <span className="trunc">{thread.title}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
