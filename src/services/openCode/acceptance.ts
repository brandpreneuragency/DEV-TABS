import { isOpenCodeAcceptanceRuntime } from '../runtime';

export interface AcceptanceReport {
  passed: boolean;
  checks: string[];
  error?: string;
  model: string;
  sessions: string[];
}

export async function reportOpenCodeAcceptance(report: AcceptanceReport): Promise<void> {
  if (!isOpenCodeAcceptanceRuntime()) throw new Error('Isolated OpenCode acceptance runtime required');
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('acceptance_report', { report });
}
