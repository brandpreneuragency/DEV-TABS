import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScriptsStore } from './scriptsStore';
import type { SavedScript, ScriptOutput, ScriptRun, ScriptsClient, ScriptsSnapshot } from '../services/scripts/types';

const script: SavedScript = { id: 'script-a', revision: 1, name: 'Synthetic fixture', description: '',
  code: 'Write-Output "fixture"', runtime: 'powershell', workingDirectory: '', confirmationRequired: false,
  timeoutSeconds: 3600, createdAt: 1, updatedAt: 1 };
const run: ScriptRun = { id: 'run-a', requestId: 'fixture-receipt', scriptId: script.id,
  scriptName: script.name, scriptRevision: 1, sourceHash: 'synthetic-source-hash', runtime: 'powershell',
  workingDirectory: 'C:/fixture', status: 'running', createdAt: 2, startedAt: 2, completedAt: null,
  exitCode: null, error: null, logTruncated: false };
const snapshot: ScriptsSnapshot = { scripts: [script], runs: [],
  runtimes: [{ id: 'powershell', label: 'PowerShell', executable: 'C:/synthetic/powershell.exe' }],
  executionBlocked: null, defaultWorkingDirectory: 'C:/fixture', maxConcurrent: 2,
  maxLogBytes: 1048576, maxTimeoutSeconds: 86400 };
const output: ScriptOutput = { run, snapshot: script, stdout: 'fixture output', stderr: '', truncated: false };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = () => {
  const client = {
    snapshot: vi.fn<ScriptsClient['snapshot']>().mockResolvedValue(snapshot),
    save: vi.fn<ScriptsClient['save']>().mockResolvedValue({ ...script, revision: 2 }),
    duplicate: vi.fn<ScriptsClient['duplicate']>().mockResolvedValue({ ...script, id: 'script-copy' }),
    delete: vi.fn<ScriptsClient['delete']>().mockResolvedValue(undefined),
    start: vi.fn<ScriptsClient['start']>().mockResolvedValue(run),
    cancel: vi.fn<ScriptsClient['cancel']>().mockResolvedValue({ ...run, status: 'cancelled', completedAt: 3 }),
    output: vi.fn<ScriptsClient['output']>().mockResolvedValue(output),
  };
  return { client, store: createScriptsStore(client) };
};
afterEach(() => vi.useRealTimers());

describe('native-backed Scripts store', () => {
  it('coalesces a double click into one submission and never opens output automatically', async () => {
    const { client, store } = fixture();
    const pending = deferred<ScriptRun>(); client.start.mockReturnValue(pending.promise);
    const first = store.getState().run(script); const second = store.getState().run(script);
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(store.getState().pendingIds).toContain(script.id);
    expect(store.getState().runs).toEqual([]);
    pending.resolve(run);
    expect(await first).toEqual(run); expect(await second).toEqual(run);
    expect(store.getState().runs).toEqual([run]);
    expect(store.getState().selectedRunId).toBeNull();
    expect(store.getState().pendingIds).toEqual([]);
  });
  it('reuses the receipt after a lost acknowledgement instead of automatically repeating a job', async () => {
    const { client, store } = fixture();
    client.start.mockRejectedValueOnce(new Error('lost acknowledgement'));
    await expect(store.getState().run(script)).rejects.toThrow('lost acknowledgement');
    expect(store.getState().runs).toEqual([]);
    await store.getState().run(script);
    expect(client.start.mock.calls[0][2]).toBe(client.start.mock.calls[1][2]);
    expect(client.start).toHaveBeenCalledTimes(2);
  });
  it('requires explicit confirmation for the selected saved revision', async () => {
    const { client, store } = fixture();
    const sensitive = { ...script, confirmationRequired: true };
    await expect(store.getState().run(sensitive)).rejects.toThrow('Confirm');
    expect(client.start).not.toHaveBeenCalled();
    await store.getState().run(sensitive, true);
    expect(client.start).toHaveBeenCalledWith(script.id, 1, expect.any(String), true);
  });
  it('does not replace a saved revision with an older in-flight snapshot', async () => {
    const { client, store } = fixture(); await store.getState().refresh();
    const stale = deferred<ScriptsSnapshot>(); client.snapshot.mockReturnValueOnce(stale.promise);
    const refreshing = store.getState().refresh();
    await store.getState().save({ ...script, name: 'Edited' }, script.id, 1);
    stale.resolve(snapshot); await refreshing;
    expect(store.getState().scripts[0].revision).toBe(2);
  });
  it('preserves loaded scripts when storage cannot be read', async () => {
    const { client, store } = fixture(); await store.getState().refresh();
    client.snapshot.mockRejectedValue(new Error('corrupt native snapshot'));
    await store.getState().refresh();
    expect(store.getState().scripts).toEqual([script]);
    expect(store.getState().error).toContain('corrupt');
  });
  it('keeps historical runs when a saved script is deleted', async () => {
    const { client, store } = fixture(); store.setState({ scripts: [script], runs: [run] });
    await store.getState().remove(script);
    expect(client.delete).toHaveBeenCalledWith(script.id, 1);
    expect(store.getState().scripts).toEqual([]);
    expect(store.getState().runs).toEqual([run]);
  });
  it('keeps running state until cancellation is actually acknowledged, and retains failure', async () => {
    const { client, store } = fixture(); store.setState({ runs: [run] });
    const stopping = deferred<ScriptRun>(); client.cancel.mockReturnValue(stopping.promise);
    const request = store.getState().cancel(run.id);
    expect(store.getState().runs[0].status).toBe('running');
    stopping.reject(new Error('could not stop'));
    await expect(request).rejects.toThrow('could not stop');
    expect(store.getState().runs[0].status).toBe('running');
    expect(store.getState().error).toBe('could not stop');
  });
  it('ignores output from an earlier A → B → A selection', async () => {
    const { client, store } = fixture(); const old = deferred<ScriptOutput>();
    client.output.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...output, run: { ...run, id: 'run-b' } })
      .mockResolvedValueOnce({ ...output, stdout: 'new A' });
    const first = store.getState().openOutput('run-a');
    await store.getState().openOutput('run-b'); await store.getState().openOutput('run-a');
    old.resolve({ ...output, stdout: 'stale A' }); await first;
    expect(store.getState().output?.stdout).toBe('new A');
  });
  it('closing Output does not cancel the job or reopen on a delayed response', async () => {
    const { client, store } = fixture(); const delayed = deferred<ScriptOutput>();
    client.output.mockReturnValue(delayed.promise);
    const opening = store.getState().openOutput(run.id); store.getState().closeOutput();
    delayed.resolve(output); await opening;
    expect(store.getState().selectedRunId).toBeNull(); expect(store.getState().output).toBeNull();
    expect(client.cancel).not.toHaveBeenCalled();
  });
  it('polls without overlapping reads, then stops when its last view detaches', async () => {
    vi.useFakeTimers(); const { client, store } = fixture();
    const delayed = deferred<ScriptsSnapshot>(); client.snapshot.mockReturnValueOnce(delayed.promise);
    const stop = store.getState().startPolling();
    await vi.advanceTimersByTimeAsync(5000); expect(client.snapshot).toHaveBeenCalledTimes(1);
    delayed.resolve(snapshot); await vi.advanceTimersByTimeAsync(1000); expect(client.snapshot).toHaveBeenCalledTimes(2);
    stop(); stop(); await vi.advanceTimersByTimeAsync(5000); expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(client.cancel).not.toHaveBeenCalled();
  });
});
