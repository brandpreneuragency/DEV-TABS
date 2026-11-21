import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Play, Plus, RefreshCw, Search, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useScriptsStore } from '../../stores/scriptsStore';
import { useUIStore } from '../../stores/uiStore';
import { isTauriRuntime } from '../../services/runtime';
import { isActiveRun, type SavedScript, type ScriptInput, type ScriptRun } from '../../services/scripts/types';
import { ScriptsPanel } from './ScriptsPanel';
import { PrimaryWorkspaceContent } from '../layout/workspace/PrimaryWorkspaceContent';
import './scripts.css';

type Draft = { input: ScriptInput; original: ScriptInput; id?: string; revision?: number };
type Confirmation = { kind: 'run' | 'delete'; script: SavedScript };
type PanelTarget = { kind: 'editor'; script?: SavedScript } | { kind: 'output'; id: string } | { kind: 'close' };
const inputFrom = (script: ScriptInput): ScriptInput => ({ name: script.name, description: script.description, code: script.code,
  runtime: script.runtime, workingDirectory: script.workingDirectory, confirmationRequired: script.confirmationRequired,
  timeoutSeconds: script.timeoutSeconds });
const browserDemoScript: SavedScript = { id: 'browser-demo-script', revision: 1, name: 'Example: Hello world',
  description: 'A preview script to explore the Scripts layout.', code: 'Write-Output "Hello from TABS Scripts"',
  runtime: 'powershell', workingDirectory: '', confirmationRequired: false, timeoutSeconds: 60, createdAt: 0, updatedAt: 0 };
const browserPreviewRuntimes = [
  { id: 'powershell', label: 'PowerShell', executable: '' },
  { id: 'python', label: 'Python', executable: '' },
  { id: 'node', label: 'Node.js', executable: '' },
  { id: 'bash', label: 'Bash', executable: '' },
] as const;

function ScriptActions({ script, disabled, onEdit, onDuplicate, onDelete }: {
  script: SavedScript; disabled: boolean; onEdit: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('.scripts-menu button')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="scripts-actions-menu" ref={ref} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button type="button" ref={trigger} className="ui-icon-button scripts-button" disabled={disabled}
      aria-label={t('scripts.more', { name: script.name })} aria-expanded={open} onClick={() => setOpen(!open)}><MoreHorizontal /></button>
    {open && <div className="scripts-menu">
      {([['edit', onEdit], ['duplicate', onDuplicate], ['delete', onDelete]] as const).map(([key, action]) =>
        <button key={key} type="button" className={`ui-button scripts-button${key === 'delete' ? ' scripts-danger' : ''}`}
          onClick={() => { setOpen(false); trigger.current?.focus(); action(); }}>{t(`scripts.${key}`)}</button>)}
    </div>}
  </div>;
}

export function ScriptsPage({ active = true }: { active?: boolean }) {
  const { t, i18n } = useTranslation();
  const view = useScriptsStore((state) => state.view);
  const contextPanelWidth = useUIStore((state) => state.contextPanelWidth);
  const scripts = useScriptsStore((state) => state.scripts);
  const runs = useScriptsStore((state) => state.runs);
  const runtimes = useScriptsStore((state) => state.runtimes);
  const executionBlocked = useScriptsStore((state) => state.executionBlocked);
  const browserPreview = !isTauriRuntime();
  const selectableRuntimes = browserPreview && (!runtimes.length || executionBlocked) ? browserPreviewRuntimes : runtimes;
  const defaultDirectory = useScriptsStore((state) => state.defaultWorkingDirectory);
  const maxConcurrent = useScriptsStore((state) => state.maxConcurrent);
  const maxLogBytes = useScriptsStore((state) => state.maxLogBytes);
  const maxTimeout = useScriptsStore((state) => state.maxTimeoutSeconds);
  const loading = useScriptsStore((state) => state.loading);
  const error = useScriptsStore((state) => state.error);
  const pendingIds = useScriptsStore((state) => state.pendingIds);
  const output = useScriptsStore((state) => state.output);
  const outputLoading = useScriptsStore((state) => state.outputLoading);
  const selectedRunId = useScriptsStore((state) => state.selectedRunId);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const [discard, setDiscard] = useState<PanelTarget | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const busyRef = useRef(new Set<string>());
  const [stopping, setStopping] = useState<string[]>([]);
  const dirty = !!draft && JSON.stringify(draft.input) !== JSON.stringify(draft.original);
  useEffect(() => {
    if (!active) return;
    return useScriptsStore.getState().startPolling();
  }, [active]);
  useEffect(() => {
    if (draft || !active) return;
    const trigger = editorTrigger.current;
    if (trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus();
    editorTrigger.current = null;
  }, [draft, active]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);

  const perform = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    if (busyRef.current.has(key)) return false;
    busyRef.current.add(key); setBusy([...busyRef.current]); setLocalError(null);
    try { await action(); return true; }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : t('scripts.error')); return false; }
    finally { busyRef.current.delete(key); setBusy([...busyRef.current]); }
  };
  const pending = (id: string) => busy.includes(id) || pendingIds.some((key) => key === id || key.endsWith(`:${id}`));
  const saving = busy.includes('save');
  const selectPanel = (target: PanelTarget) => {
    setLocalError(null);
    if (target.kind === 'close') { setDraft(null); return; }
    if (target.kind === 'output') {
      editorTrigger.current = null;
      setDraft(null);
      void perform(`output:${target.id}`, () => useScriptsStore.getState().openOutput(target.id));
      return;
    }
    useScriptsStore.getState().closeOutput();
    const script = target.script;
    const input: ScriptInput = script ? inputFrom(script) : { name: '', description: '', code: '',
      runtime: selectableRuntimes.find((item) => item.id === 'powershell')?.id ?? selectableRuntimes[0]?.id ?? 'powershell',
      workingDirectory: '', confirmationRequired: false, timeoutSeconds: 3600 };
    setLocalError(null); setDraft({ input, original: { ...input }, id: script?.id, revision: script?.revision });
  };
  const requestPanel = (target: PanelTarget) => {
    if (saving) return;
    if (target.kind === 'editor' && draft && target.script?.id === draft.id) return;
    if (dirty) { setDiscard(target); return; }
    if (target.kind === 'editor') editorTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectPanel(target);
  };
  const closeEditor = () => requestPanel({ kind: 'close' });
  const openEditor = (script?: SavedScript) => requestPanel({ kind: 'editor', script });
  const update = <K extends keyof ScriptInput>(key: K, value: ScriptInput[K]) => {
    setDraft((current) => current ? { ...current, input: { ...current.input, [key]: value } } : current);
  };
  const save = async () => {
    if (!draft || saving) return;
    const input = draft.input;
    if (!input.name.trim() || !input.code.trim() || !selectableRuntimes.some((item) => item.id === input.runtime)
      || !Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > maxTimeout) {
      setLocalError(t('scripts.validation')); return;
    }
    if (await perform('save', () => useScriptsStore.getState().save({ ...input, name: input.name.trim() }, draft.id, draft.revision))) {
      setDraft(null); setDiscard(null);
    }
  };
  const start = (script: SavedScript, confirmed = false) => perform(script.id, () => useScriptsStore.getState().run(script, confirmed));
  const cancel = async (run: ScriptRun) => {
    if (stopping.includes(run.id)) return;
    setStopping((ids) => [...ids, run.id]);
    if (!await perform(run.id, () => useScriptsStore.getState().cancel(run.id))) setStopping((ids) => ids.filter((id) => id !== run.id));
  };
  const openOutput = (id: string) => requestPanel({ kind: 'output', id });
  const date = (value: number | null) => value === null ? t('scripts.unavailable') : new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium', timeStyle: 'long',
  }).format(new Date(value));
  const duration = (run: ScriptRun) => run.startedAt === null ? t('scripts.unavailable') : run.completedAt === null
    ? t('scripts.inProgress') : t('scripts.seconds', { count: Math.max(0, Math.round((run.completedAt - run.startedAt) / 1000)) });
  const status = (run?: ScriptRun) => <span className="scripts-status" data-status={run?.status}>{run ? t(`scripts.status.${run.status}`) : t('scripts.never')}</span>;
  const stopButton = (run: ScriptRun) => isActiveRun(run) && <button type="button" className="ui-button scripts-button scripts-danger"
    disabled={pending(run.id) || stopping.includes(run.id)} onClick={() => void cancel(run)}><Square />
    {pending(run.id) || stopping.includes(run.id) ? t('scripts.stopping') : t('scripts.stop')}</button>;
  const errorMessage = localError || error;
  const errorBlock = errorMessage && <div role="alert" className="scripts-error">{errorMessage}
    <button type="button" className="ui-button scripts-button" onClick={() => { setLocalError(null); useScriptsStore.getState().clearError(); }}>{t('scripts.dismissError')}</button>
  </div>;
  const query = search.trim().toLocaleLowerCase();
  const sortedRuns = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const pageScripts = browserPreview && !scripts.length && view === 'all' ? [browserDemoScript] : scripts;
  const visibleScripts = pageScripts.filter((script) => `${script.name} ${script.description} ${script.runtime}`.toLocaleLowerCase().includes(query));
  const visibleRuns = sortedRuns.filter((run) => (view !== 'running' || isActiveRun(run)) && `${run.scriptName} ${run.runtime}`.toLocaleLowerCase().includes(query));
  const outputData = output?.run.id === selectedRunId ? output : null;
  const currentRun = runs.find((run) => run.id === selectedRunId) ?? outputData?.run;
  const hasDetail = !!draft || !!confirmation || !!selectedRunId;
  if (!active) return null;

  const listPanel = <section className="scripts-page" aria-label={t('scripts.title')}>
    <div className="scripts-main" inert={!!discard || !!confirmation}>
      <div className="scripts-toolbar" role="toolbar" aria-label={t('scripts.title')}>
        <button type="button" className="ui-button scripts-button" disabled={loading} onClick={() => openEditor()}><Plus />{t('scripts.newScript')}</button>
        <label className="scripts-search"><Search /><input className="ui-input" type="search" value={search}
          aria-label={t('scripts.search')} placeholder={t('scripts.search')} onChange={(event) => setSearch(event.target.value)} /></label>
        <button type="button" className="ui-icon-button scripts-button" aria-label={t('scripts.refresh')} disabled={loading || busy.includes('refresh')}
          onClick={() => void perform('refresh', () => useScriptsStore.getState().refresh())}><RefreshCw /></button>
      </div>
      {executionBlocked && <p className="scripts-error" role="alert">{executionBlocked}</p>}
      {!hasDetail && errorBlock}
      <div className="scripts-list" aria-busy={loading}>
        {loading && <p role="status">{t('scripts.loading')}</p>}
        {!loading && !(view === 'all' ? visibleScripts : visibleRuns).length && <div className="scripts-empty">
          <p>{t(query ? 'scripts.noResults' : view === 'all' ? 'scripts.empty' : view === 'running' ? 'scripts.noRunning' : 'scripts.noRuns')}</p>
          {query && <button type="button" className="ui-button scripts-button" onClick={() => setSearch('')}>{t('scripts.clearSearch')}</button>}
        </div>}
        {view === 'all' ? visibleScripts.map((script) => {
          if (script.id === browserDemoScript.id) return <article className="scripts-row" key={script.id} aria-label={script.name}>
            <div className="scripts-row-info"><span className="scripts-name">{script.name}</span><p className="scripts-description">{script.description}</p>
              <small>{t('scripts.previewOnly')} · {script.runtime}</small></div>
            {status()}<div className="scripts-row-actions"><button type="button" className="ui-button scripts-button scripts-primary" disabled title={t('scripts.previewOnly')}><Play />{t('scripts.run')}</button></div>
          </article>;
          const latest = sortedRuns.find((run) => run.scriptId === script.id);
          const running = sortedRuns.find((run) => run.scriptId === script.id && isActiveRun(run));
          const unavailable = !runtimes.some((item) => item.id === script.runtime);
          return <article className="scripts-row" key={script.id} aria-label={script.name} data-selected={draft?.id === script.id}>
            <div className="scripts-row-info">
              <button type="button" className="scripts-name" onClick={() => openEditor(script)} title={script.name}>{script.name}</button>
              {script.description && <p className="scripts-description" title={script.description}>{script.description}</p>}
              <small>{t('scripts.local')} · {script.runtime}{script.confirmationRequired ? ` · ${t('scripts.confirmation')}` : ''}</small>
            </div>
            <div className="scripts-row-meta">{latest ? <><time dateTime={new Date(latest.startedAt ?? latest.createdAt).toISOString()}>{date(latest.startedAt ?? latest.createdAt)}</time><small>{duration(latest)}</small></> : t('scripts.never')}</div>
            {status(running ?? latest)}
            <div className="scripts-row-actions">
              {running ? <button type="button" className="ui-button scripts-button" aria-label={t('scripts.outputNamed', { name: script.name })} onClick={() => openOutput(running.id)}>{t('scripts.output')}</button>
                : <button type="button" className="ui-button scripts-button scripts-primary" aria-label={t('scripts.runNamed', { name: script.name })}
                  disabled={pending(script.id) || !!executionBlocked || unavailable || runs.filter(isActiveRun).length >= maxConcurrent}
                  title={unavailable ? t('scripts.runtimeUnavailable') : undefined}
                  onClick={() => { if (script.confirmationRequired) setConfirmation({ kind: 'run', script }); else void start(script); }}><Play />{pending(script.id) ? t('scripts.pending') : t('scripts.run')}</button>}
              <ScriptActions script={script} disabled={pending(script.id)} onEdit={() => openEditor(script)}
                onDuplicate={() => void perform(script.id, () => useScriptsStore.getState().duplicate(script.id))}
                onDelete={() => setConfirmation({ kind: 'delete', script })} />
            </div>
          </article>;
        }) : visibleRuns.map((run) => <article key={run.id} className="scripts-row" aria-label={run.scriptName} data-selected={selectedRunId === run.id}>
          <div className="scripts-row-info"><button type="button" className="scripts-name" onClick={() => openOutput(run.id)} title={run.scriptName}>{run.scriptName}</button>
            <small>{run.runtime} · {duration(run)}</small></div>
          <div className="scripts-row-meta"><time dateTime={new Date(run.startedAt ?? run.createdAt).toISOString()}>{date(run.startedAt ?? run.createdAt)}</time></div>
          {status(run)}<div className="scripts-row-actions"><button type="button" className="ui-button scripts-button" aria-label={t('scripts.outputNamed', { name: run.scriptName })} onClick={() => openOutput(run.id)}>{t('scripts.output')}</button>{stopButton(run)}</div>
        </article>)}
      </div>
    </div>
  </section>;

  return <PrimaryWorkspaceContent mode="scripts" contextPanelAvailable contextPanelOpen
    contextPanelWidthVw={contextPanelWidth} contextPanelId="scripts-list-panel" contextPanel={listPanel}
    centerPanel={<section className="scripts-page" aria-label={t('scripts.title')}>
    {draft && !discard && !confirmation && <ScriptsPanel key={draft.id ?? 'new'} title={t(draft.id ? 'scripts.edit' : 'scripts.newScript')} onClose={closeEditor}>
      <form className="scripts-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="scripts-panel-body">
          {errorBlock}
          <fieldset disabled={saving}>
            <label className="ui-field">{t('scripts.name')}<input data-initial-focus className="ui-input" required value={draft.input.name} onChange={(event) => update('name', event.target.value)} /></label>
            <label className="ui-field">{t('scripts.description')}<input className="ui-input" value={draft.input.description} onChange={(event) => update('description', event.target.value)} /></label>
            <label className="ui-field">{t('scripts.code')}<textarea className="ui-input scripts-code" required spellCheck={false} rows={10} value={draft.input.code} onChange={(event) => update('code', event.target.value)} /></label>
            <label className="ui-field">{t('scripts.runtime')}<select className="ui-input" value={selectableRuntimes.some((item) => item.id === draft.input.runtime) ? draft.input.runtime : ''}
              onChange={(event) => { const runtime = selectableRuntimes.find((item) => item.id === event.target.value); if (runtime) update('runtime', runtime.id); }}>
              {!selectableRuntimes.some((item) => item.id === draft.input.runtime) && <option value="" disabled>{t('scripts.unavailable')}</option>}
              {selectableRuntimes.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.label}</option>)}
            </select></label>
            {!selectableRuntimes.some((item) => item.id === draft.input.runtime) && <p className="scripts-warning">{t(runtimes.length ? 'scripts.runtimeUnavailable' : 'scripts.noRuntimes')}</p>}
            <label className="scripts-check"><input type="checkbox" checked={draft.input.confirmationRequired} onChange={(event) => update('confirmationRequired', event.target.checked)} />{t('scripts.confirmation')}</label>
            <details className="scripts-advanced"><summary>{t('scripts.advanced')}</summary>
              <label className="ui-field">{t('scripts.workingDirectory')}<input className="ui-input" value={draft.input.workingDirectory} onChange={(event) => update('workingDirectory', event.target.value)} /></label>
              <small>{t('scripts.defaultDirectory', { path: defaultDirectory })}</small>
              <label className="ui-field">{t('scripts.timeout')}<input className="ui-input" type="number" min={1} max={maxTimeout} step={1} required value={Number.isNaN(draft.input.timeoutSeconds) ? '' : draft.input.timeoutSeconds}
                onChange={(event) => update('timeoutSeconds', event.target.valueAsNumber)} /></label>
            </details>
          </fieldset>
          <p className="scripts-warning">{t('scripts.trust')}</p><p>{t('scripts.lifecycle')}</p>
          <small>{t('scripts.limits', { count: maxConcurrent, bytes: maxLogBytes })}</small>
        </div>
        <footer className="scripts-panel-footer"><button type="button" className="ui-button scripts-button" disabled={saving} onClick={closeEditor}>{t('scripts.cancel')}</button>
          <button type="submit" className="ui-button scripts-button scripts-primary" disabled={saving || !runtimes.length || !!executionBlocked}>{t(saving ? 'scripts.saving' : 'scripts.save')}</button></footer>
      </form>
    </ScriptsPanel>}

    {draft && discard && <ScriptsPanel key="discard" dialog title={t('scripts.discardTitle')} onClose={() => setDiscard(null)}>
      <div className="scripts-panel-body"><p>{t('scripts.discardMessage')}</p></div>
      <footer className="scripts-panel-footer"><button data-initial-focus type="button" className="ui-button scripts-button" onClick={() => setDiscard(null)}>{t('scripts.keepEditing')}</button>
        <button type="button" className="ui-button scripts-button scripts-danger" onClick={() => { setDiscard(null); selectPanel(discard); }}>{t('scripts.discard')}</button></footer>
    </ScriptsPanel>}

    {confirmation && <ScriptsPanel key="confirmation" dialog title={t(confirmation.kind === 'run' ? 'scripts.confirmRun' : 'scripts.confirmDelete', { name: confirmation.script.name })}
      onClose={() => { if (!pending(confirmation.script.id)) setConfirmation(null); }}>
      <div className="scripts-panel-body">{errorBlock}{confirmation.kind === 'run' && <p className="scripts-warning">{t('scripts.trust')}</p>}</div>
      <footer className="scripts-panel-footer"><button type="button" className="ui-button scripts-button" disabled={pending(confirmation.script.id)} onClick={() => setConfirmation(null)}>{t('scripts.cancel')}</button>
        <button type="button" className={`ui-button scripts-button ${confirmation.kind === 'run' ? 'scripts-primary' : 'scripts-danger'}`}
          disabled={pending(confirmation.script.id)} onClick={() => {
            const request = confirmation.kind === 'run' ? start(confirmation.script, true) : perform(confirmation.script.id, () => useScriptsStore.getState().remove(confirmation.script));
            void request.then((ok) => { if (ok) setConfirmation(null); });
          }}>{t(pending(confirmation.script.id) ? 'scripts.pending' : confirmation.kind === 'run' ? 'scripts.run' : 'scripts.delete')}</button>
      </footer>
    </ScriptsPanel>}

    {selectedRunId && !draft && !confirmation && <ScriptsPanel key={selectedRunId} title={currentRun ? `${t('scripts.output')} — ${currentRun.scriptName}` : t('scripts.output')}
      onClose={() => useScriptsStore.getState().closeOutput()}>
      <div className="scripts-panel-body scripts-output">
        {errorBlock}
        {outputLoading && <p role="status">{t('scripts.loading')}</p>}
        {currentRun && <><div className="scripts-output-status">{status(currentRun)}{stopButton(currentRun)}</div>
          <dl><dt>{t('scripts.started')}</dt><dd>{date(currentRun.startedAt)}</dd><dt>{t('scripts.duration')}</dt><dd>{duration(currentRun)}</dd>
            <dt>{t('scripts.exitCode')}</dt><dd>{currentRun.exitCode ?? t('scripts.unavailable')}</dd>
            <dt>{t('scripts.runId')}</dt><dd>{currentRun.id}</dd><dt>{t('scripts.revision')}</dt><dd>{currentRun.scriptRevision}</dd>
            <dt>{t('scripts.workingDirectory')}</dt><dd>{currentRun.workingDirectory}</dd><dt>{t('scripts.sourceHash')}</dt><dd>{currentRun.sourceHash}</dd></dl>
          {currentRun.error && <p className="scripts-error">{currentRun.error}</p>}</>}
        {outputData && <>
          {(outputData.truncated || currentRun?.logTruncated) && <p className="scripts-warning" role="status">{t('scripts.truncated')}</p>}
          <h3>{t('scripts.stdout')}</h3><pre aria-label={t('scripts.stdout')}>{outputData.stdout || t('scripts.noOutput')}</pre>
          <h3>{t('scripts.stderr')}</h3><pre className="scripts-stderr" aria-label={t('scripts.stderr')}>{outputData.stderr || t('scripts.noOutput')}</pre>
          <details><summary>{t('scripts.snapshot')}</summary><pre aria-label={t('scripts.snapshot')}>{outputData.snapshot.code}</pre></details>
        </>}
        {!outputData && !outputLoading && <button type="button" className="ui-button scripts-button" onClick={() => openOutput(selectedRunId)}>{t('scripts.retry')}</button>}
      </div>
    </ScriptsPanel>}
  </section>} />;
}
