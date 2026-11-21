import { invoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import type { FormAnswer, PermissionDecision } from './forms';
import type { OpenCodeApi, OpenCodeEvent } from './types';

/** Typed frontend adapter. Secret, endpoint and process details stay native. */
export const openCodeClient: OpenCodeApi = {
 status: () => invoke('open_code_status'), discover: () => invoke('open_code_discover'), subscribe: () => invoke('open_code_subscribe'), unsubscribe: () => invoke('open_code_unsubscribe'),
 listModels: () => invoke('open_code_list_models'), listAgents: () => invoke('open_code_list_agents'),
 createSession: (input) => invoke('open_code_create_session', input), rebindSessions: (sessionIds) => invoke('open_code_rebind_sessions', { sessionIds }),
 getSession: (sessionId) => invoke('open_code_get_session', { sessionId }), getMessages: (sessionId) => invoke('open_code_get_messages', { sessionId }),
 prompt: (sessionId, admissionId, text) => invoke('open_code_prompt', { sessionId, admissionId, text }), interrupt: (sessionId) => invoke('open_code_interrupt', { sessionId }),
 switchModel: (sessionId, model) => invoke('open_code_switch_model', { sessionId, model }), switchAgent: (sessionId, agent) => invoke('open_code_switch_agent', { sessionId, agent }),
 listForms: (sessionId) => invoke('open_code_list_forms', { sessionId }), replyForm: (sessionId, formId, answer: FormAnswer) => invoke('open_code_reply_form', { sessionId, formId, answer }),
 listPermissions: (sessionId) => invoke('open_code_list_permissions', { sessionId }), replyPermission: (sessionId, requestId, decision: PermissionDecision, message) => invoke('open_code_reply_permission', { sessionId, requestId, decision, message }),
 deleteSession: (sessionId) => invoke('open_code_delete_session', { sessionId }),
 listen: async (handler) => tauriListen<OpenCodeEvent>('open_code://event', ({ payload }) => handler(payload)),
};
