import { isTauriRuntime } from '../runtime';
import type { SavedScript, ScriptOutput, ScriptRun, ScriptsClient, ScriptsSnapshot } from './types';

async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauriRuntime()) throw new Error('Scripts require the TABS Windows desktop app. Browser preview cannot execute commands.');
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'The Scripts operation could not be completed.');
  }
}

/** A fixed, local-only IPC surface. No shell command, endpoint or target is selected by this adapter. */
export const scriptsClient: ScriptsClient = {
  snapshot: () => call<ScriptsSnapshot>('scripts_snapshot'),
  save: (input, id, expectedRevision) => call<SavedScript>('scripts_save', {
    input, id: id ?? null, expectedRevision: expectedRevision ?? null,
  }),
  duplicate: (id) => call<SavedScript>('scripts_duplicate', { id }),
  delete: (id, expectedRevision) => call<void>('scripts_delete', { id, expectedRevision }),
  start: (id, expectedRevision, requestId, confirmed) => call<ScriptRun>('scripts_start', {
    id, expectedRevision, requestId, confirmed,
  }),
  cancel: (runId) => call<ScriptRun>('scripts_cancel', { runId }),
  output: (runId) => call<ScriptOutput>('scripts_output', { runId }),
};
