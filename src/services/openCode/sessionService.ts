import { openCodeClient } from './desktopClient';
import { cancelToolContext } from './toolBridge';
import type { FormAnswer, FormField, FormInfo, FormNumericWire, FormOption, FormWhen, PermissionRequest } from './forms';
import type { OpenCodeMessage, OpenCodeModel, OpenCodeSession, OpenCodeStatus } from './types';
import { getBinding, getSubmission, listBindings, pendingSubmissions, saveBinding, saveSubmission, submissionsForChat, updateSubmission } from './persistence';
import type { OpenCodeChatRecord } from './schema';

function admissionId(): string { return `msg_${crypto.randomUUID().replaceAll('-', '')}`; }
export function nativeModel(model: OpenCodeModel) { return { id: model.modelId, providerId: model.providerId, variant: null }; }
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function finite(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function options(value: unknown, fallback: FormOption[]): FormOption[] {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((item) => {
    const entry = object(item);
    if (!entry || typeof entry.value !== 'string') return [];
    return [{ value: entry.value, label: string(entry.label) ?? entry.value, description: string(entry.description) }];
  });
}
function conditions(value: unknown): FormWhen[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed = value.flatMap((item) => {
    const entry = object(item);
    const expected = entry?.value;
    if (!entry || typeof entry.key !== 'string' || (entry.op !== 'eq' && entry.op !== 'neq')
      || !['string', 'number', 'boolean'].includes(typeof expected)) return [];
    return [{ key: entry.key, op: entry.op, value: expected } as FormWhen];
  });
  return parsed.length === value.length ? parsed : null;
}
export function normalizeFormField(field: Awaited<ReturnType<typeof openCodeClient.listForms>>[number]['fields'][number]): FormField {
  const schema = object(field.schema);
  const type = string(schema?.type) ?? field.kind;
  const title = string(schema?.title) ?? field.title ?? undefined;
  const description = string(schema?.description) ?? field.description ?? undefined;
  const when = conditions(schema?.when);
  const base = { key: field.key, title, description, required: typeof schema?.required === 'boolean' ? schema.required : field.required,
    hidden: typeof schema?.hidden === 'boolean' ? schema.hidden : field.hidden, ...(when ? { when } : {}) };
  if (!schema || schema.type === 'unsupported' || when === null) return { ...base, type: 'unsupported', sourceType: field.kind };
  if (type === 'external') {
    const url = string(schema.url) ?? field.url;
    return url ? { key: field.key, type, url, title, description } : { ...base, type: 'unsupported', sourceType: field.kind };
  }
  if (type === 'boolean') return { ...base, type, default: typeof schema.default === 'boolean' ? schema.default : undefined };
  if (type === 'number' || type === 'integer') {
    const wireNumeric = (value: unknown): FormNumericWire | undefined => typeof value === 'number' || value === 'Infinity' || value === '-Infinity' || value === 'NaN' ? value : undefined;
    return { ...base, type, minimum: wireNumeric(schema.minimum), maximum: wireNumeric(schema.maximum), default: wireNumeric(schema.default) };
  }
  if (type === 'multiselect') {
    const defaultValue = Array.isArray(schema.default) && schema.default.every((item) => typeof item === 'string') ? schema.default as string[] : undefined;
    return { ...base, type, options: options(schema.options, field.options), minItems: finite(schema.minItems), maxItems: finite(schema.maxItems), custom: schema.custom === true, default: defaultValue };
  }
  if (type === 'string') {
    const format = ['email', 'uri', 'date', 'date-time'].includes(String(schema.format)) ? schema.format as 'email' | 'uri' | 'date' | 'date-time' : undefined;
    return { ...base, type, format, minLength: finite(schema.minLength), maxLength: finite(schema.maxLength), pattern: string(schema.pattern), placeholder: string(schema.placeholder), default: string(schema.default), options: options(schema.options, field.options), custom: schema.custom === true };
  }
  return { ...base, type: 'unsupported', sourceType: type };
}
export function toFormInfo(form: Awaited<ReturnType<typeof openCodeClient.listForms>>[number]): FormInfo {
  return { id: form.id, sessionID: form.sessionId, title: form.title, fields: form.fields.map(normalizeFormField) };
}
export function toPermission(request: Awaited<ReturnType<typeof openCodeClient.listPermissions>>[number]): PermissionRequest {
  return { id: request.id, sessionID: request.sessionId, action: request.action, resources: request.resources, message: request.message ?? undefined };
}

export class OpenCodeSessionService {
  status(): Promise<OpenCodeStatus> { return openCodeClient.status(); }
  discover(): Promise<OpenCodeStatus> { return openCodeClient.discover(); }
  models(): Promise<OpenCodeModel[]> { return openCodeClient.listModels(); }
  agents() { return openCodeClient.listAgents(); }
  async reconcileBindings(): Promise<void> {
    const rows = await listBindings();
    for (let start = 0; start < rows.length; start += 50) {
      const slice = rows.slice(start, start + 50);
      const outcomes = await openCodeClient.rebindSessions(slice.map((row) => row.sessionID));
      for (const row of slice) {
        const outcome = outcomes.find((item) => item.sessionId === row.sessionID);
        if (!outcome?.owned || !outcome.session || outcome.session.threadId !== row.id
          || outcome.session.projectId !== row.projectID || outcome.session.directory !== row.directory) {
          // Keep the mapping and pending receipts. Do not silently create a replacement session.
          throw new Error(outcome?.reason ?? `OpenCode could not verify TABS chat ${row.id}.`);
        }
      }
    }
  }
  async ensureSession(input: { threadId:string; title:string; projectID:string; directory:string; ownershipMarker:string; mode:'writer'|'task'; workspaceId?:string; taskId?:string; settingsTab?:string }): Promise<OpenCodeSession> {
    const current = await getBinding(input.threadId);
    if (current) return openCodeClient.getSession(current.sessionID);
    const session = await openCodeClient.createSession({ threadId: input.threadId, title: input.title });
    const row: OpenCodeChatRecord = { id: input.threadId, sessionID: session.id, projectID: session.projectId, directory: session.directory, ownershipMarker: input.ownershipMarker, mode: input.mode, workspaceId: input.workspaceId, taskId: input.taskId, settingsTab: input.settingsTab, title: input.title, createdAt: Date.now(), updatedAt: Date.now() };
    await saveBinding(row);
    return session;
  }
  async messages(threadId: string): Promise<OpenCodeMessage[]> { const binding = await getBinding(threadId); if (!binding) return []; return openCodeClient.getMessages(binding.sessionID); }
  async pending(threadId: string) { const binding = await getBinding(threadId); if (!binding) return { forms: [], permissions: [] }; const [forms, permissions] = await Promise.all([openCodeClient.listForms(binding.sessionID), openCodeClient.listPermissions(binding.sessionID)]); return { forms: forms.map(toFormInfo), permissions: permissions.map(toPermission) }; }
  async send(threadId: string, text: string, stableAdmissionId = admissionId()): Promise<string> {
    const binding = await getBinding(threadId); if (!binding) throw new Error('OpenCode session is not bound to this TABS chat.');
    await this.reconcile(threadId);
    const pending = await pendingSubmissions(threadId);
    if (pending.length) throw new Error('A previous prompt has an unknown admission state. Reconcile the session before sending again.');
    const id = stableAdmissionId;
    await saveSubmission({ id, chatId: threadId, sessionID: binding.sessionID, status: 'pending', createdAt: Date.now(), attempts: 1, request: { text, delivery: 'queue' } });
    try { await openCodeClient.prompt(binding.sessionID, id, text); await updateSubmission(id, { status: 'accepted', acceptedAt: Date.now(), request: undefined }); }
    catch (error) { await updateSubmission(id, { status: 'ambiguous', error: error instanceof Error ? error.message : 'Prompt admission is unknown.' }); throw error; }
    return id;
  }
  async reconcile(threadId: string): Promise<OpenCodeMessage[]> {
    const binding = await getBinding(threadId); if (!binding) return [];
    const [messages, session] = await Promise.all([openCodeClient.getMessages(binding.sessionID), openCodeClient.getSession(binding.sessionID)]);
    if (session.threadId !== threadId || session.projectId !== binding.projectID || session.directory !== binding.directory) throw new Error('OpenCode session ownership changed; chat was not rebound.');
    const rows = await pendingSubmissions(threadId);
    for (const row of rows) {
      const admitted = messages.some((message) => message.id === row.id);
      if (admitted) await updateSubmission(row.id, { status: 'accepted', acceptedAt: Date.now(), request: undefined });
      // A successful transcript read can still lag admission; retain as ambiguous, never resend automatically.
      else if (row.status === 'pending') await updateSubmission(row.id, { status: 'ambiguous' });
    }
    return messages;
  }
  async submissions(threadId: string) { return pendingSubmissions(threadId); }
  async retrySubmission(threadId: string, id: string): Promise<void> {
    await this.reconcile(threadId);
    const row = await getSubmission(id);
    if (!row || row.chatId !== threadId || row.status === 'accepted') return;
    if (!row.request || row.request.delivery !== 'queue') throw new Error('This submission has no safe retry payload.');
    await updateSubmission(id, { status: 'pending', attempts: row.attempts + 1, error: undefined });
    try {
      await openCodeClient.prompt(row.sessionID, id, row.request.text);
      await updateSubmission(id, { status: 'accepted', acceptedAt: Date.now(), request: undefined, error: undefined });
    } catch (error) {
      await updateSubmission(id, { status: 'ambiguous', error: error instanceof Error ? error.message : 'Prompt admission is unknown.' });
      throw error;
    }
  }
  async replyForm(threadId:string, form:FormInfo, answer:FormAnswer) { const binding = await getBinding(threadId); if (!binding) throw new Error('No mapped OpenCode session.'); await openCodeClient.replyForm(binding.sessionID, form.id, answer); }
  async replyPermission(threadId:string, request:PermissionRequest, decision:'once'|'always'|'reject') { const binding = await getBinding(threadId); if (!binding) throw new Error('No mapped OpenCode session.'); await openCodeClient.replyPermission(binding.sessionID, request.id, decision); }
  async stop(threadId:string) {
    const binding = await getBinding(threadId);
    if (!binding) return false;
    // Abort renderer-side tool work before asking the native host to interrupt.
    cancelToolContext(binding.sessionID);
    return openCodeClient.interrupt(binding.sessionID);
  }
  async assertLocalChatDeletionAllowed(threadId:string) {
    const binding = await getBinding(threadId);
    if (!binding) {
      if ((await submissionsForChat(threadId)).length) throw new Error('This chat has OpenCode submission receipts but no verified session mapping. Keep the chat until recovery.');
      return;
    }
    const pending = await pendingSubmissions(threadId);
    if (pending.length) throw new Error('Resolve the pending OpenCode submission before deleting this chat.');
  }
  async setModel(threadId:string, model:{id:string;providerId:string;variant?:string|null}) { const binding = await getBinding(threadId); if (!binding) return; await openCodeClient.switchModel(binding.sessionID, { ...model, variant: model.variant ?? null }); }
  async setAgent(threadId:string, agent:string) { const binding = await getBinding(threadId); if (!binding) return; await openCodeClient.switchAgent(binding.sessionID, agent); }
}
export const openCodeSessionService = new OpenCodeSessionService();
