import type { Attachment } from '../../types';
import { boundedContext } from '../codex/contextBuilder';
import type { CodexScope } from '../codex/sessionTypes';
import { bindToolContext } from './toolBridge';
import { openCodeSessionService } from './sessionService';

const CONTEXT_LIMIT = 32_000;

/** Bind the captured context, then admit one stable turn. */
export async function dispatchOpenCodePrompt(input: {
  threadId: string;
  sessionId: string;
  admissionId: string;
  modelId: string;
  text: string;
  context: string;
  scope: CodexScope;
  attachments?: Attachment[];
}): Promise<void> {
  await bindToolContext({
    sessionId: input.sessionId,
    appThreadId: input.threadId,
    admissionId: input.admissionId,
    modelId: input.modelId,
    scope: { ...input.scope, context: input.context, attachments: undefined },
  });
  const prompt = boundedContext([
    input.text,
    input.context,
    ...(input.attachments ?? []).map((item) => item.name ? `[ATTACHMENT: ${item.name}]` : ''),
  ], CONTEXT_LIMIT);
  await openCodeSessionService.send(input.threadId, prompt, input.admissionId);
}
