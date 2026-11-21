import { useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { estimateTokens } from '../../utils/tokens';
import type { ChatMessage } from '../../types';
import { useOpenCodeStore } from '../../stores/openCodeStore';

export interface ContextWindowStats {
  userMessages: number;
  assistantMessages: number;
  totalMessages: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  userTokens: number;
  assistantTokens: number;
  toolCallsTokens: number;
  otherTokens: number;
  hasProviderUsage: boolean;
}

export function formatContextNumber(n: number): string {
  return n.toLocaleString();
}

export function aggregateContextMessages(messages: ChatMessage[]): ContextWindowStats {
  let userTokens = 0;
  let assistantTokens = 0;
  const toolCallsTokens = 0;
  let otherTokens = 0;

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  let userMessages = 0;
  let assistantMessages = 0;
  let hasProviderUsage = false;

  for (const message of messages) {
    if (message.role === 'user') {
      userMessages += 1;
      const estimated = message.usage?.promptTokens ?? estimateTokens(message.content);
      userTokens += estimated;
      if (message.usage?.promptTokens) {
        promptTokens += message.usage.promptTokens;
      }
    } else {
      assistantMessages += 1;
      const estimated = message.usage?.completionTokens ?? estimateTokens(message.content);
      assistantTokens += estimated;
      if (message.usage) {
        if (message.usage.promptTokens) promptTokens += message.usage.promptTokens;
        if (message.usage.completionTokens) completionTokens += message.usage.completionTokens;
        if (message.usage.totalTokens) totalTokens += message.usage.totalTokens;
        if (message.usage.reasoningTokens) reasoningTokens += message.usage.reasoningTokens;
        if (message.usage.cacheReadTokens) cacheReadTokens += message.usage.cacheReadTokens;
        if (message.usage.cacheWriteTokens) cacheWriteTokens += message.usage.cacheWriteTokens;
        if (
          message.usage.promptTokens != null ||
          message.usage.completionTokens != null ||
          message.usage.totalTokens != null
        ) {
          hasProviderUsage = true;
        }
      }
    }
  }

  otherTokens = reasoningTokens + cacheReadTokens + cacheWriteTokens;

  if (!hasProviderUsage) {
    promptTokens = userTokens;
    completionTokens = assistantTokens;
  }

  const computedTotal = hasProviderUsage
    ? totalTokens || promptTokens + completionTokens + otherTokens
    : userTokens + assistantTokens + otherTokens;

  return {
    userMessages,
    assistantMessages,
    totalMessages: messages.length,
    promptTokens,
    completionTokens,
    totalTokens: computedTotal,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    userTokens,
    assistantTokens,
    toolCallsTokens,
    otherTokens,
    hasProviderUsage,
  };
}

export function useContextWindowData() {
  const { threads, activeThreadId, messagesByThread } = useChatStore();
  const openCodeModels = useOpenCodeStore((state) => state.models);
  const openCodeRun = useOpenCodeStore((state) => state.runsByThread[activeThreadId ?? '']);
  const openCodeMessages = useMemo(() => openCodeRun?.messages ?? [], [openCodeRun?.messages]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const messages = useMemo(
    () => activeThread?.origin === 'openCode' ? openCodeMessages.map((message) => ({
      id: message.id, threadId: activeThreadId ?? '', mode: activeThread.mode, agentId: message.agent ?? 'openCode',
      role: message.kind === 'user' ? 'user' as const : message.kind === 'assistant' ? 'assistant' as const : 'system' as const,
      content: message.text ?? '', timestamp: message.created,
    })) : messagesByThread[activeThreadId ?? ''] ?? [],
    [messagesByThread, activeThreadId, activeThread, openCodeMessages],
  );
  const stats = useMemo(() => aggregateContextMessages(messages), [messages]);

  const openModelId = activeThread?.origin === 'openCode' ? openCodeMessages.at(-1)?.model?.id : undefined;
  const openModel = openCodeModels.find((item) => item.modelId === openModelId || item.id === openModelId);
  const activeModel = activeThread?.origin === 'openCode'
    ? openModel ? { name: openModel.name } : openModelId ? { name: openModelId } : undefined
    : undefined;
  const provider = activeThread?.origin === 'openCode'
    ? openModel ? { name: 'OpenCode', selectedModel: openModel.name } : { name: 'OpenCode', selectedModel: openModelId ?? '' }
    : undefined;
  const contextLimit = activeThread?.origin === 'openCode' ? openModel?.contextLimit ?? null : null;
  // Message/token totals are estimates, not the server's live context occupancy.
  const usagePercent = null;

  return {
    activeModel,
    activeThread,
    contextLimit,
    provider,
    stats,
    usagePercent,
  };
}
