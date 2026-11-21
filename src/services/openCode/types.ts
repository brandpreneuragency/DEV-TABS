import type { FormAnswer, PermissionDecision } from './forms';

export type OpenCodeConnectionState = 'unavailable' | 'unauthorized' | 'versionMismatch' | 'incompatible' | 'connected' | 'degraded';
export interface OpenCodeStatus { state: OpenCodeConnectionState; generation: number; version: string | null; pid: number | null; workspace: string; streaming: boolean; detail: string | null }
export interface ModelRefView { id: string; providerId: string; variant: string | null }
export interface OpenCodeSession { id: string; projectId: string; title: string | null; agent: string | null; model: ModelRefView | null; outcome: string | null; directory: string; created: number; updated: number; threadId: string | null }
export interface RebindOutcome { sessionId: string; owned: boolean; reason: string | null; session: OpenCodeSession | null }
export interface OpenCodeModel { id: string; providerId: string; modelId: string; name: string; family: string | null; enabled: boolean; tools: boolean; contextLimit: number | null; outputLimit: number | null }
export interface OpenCodeAgent { id: string; name: string; mode: string; description: string | null; hidden: boolean; model: ModelRefView | null }
export interface OpenCodeError { code: string; message: string }
export interface MessageError { kind: string; message: string }
export interface ToolPart { id: string; name: string; status: string; input: string | null; output: string | null; error: MessageError | null }
export interface MessagePart { kind: string; text: string | null; tool: ToolPart | null }
export interface OpenCodeMessage { id: string; sessionId: string; kind: string; created: number; completed: number | null; agent: string | null; model: ModelRefView | null; finish: string | null; text: string | null; parts: MessagePart[]; error: MessageError | null; notice: string | null }
export interface FormFieldView { key: string; kind: string; title: string | null; description: string | null; required: boolean; hidden: boolean; options: Array<{ value: string; label: string }>; url: string | null; schema: unknown }
export interface FormSummary { id: string; sessionId: string; title: string; fields: FormFieldView[] }
export interface PermissionSummary { id: string; sessionId: string; action: string; resources: string[]; message: string | null }
export interface StreamEvent { sessionId: string; kind: string; created: number; assistantMessageId: string | null; partId: string | null; seq: number | null; delta: string | null; tool: ToolPart | null; error: MessageError | null; status: string | null }
export type OpenCodeEvent = { kind: 'stream'; event: StreamEvent } | { kind: 'lifecycle'; state: OpenCodeConnectionState; generation: number; streaming: boolean; detail: string | null };
export interface InboxAdmission { id: string; sessionId: string; created: number; delivery: string | null }
export interface OpenCodeApi {
 status(): Promise<OpenCodeStatus>; discover(): Promise<OpenCodeStatus>; subscribe(): Promise<OpenCodeStatus>; unsubscribe(): Promise<OpenCodeStatus>;
 listModels(): Promise<OpenCodeModel[]>; listAgents(): Promise<OpenCodeAgent[]>; createSession(input: {threadId:string;title?:string;model?:ModelRefView;agent?:string}): Promise<OpenCodeSession>;
 rebindSessions(sessionIds:string[]):Promise<RebindOutcome[]>; getSession(sessionId:string):Promise<OpenCodeSession>; getMessages(sessionId:string):Promise<OpenCodeMessage[]>; prompt(sessionId:string,admissionId:string,text:string):Promise<InboxAdmission>; interrupt(sessionId:string):Promise<boolean>;
 switchModel(sessionId:string,model:ModelRefView):Promise<void>; switchAgent(sessionId:string,agent:string):Promise<void>; listForms(sessionId:string):Promise<FormSummary[]>; replyForm(sessionId:string,formId:string,answer:FormAnswer):Promise<void>; listPermissions(sessionId:string):Promise<PermissionSummary[]>; replyPermission(sessionId:string,requestId:string,decision:PermissionDecision,message?:string):Promise<void>; deleteSession(sessionId:string):Promise<void>;
 listen(handler:(event:OpenCodeEvent)=>void):Promise<()=>void>;
}
