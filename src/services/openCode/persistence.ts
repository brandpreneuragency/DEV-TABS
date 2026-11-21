import { db } from '../db';
import type { OpenCodeChatRecord, OpenCodeSubmissionRecord } from './schema';

export async function getBinding(threadId: string): Promise<OpenCodeChatRecord | undefined> { return db.openCodeChats.get(threadId); }
export async function saveBinding(binding: OpenCodeChatRecord): Promise<void> { await db.openCodeChats.put(binding); }
export async function saveSubmission(row: OpenCodeSubmissionRecord): Promise<void> { await db.openCodeSubmissions.put(row); }
export async function updateSubmission(id: string, patch: Partial<OpenCodeSubmissionRecord>): Promise<void> { await db.openCodeSubmissions.update(id, patch); }
export async function pendingSubmissions(chatId: string): Promise<OpenCodeSubmissionRecord[]> {
  return db.openCodeSubmissions.where('chatId').equals(chatId).filter((row) => row.status === 'pending' || row.status === 'ambiguous').toArray();
}
export async function getSubmission(id: string): Promise<OpenCodeSubmissionRecord | undefined> { return db.openCodeSubmissions.get(id); }
export async function submissionsForChat(chatId: string): Promise<OpenCodeSubmissionRecord[]> {
  return db.openCodeSubmissions.where('chatId').equals(chatId).toArray();
}
export async function listBindings(): Promise<OpenCodeChatRecord[]> { return db.openCodeChats.toArray(); }
