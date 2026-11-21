/** TABS bindings only. OpenCode remains the authority for the transcript. */
export interface OpenCodeChatRecord {
  id: string;
  sessionID: string;
  projectID: string;
  directory: string;
  /** Must match the durable marker verified by the native host. */
  ownershipMarker: string;
  mode: 'writer' | 'task';
  workspaceId?: string;
  taskId?: string;
  settingsTab?: string;
  memoryId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** Stable admission IDs survive uncertain HTTP outcomes and application reloads. */
export interface OpenCodeSubmissionRecord {
  id: string;
  chatId: string;
  sessionID: string;
  status: 'pending' | 'ambiguous' | 'accepted' | 'failed';
  createdAt: number;
  attempts: number;
  acceptedAt?: number;
  /** Retain only until admission is confirmed; never store credentials here. */
  request?: {
    text: string;
    files?: Array<{ uri: string; name?: string; description?: string }>;
    delivery: 'steer' | 'queue';
  };
  error?: string;
}

export const OPEN_CODE_STORES = {
  openCodeChats: 'id, &sessionID, workspaceId, taskId, settingsTab, updatedAt',
  openCodeSubmissions: 'id, chatId, sessionID, status, createdAt',
} as const;
