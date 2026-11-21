/** Neutral adapter over the existing revision/proposal/receipt pipeline. */
import { db } from '../db';
import { crmFormsDb } from '../../data/crmFormsDb';
import { executeBusinessProposal, isReadTool, prepareBusinessProposal, readBusinessTool,
  receiptText, recordBusinessFailure, toolsForScope, verifyBusinessProposal } from '../codex/businessTools';
import type { CodexRunRecord, CodexScope } from '../codex/sessionTypes';
import type { CodexPendingRequest } from '../codex/types';

export interface ToolContext {
  sessionId: string;
  appThreadId: string;
  admissionId: string;
  scope: CodexScope;
  modelId?: string;
}

export interface ToolCall {
  requestId: string;
  appThreadId: string;
  sessionId: string;
  admissionId: string;
  messageId: string;
  callId: string;
  toolName: string;
  input: Record<string, unknown>;
  stage: 'prepare' | 'execute';
}

const locks = new Map<string, { fingerprint: string; work: Promise<{ text?: string; summary?: string }> }>();

export function toolOperationId(call: Pick<ToolCall, 'sessionId' | 'messageId' | 'callId'>): string {
  // Preserve the recovery namespace. Its run component is OpenCode-specific.
  return `codex:opencode:${call.sessionId}:${call.messageId}:${call.callId}`;
}

function assertBinding(context: ToolContext, call: ToolCall, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (context.sessionId !== call.sessionId || context.admissionId !== call.admissionId
    || context.appThreadId !== call.appThreadId || context.scope.appThreadId !== context.appThreadId
    || !toolsForScope(context.scope).some(tool => tool.name === call.toolName)
    || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)
    || JSON.stringify(call.input).length > 32 * 1024) throw new Error('Tool is outside its captured TABS turn');
}

export async function executeToolCall(context: ToolContext, call: ToolCall,
  signal: AbortSignal, validate: () => Promise<void> = async () => {}): Promise<{ text?: string; summary?: string }> {
  assertBinding(context, call, signal);
  const key = `${toolOperationId(call)}:${call.stage}`;
  const fingerprint = JSON.stringify([call.appThreadId, call.admissionId, call.toolName, call.input]);
  const existing = locks.get(key);
  if (existing) return existing.fingerprint === fingerprint ? existing.work
    : Promise.reject(new Error('Tool call ID was reused with changed arguments'));
  const work = perform(context, call, signal, validate);
  locks.set(key, { fingerprint, work });
  void work.finally(() => locks.delete(key)).catch(() => {});
  return work;
}

async function perform(context: ToolContext, call: ToolCall, signal: AbortSignal,
  validate: () => Promise<void>): Promise<{ text?: string; summary?: string }> {
  const runId = `opencode:${call.sessionId}:${call.messageId}`;
  // One admitted user turn can produce multiple assistant-message runs.
  const run: CodexRunRecord = { runId, clientCommandId: runId,
    appThreadId: context.appThreadId, nativeThreadId: context.sessionId, nativeTurnId: call.messageId,
    status: 'running', scope: context.scope, userText: '', submittedText: '',
    createdAt: context.scope.capturedAt, updatedAt: Date.now() };
  const request: CodexPendingRequest = { requestId: toolOperationId(call), kind: 'businessTool',
    threadId: context.sessionId, turnId: call.messageId, callId: call.callId,
    toolName: call.toolName, details: { arguments: call.input } };
  if (isReadTool(call.toolName)) {
    if (call.stage === 'prepare') return { summary: call.toolName };
    await validate(); signal.throwIfAborted();
    const text = await readBusinessTool(run, request);
    signal.throwIfAborted();
    return { text };
  }
  const pending = await db.codexPendingRequests.get(request.requestId);
  if (call.stage === 'prepare') {
    const proposal = pending?.proposal ?? await prepareBusinessProposal(run, request);
    await verifyBusinessProposal(run, request, proposal);
    signal.throwIfAborted();
    await db.transaction('rw', db.codexRuns, db.codexPendingRequests, async () => {
      await db.codexRuns.put(run);
      await db.codexPendingRequests.put({ requestId: request.requestId, runId, epoch: 0, request,
        proposal, status: 'pending', createdAt: proposal.createdAt, updatedAt: Date.now() });
    });
    return { summary: proposal.summary };
  }
  if (!pending?.proposal || pending.runId !== runId) throw new Error('Tool preview is unavailable');
  const proposal = pending.proposal;
  await verifyBusinessProposal(run, request, proposal);
  const old = await db.codexOperationReceipts.get(proposal.operationId)
    ?? await crmFormsDb.codexOperationReceipts.get(proposal.operationId);
  if (old && old.proposalHash !== proposal.proposalHash) throw new Error('Tool call arguments changed');
  if (old && old.projection !== 'pending' && old.projection !== 'failed') {
    return { text: receiptText(old) };
  }
  await validate(); signal.throwIfAborted();
  let receipt;
  try { receipt = await executeBusinessProposal(run, proposal); }
  catch (error) { receipt = await recordBusinessFailure(run, proposal, error); }
  await db.codexPendingRequests.update(request.requestId, { status: 'answered',
    decision: 'approved', decisionAt: Date.now(), updatedAt: Date.now() });
  signal.throwIfAborted();
  return { text: receiptText(receipt) };
}
