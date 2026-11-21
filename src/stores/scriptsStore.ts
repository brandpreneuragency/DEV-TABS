import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { scriptsClient } from '../services/scripts/desktopClient';
import { isActiveRun, type SavedScript, type ScriptInput, type ScriptOutput, type ScriptRun,
  type ScriptsClient, type ScriptsSnapshot, type ScriptsView } from '../services/scripts/types';

export interface ScriptsState extends ScriptsSnapshot {
  view: ScriptsView;
  loading: boolean;
  error: string | null;
  pendingIds: string[];
  selectedRunId: string | null;
  output: ScriptOutput | null;
  outputLoading: boolean;
  setView(view: ScriptsView): void;
  refresh(): Promise<void>;
  save(input: ScriptInput, id?: string, expectedRevision?: number): Promise<SavedScript>;
  duplicate(id: string): Promise<SavedScript>;
  remove(script: SavedScript): Promise<void>;
  run(script: SavedScript, confirmed?: boolean): Promise<ScriptRun>;
  cancel(runId: string): Promise<void>;
  openOutput(runId: string): Promise<void>;
  closeOutput(): void;
  clearError(): void;
  startPolling(): () => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message
  : typeof error === 'string' ? error : 'The Scripts operation could not be completed.';
const newestRuns = (runs: ScriptRun[]): ScriptRun[] => [...runs].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

/** Native owns durable data and processes. This store never invents a completed/cancelled status. */
export function createScriptsStore(client: ScriptsClient = scriptsClient) {
  let generation = 0;
  let selection = 0;
  let refreshFlight: Promise<void> | null = null;
  let outputFlight: { id: string; selection: number; promise: Promise<void> } | null = null;
  const starts = new Map<string, Promise<ScriptRun>>();
  // Keep the same receipt on an ambiguous IPC failure; retry must not repeat a completed job.
  const requestIds = new Map<string, string>();
  let pollUsers = 0;
  let pollEpoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readError: string | null = null;
  let loaded = false;

  return create<ScriptsState>((set, get) => {
    const mergeRun = (run: ScriptRun) => set(state => ({
      runs: newestRuns([run, ...state.runs.filter(row => row.id !== run.id)]),
    }));
    const mergeScript = (script: SavedScript) => set(state => ({
      scripts: [script, ...state.scripts.filter(row => row.id !== script.id)],
    }));
    const pending = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
      if (get().pendingIds.includes(id)) throw new Error('An operation for this script is already in progress.');
      generation += 1;
      set(state => ({ pendingIds: [...state.pendingIds, id], error: null }));
      try {
        const value = await action();
        generation += 1;
        return value;
      } catch (error) {
        generation += 1;
        set({ error: message(error) });
        throw error;
      } finally {
        set(state => ({ pendingIds: state.pendingIds.filter(key => key !== id) }));
      }
    };
    const readOutput = (id: string): Promise<void> => {
      const selectedAt = selection;
      if (outputFlight?.id === id && outputFlight.selection === selectedAt) return outputFlight.promise;
      const version = generation;
      const promise = (async () => {
        try {
          const output = await client.output(id);
          if (selection !== selectedAt || get().selectedRunId !== id || generation !== version) return;
          set({ output });
          mergeRun(output.run);
        } catch (error) {
          if (selection === selectedAt && get().selectedRunId === id) set({ error: message(error) });
        } finally {
          if (selection === selectedAt && get().selectedRunId === id) set({ outputLoading: false });
          if (outputFlight?.selection === selectedAt) outputFlight = null;
        }
      })();
      outputFlight = { id, selection: selectedAt, promise };
      return promise;
    };
    return {
      scripts: [], runs: [], runtimes: [], executionBlocked: null, defaultWorkingDirectory: '',
      maxConcurrent: 2, maxLogBytes: 1024 * 1024, maxTimeoutSeconds: 86400,
      view: 'all', loading: false, error: null, pendingIds: [], selectedRunId: null, output: null, outputLoading: false,
      setView: view => set({ view }),
      clearError: () => set({ error: null }),
      refresh: () => {
        if (refreshFlight) return refreshFlight;
        const version = generation;
        if (!loaded) set({ loading: true });
        refreshFlight = (async () => {
          try {
            const snapshot = await client.snapshot();
            if (version !== generation) return;
            set({ ...snapshot, runs: newestRuns(snapshot.runs), ...(get().error === readError ? { error: null } : {}) });
            readError = null;
            loaded = true;
            const selectedId = get().selectedRunId;
            const run = snapshot.runs.find(row => row.id === selectedId);
            if (selectedId && (!get().output || (run && (isActiveRun(run) || get().output?.run.status !== run.status)))) {
              await readOutput(selectedId);
            }
          } catch (error) {
            if (version === generation) {
              readError = message(error);
              set({ error: readError });
            }
          } finally {
            set({ loading: false });
            refreshFlight = null;
          }
        })();
        return refreshFlight;
      },
      save: async (input, id, expectedRevision) => {
        const script = await pending(id ?? '__new__', () => client.save(input, id, expectedRevision));
        mergeScript(script);
        return script;
      },
      duplicate: async id => {
        const script = await pending(id, () => client.duplicate(id));
        mergeScript(script);
        return script;
      },
      remove: async script => {
        await pending(script.id, () => client.delete(script.id, script.revision));
        set(state => ({ scripts: state.scripts.filter(row => row.id !== script.id) }));
      },
      run: (script, confirmed = false) => {
        const existing = starts.get(script.id);
        if (existing) return existing;
        if (script.confirmationRequired && !confirmed) return Promise.reject(new Error('Confirm this script before running it.'));
        const active = get().runs.find(row => row.scriptId === script.id && isActiveRun(row));
        if (active) return Promise.resolve(active);
        const key = `${script.id}:${script.revision}`;
        const requestId = requestIds.get(key) ?? nanoid(32);
        requestIds.set(key, requestId);
        const promise = pending(script.id, () => client.start(script.id, script.revision, requestId, confirmed))
          .then(run => { mergeRun(run); requestIds.delete(key); return run; })
          .finally(() => { starts.delete(script.id); });
        starts.set(script.id, promise);
        return promise;
      },
      cancel: async runId => {
        const run = await pending(runId, () => client.cancel(runId));
        mergeRun(run);
        if (get().selectedRunId === runId) await readOutput(runId);
      },
      openOutput: async runId => {
        selection += 1;
        set({ selectedRunId: runId, output: null, outputLoading: true, error: null });
        await readOutput(runId);
      },
      closeOutput: () => {
        selection += 1;
        set({ selectedRunId: null, output: null, outputLoading: false });
      },
      startPolling: () => {
        pollUsers += 1;
        if (pollUsers === 1) {
          const epoch = ++pollEpoch;
          const tick = async () => {
            await get().refresh();
            if (pollUsers > 0 && pollEpoch === epoch) timer = setTimeout(() => { void tick(); }, 1000);
          };
          void tick();
        }
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          pollUsers -= 1;
          if (pollUsers === 0) { pollEpoch += 1; clearTimeout(timer); }
        };
      },
    };
  });
}

export const useScriptsStore = createScriptsStore();
