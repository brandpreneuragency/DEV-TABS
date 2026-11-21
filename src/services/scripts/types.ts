export type ScriptRuntime = 'powershell' | 'python' | 'node' | 'bash';
export type ScriptRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type ScriptsView = 'all' | 'running' | 'history';

export interface ScriptInput {
  name: string;
  description: string;
  code: string;
  runtime: ScriptRuntime;
  /** Empty selects the native app-owned working directory. This is not a sandbox. */
  workingDirectory: string;
  confirmationRequired: boolean;
  timeoutSeconds: number;
}

export interface SavedScript extends ScriptInput {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptRun {
  id: string;
  requestId: string;
  scriptId: string;
  scriptName: string;
  scriptRevision: number;
  sourceHash: string;
  runtime: ScriptRuntime;
  workingDirectory: string;
  status: ScriptRunStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  exitCode: number | null;
  error: string | null;
  logTruncated: boolean;
}

export interface ScriptRuntimeInfo {
  id: ScriptRuntime;
  label: string;
  executable: string;
}

export interface ScriptsSnapshot {
  scripts: SavedScript[];
  /** Newest first; source snapshots and logs are fetched only on demand. */
  runs: ScriptRun[];
  runtimes: ScriptRuntimeInfo[];
  executionBlocked: string | null;
  defaultWorkingDirectory: string;
  maxConcurrent: number;
  maxLogBytes: number;
  maxTimeoutSeconds: number;
}

export interface ScriptOutput {
  run: ScriptRun;
  snapshot: SavedScript;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ScriptsClient {
  snapshot(): Promise<ScriptsSnapshot>;
  save(input: ScriptInput, id?: string, expectedRevision?: number): Promise<SavedScript>;
  duplicate(id: string): Promise<SavedScript>;
  delete(id: string, expectedRevision: number): Promise<void>;
  start(id: string, expectedRevision: number, requestId: string, confirmed: boolean): Promise<ScriptRun>;
  cancel(runId: string): Promise<ScriptRun>;
  output(runId: string): Promise<ScriptOutput>;
}

export const isActiveRun = (run: Pick<ScriptRun, 'status'>): boolean =>
  run.status === 'queued' || run.status === 'running';
